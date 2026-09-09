// ════════════════════════════════════════════════════════════════════════
// Standalone-mode backup export.
//
// exportSnapshot() is the only thing standing between a library and a lost
// device, and it is the one operation nobody notices is wrong until they
// try to restore. It used to read the whole thing row by row — a query per
// category, tag, ingredient, tool and technique, then per recipe another
// four, plus one per ingredient row for its translations and one more for
// its unit — which on a real library is several hundred sequential reads,
// each a Capacitor bridge round-trip.
//
// Rewriting that into batched reads means the grouping is now done in JS,
// so what these tests actually guard is that every child row still ends up
// attached to the right parent and in the right order. The query-count test
// is the reason the rewrite happened; the rest is why it is safe.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
let queryCount = 0;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) {
            db.exec(sql);
            return;
          }
          db.exec('BEGIN');
          try {
            db.exec(sql);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        },
        query: async (sql: string, params: unknown[] = []) => {
          queryCount++;
          return { values: db.prepare(sql).all(...(params as never[])) };
        },
        run: async (sql: string, params: unknown[] = []) => {
          queryCount++;
          db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected in this test — one connection, created once');
      },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  queryCount = 0;
  vi.resetModules();
});

/** createRecipe() does not await its entity-file sync (see
 *  syncRecipeInBackground in recipes.local.ts), so let those queries land
 *  before counting. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
}

/** A library with something of everything, and deliberately more than one
 *  of each parent — a grouping bug that attaches every child to the first
 *  parent passes a single-parent fixture. */
async function seed(recipeCount = 1) {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  for (const [id, name, order] of [['cat-veg', 'Vegetables', 1], ['cat-herbs', 'Herbs', 0]] as const) {
    await query('INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
      [id, name, order, '#4a7', 'TbCarrot']);
    await query('INSERT INTO ingredient_category_translations (id, category_id, language_code, name) VALUES ($1,$2,$3,$4)',
      [`ct-${id}`, id, 'it', name === 'Vegetables' ? 'Verdure' : 'Erbe']);
  }

  await query("INSERT INTO tags (id, name, group_name, sort_order, exclude_tag_ids) VALUES ('tag-veg','Vegetarian','diet',0,'[]')");
  await query("INSERT INTO tags (id, name, group_name, sort_order, exclude_tag_ids) VALUES ('tag-quick','Quick','time',1,'[]')");
  await query("INSERT INTO tag_translations (id, tag_id, language_code, name) VALUES ('tt-1','tag-veg','it','Vegetariano')");

  await query("INSERT INTO tools (id, name, icon, image_urls) VALUES ('tool-pan','Pan','TbTool','[]')");
  await query("INSERT INTO tool_translations (id, tool_id, language_code, name) VALUES ('tlt-1','tool-pan','it','Padella')");
  await query("INSERT INTO techniques (id, name, icon, image_urls) VALUES ('tec-boil','Boiling','TbDroplet','[]')");
  await query("INSERT INTO technique_translations (id, technique_id, language_code, name) VALUES ('tct-1','tec-boil','it','Bollitura')");

  for (const [id, name, cat] of [['ing-tomato', 'Tomato', 'cat-veg'], ['ing-basil', 'Basil', 'cat-herbs']] as const) {
    await query(`INSERT INTO ingredients (id, category_id, name, image_urls, sync_status, seasonal_months)
                 VALUES ($1,$2,$3,'[]','local','[]')`, [id, cat, name]);
    await query('INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ($1,$2,$3,$4)',
      [`itr-${id}`, id, 'it', name === 'Tomato' ? 'Pomodoro' : 'Basilico']);
  }
  await query("INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ('ing-tomato','tag-veg')");
  await query("INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ('ing-tomato','tag-quick')");

  for (let n = 0; n < recipeCount; n++) {
    await createRecipe({
      id: `1111111${n}-2222-4333-8444-55555555555${n}`,
      title: `Recipe ${n}`,
      servings: 4,
      toolIds: ['tool-pan'],
      ingredients: [
        // Deliberately inserted out of order, so a grouped read that loses
        // the ORDER BY shows up here.
        { sortOrder: 1, ingredientId: 'ing-basil', quantity: 10, unitId, notes: 'torn', translations: [{ lang: 'it', notes: 'spezzato' }] },
        { sortOrder: 0, ingredientId: 'ing-tomato', quantity: 400, unitId, isOptional: true },
      ],
      steps: [
        { stepNumber: 2, description: 'Season.', toolIds: [], techniqueIds: ['tec-boil'] },
        { stepNumber: 1, description: 'Boil.', toolIds: ['tool-pan'], translations: [{ lang: 'it', description: 'Bollire.' }] },
      ],
      translations: [{ lang: 'it', title: `Ricetta ${n}` }],
    } as never, 'Matteo');
  }
}

describe('standalone backup export', () => {
  it('attaches every child row to the right parent', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    const { exportSnapshot } = await import('./backup.local');

    const snap = await exportSnapshot();

    const veg = snap.categories!.find((c) => c.id === 'cat-veg')!;
    const herbs = snap.categories!.find((c) => c.id === 'cat-herbs')!;
    expect(veg.translations).toEqual([{ lang: 'it', name: 'Verdure', description: null }]);
    expect(herbs.translations).toEqual([{ lang: 'it', name: 'Erbe', description: null }]);

    // Only one of the two tags is translated: the untranslated one must come
    // back with an empty list, not the other's.
    expect(snap.tags!.find((t) => t.id === 'tag-veg')!.translations).toEqual([{ lang: 'it', name: 'Vegetariano' }]);
    expect(snap.tags!.find((t) => t.id === 'tag-quick')!.translations).toEqual([]);

    const tomato = snap.ingredients!.find((i) => i.id === 'ing-tomato')!;
    const basil = snap.ingredients!.find((i) => i.id === 'ing-basil')!;
    expect(tomato.tagIds!.sort()).toEqual(['tag-quick', 'tag-veg']);
    expect(basil.tagIds).toEqual([]);
    expect(tomato.translations).toEqual([{ lang: 'it', text: 'Pomodoro' }]);
    expect(basil.translations).toEqual([{ lang: 'it', text: 'Basilico' }]);

    expect(snap.tools![0].translations).toEqual([{ lang: 'it', name: 'Padella', description: null }]);
    expect(snap.techniques![0].translations).toEqual([{ lang: 'it', name: 'Bollitura', description: null }]);
  });

  it('keeps recipe children in order and resolves the unit symbol', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    const { exportSnapshot } = await import('./backup.local');

    const recipe = (await exportSnapshot()).recipes![0];

    expect(recipe.ingredients!.map((i) => i.ingredientId)).toEqual(['ing-tomato', 'ing-basil']);
    expect(recipe.ingredients!.map((i) => i.unitSymbol)).toEqual(['g', 'g']);
    expect(recipe.ingredients![0].isOptional).toBe(true);
    // The translated note belongs to the basil row, not the tomato one.
    expect(recipe.ingredients![0].translations).toEqual([]);
    expect(recipe.ingredients![1].translations).toEqual([{ lang: 'it', notes: 'spezzato' }]);

    expect(recipe.steps!.map((s) => s.description)).toEqual(['Boil.', 'Season.']);
    expect(recipe.steps![0].translations).toEqual([{ lang: 'it', title: null, description: 'Bollire.' }]);
    expect(recipe.steps![1].translations).toEqual([]);
    expect(recipe.steps![1].techniqueIds).toEqual(['tec-boil']);

    expect(recipe.toolIds).toEqual(['tool-pan']);
    expect(recipe.translations).toEqual([{ lang: 'it', title: 'Ricetta 0', description: null }]);
  });

  it('does not issue more queries as the library grows', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed(1);
    const { exportSnapshot } = await import('./backup.local');
    await settle();

    queryCount = 0;
    const small = await exportSnapshot().then(() => queryCount);

    db = new DatabaseSync(':memory:');
    vi.resetModules();
    await (await import('../db/local')).initLocalSchema();
    await seed(12);
    const bigModule = await import('./backup.local');
    await settle();

    queryCount = 0;
    const large = await bigModule.exportSnapshot().then(() => queryCount);

    // Nineteen reads either way: six parent tables and thirteen child ones.
    // Before batching, twelve recipes alone cost more than sixty.
    expect(large).toBe(small);
    expect(small).toBeLessThanOrEqual(20);
  });
});
