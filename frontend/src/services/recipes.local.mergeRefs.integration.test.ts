// ════════════════════════════════════════════════════════════════════════
// Merging two recipes with the steps from one and the ingredients from the
// other. Real SQLite via node:sqlite.
//
// A step points at an ingredient by position ({{ing:N}}). One recipe made from
// raw ingredients, the other from a bought one, name different things at the
// same position: keeping the token would silently say "pasta sfoglia" where
// the step meant "farina". The references have to become the words they read
// as, so the step still tells its own recipe, and the user is left with a
// mismatch the AI check can raise, instead of a wrong ingredient.
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

async function seed(keptIngredient: string) {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  await query(`INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ('cat', 'Cat', 0, '#000', 'x')`);
  for (const [id, name] of [['i-sfoglia', 'Pasta sfoglia'], ['i-farina', 'Farina']]) {
    await query(`INSERT INTO ingredients (id, category_id, name, image_urls, sync_status) VALUES ($1, 'cat', $2, '[]', 'local')`, [id, name]);
  }
  await query(
    `INSERT INTO recipes (id, title, updated_at) VALUES
       ('keep', 'Tartellette', '2026-01-01 00:00:00'), ('dup', 'Tartellette (2)', '2026-02-01 00:00:00')`
  );
  // keep: ready-made pastry (or flour, in the control case)
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id) VALUES ('k0', 'keep', 0, $1)`, [keptIngredient]);
  // dup: flour, and steps written against it
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id) VALUES ('d0', 'dup', 0, 'i-farina')`);
  await query(
    `INSERT INTO recipe_steps (id, recipe_id, step_number, description, step_ingredients) VALUES
       ('ks1', 'keep', 1, 'Stendete {{ing:0}}.', $1),
       ('ds1', 'dup', 1, 'Impastate {{ing:0}} con il burro.', $2)`,
    [
      JSON.stringify([{ ingredientSortOrder: 0, amountMode: 'fraction', portion: 1 }]),
      JSON.stringify([{ ingredientSortOrder: 0, amountMode: 'fraction', portion: 1 }]),
    ],
  );
  return query;
}

describe('merge with steps from one recipe and ingredients from the other', () => {
  it('turns references into words when the two lists name different things', async () => {
    const query = await seed('i-sfoglia');
    const { mergeRecipes } = await import('./recipes.local');
    await mergeRecipes('dup', 'keep', { steps: 'source', ingredients: 'target' });

    const steps = await query<{ description: string; step_ingredients: string }>(
      `SELECT description, step_ingredients FROM recipe_steps WHERE recipe_id = 'keep' ORDER BY step_number`
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].description).toBe('Impastate Farina con il burro.');
    expect(steps[0].step_ingredients).toBe('[]');
    const ingredients = await query<{ ingredient_id: string }>(`SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = 'keep'`);
    expect(ingredients).toEqual([{ ingredient_id: 'i-sfoglia' }]);
  });

  it('keeps the references when both lists name the same thing at each position', async () => {
    const query = await seed('i-farina');
    const { mergeRecipes } = await import('./recipes.local');
    await mergeRecipes('dup', 'keep', { steps: 'source', ingredients: 'target' });

    const steps = await query<{ description: string }>(`SELECT description FROM recipe_steps WHERE recipe_id = 'keep'`);
    expect(steps[0].description).toBe('Impastate {{ing:0}} con il burro.');
  });
});
