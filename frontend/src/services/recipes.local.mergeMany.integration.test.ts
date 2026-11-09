// ════════════════════════════════════════════════════════════════════════
// Merging several recipes into one, keeping the ingredients and steps of
// the copies (not replacing the kept recipe's lists). Real SQLite via
// node:sqlite.
//
// Rows move over after the kept ones, so a step's {{ing:N}} and its
// step_ingredients have to be renumbered; one that points at an ingredient
// that did not come along has to become the word it read as.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string) => { db.exec(sql); },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected in this test');
      },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

const ref = (n: number) => JSON.stringify([{ ingredientSortOrder: n, amountMode: 'fraction', portion: 1 }]);

async function seed() {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  await query(`INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ('cat', 'Cat', 0, '#000', 'x')`);
  for (const [id, name] of [['i-sfoglia', 'Pasta sfoglia'], ['i-farina', 'Farina'], ['i-burro', 'Burro'], ['i-uova', 'Uova']]) {
    await query(`INSERT INTO ingredients (id, category_id, name, image_urls, sync_status) VALUES ($1, 'cat', $2, '[]', 'local')`, [id, name]);
  }
  await query(
    `INSERT INTO recipes (id, title, updated_at) VALUES
       ('keep', 'Tartellette', '2026-01-01 00:00:00'),
       ('dup', 'Tartellette (2)', '2026-02-01 00:00:00'),
       ('dup2', 'Tartellette (3)', '2026-03-01 00:00:00')`
  );
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id) VALUES
    ('k0', 'keep', 0, 'i-sfoglia'), ('d0', 'dup', 0, 'i-farina'), ('d1', 'dup', 1, 'i-burro'), ('e0', 'dup2', 0, 'i-uova')`);
  await query(
    `INSERT INTO recipe_steps (id, recipe_id, step_number, description, step_ingredients) VALUES
       ('ks1', 'keep', 1, 'Stendete {{ing:0}}.', $1),
       ('ds1', 'dup', 1, 'Impastate {{ing:0}} con il burro.', $2),
       ('ds2', 'dup', 2, 'Aggiungete {{ing:1}}.', $3),
       ('es1', 'dup2', 1, 'Sbattete {{ing:0}}.', $4)`,
    [ref(0), ref(0), ref(1), ref(0)],
  );
  return query;
}

describe('keep both ingredients and steps', () => {
  it('appends the copy\'s rows and renumbers the step references', async () => {
    const query = await seed();
    const { mergeRecipes } = await import('./recipes.local');
    await mergeRecipes('dup', 'keep', { ingredients: 'both', steps: 'both' });

    const ingredients = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM recipe_ingredients WHERE recipe_id = 'keep' ORDER BY sort_order`);
    expect(ingredients).toEqual([{ id: 'k0', sort_order: 0 }, { id: 'd0', sort_order: 1 }, { id: 'd1', sort_order: 2 }]);

    const steps = await query<{ id: string; step_number: number; description: string; step_ingredients: string }>(
      `SELECT id, step_number, description, step_ingredients FROM recipe_steps WHERE recipe_id = 'keep' ORDER BY step_number`);
    expect(steps.map((s) => [s.id, s.step_number, s.description])).toEqual([
      ['ks1', 1, 'Stendete {{ing:0}}.'],
      ['ds1', 2, 'Impastate {{ing:1}} con il burro.'],
      ['ds2', 3, 'Aggiungete {{ing:2}}.'],
    ]);
    expect(JSON.parse(steps[1].step_ingredients)[0].ingredientSortOrder).toBe(1);
    expect(JSON.parse(steps[2].step_ingredients)[0].ingredientSortOrder).toBe(2);

    const gone = await query<{ sync_status: string }>(`SELECT sync_status FROM recipes WHERE id = 'dup'`);
    expect(gone[0].sync_status).toBe('deleted');
  });

  it('turns references into words when only the steps are appended', async () => {
    const query = await seed();
    const { mergeRecipes } = await import('./recipes.local');
    await mergeRecipes('dup', 'keep', { steps: 'both' });

    const steps = await query<{ id: string; description: string; step_ingredients: string }>(
      `SELECT id, description, step_ingredients FROM recipe_steps WHERE recipe_id = 'keep' ORDER BY step_number`);
    expect(steps.map((s) => s.description)).toEqual(['Stendete {{ing:0}}.', 'Impastate Farina con il burro.', 'Aggiungete Burro.']);
    expect(steps[1].step_ingredients).toBe('[]');
  });
});

describe('merge several recipes with ticked rows', () => {
  it('carries over only the ticked ingredients and steps, from every copy', async () => {
    const query = await seed();
    const { mergeRecipesMany } = await import('./recipes.local');
    const result = await mergeRecipesMany('keep', [
      { sourceId: 'dup', picks: { ingredientIds: ['d1'], stepIds: ['ds1', 'ds2'] } },
      { sourceId: 'dup2', picks: { ingredientIds: ['e0'], stepIds: [] } },
    ]);
    expect(result).not.toBeNull();

    const ingredients = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM recipe_ingredients WHERE recipe_id = 'keep' ORDER BY sort_order`);
    expect(ingredients).toEqual([{ id: 'k0', sort_order: 0 }, { id: 'd1', sort_order: 1 }, { id: 'e0', sort_order: 2 }]);

    const steps = await query<{ id: string; description: string; step_ingredients: string }>(
      `SELECT id, description, step_ingredients FROM recipe_steps WHERE recipe_id = 'keep' ORDER BY step_number`);
    // ds1 named Farina, which was not ticked: it reads as the word now.
    // ds2 named Burro, which was: renumbered.
    expect(steps.map((s) => [s.id, s.description])).toEqual([
      ['ks1', 'Stendete {{ing:0}}.'],
      ['ds1', 'Impastate Farina con il burro.'],
      ['ds2', 'Aggiungete {{ing:1}}.'],
    ]);
    expect(steps[1].step_ingredients).toBe('[]');
    expect(JSON.parse(steps[2].step_ingredients)[0].ingredientSortOrder).toBe(1);

    const deleted = await query<{ id: string; sync_status: string }>(`SELECT id, sync_status FROM recipes WHERE id IN ('dup','dup2') ORDER BY id`);
    expect(deleted.every((r) => r.sync_status === 'deleted')).toBe(true);
  });

  it('touches nothing when a copy does not exist', async () => {
    const query = await seed();
    const { mergeRecipesMany } = await import('./recipes.local');
    await expect(mergeRecipesMany('keep', [
      { sourceId: 'dup', picks: { ingredientIds: ['d1'], stepIds: [] } },
      { sourceId: 'nope', picks: { ingredientIds: [], stepIds: [] } },
    ])).rejects.toThrow();
    const rows = await query(`SELECT id FROM recipe_ingredients WHERE recipe_id = 'keep'`);
    expect(rows).toHaveLength(1);
  });

  it('merges a repeated copy once and refuses merging into itself', async () => {
    await seed();
    const { mergeRecipesMany } = await import('./recipes.local');
    await expect(mergeRecipesMany('keep', [{ sourceId: 'keep' }])).rejects.toThrow();
    await expect(mergeRecipesMany('keep', [{ sourceId: 'dup' }, { sourceId: 'dup' }])).resolves.not.toBeNull();
  });
});
