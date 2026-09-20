// ════════════════════════════════════════════════════════════════════════
// repairUnknownUnitRefs: rows pointing at a unit no device has.
//
// "Crema pasticcera" arrived on every device with unit_id
// 2152e3cc…, an old device's random seed id, and no unit_symbol, so its
// amounts showed with no unit. Its own steps carry no amounts, so the
// merge-time heal had nothing to borrow from — but ANOTHER recipe's step
// amounts still pair that id with "g". Real SQLite via node:sqlite.
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

const OLD_G = '2152e3cc861f7d77969a3d8f739f4e03';
const OLD_KG = '84dc14ef8f0ba215821b1fd6d31e12fc';

async function seed() {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  const g = (await query<{ id: string }>(`SELECT id FROM units WHERE symbol = 'g'`))[0].id;
  await query(`INSERT INTO recipes (id, title, updated_at) VALUES ('crema', 'Crema pasticcera', '2026-01-01 00:00:00')`);
  await query(`INSERT INTO recipes (id, title, updated_at) VALUES ('focaccia', 'Focaccia', '2026-01-01 00:00:00')`);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('c0', 'crema', 0, 500, $1)`, [OLD_G]);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('c1', 'crema', 1, 1, $1)`, [OLD_KG]);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('f0', 'focaccia', 0, 210, $1)`, [g]);
  // Only the focaccia's steps know what OLD_G means.
  await query(
    `INSERT INTO recipe_steps (id, recipe_id, step_number, description, step_ingredients) VALUES ('s1', 'focaccia', 1, 'Impasta', $1)`,
    [JSON.stringify([{ ingredientSortOrder: 0, quantity: 210, unitId: OLD_G, unitSymbol: 'g' }])]
  );
  return { query, g };
}

describe('repairUnknownUnitRefs', () => {
  it("resolves a recipe's unknown unit from another recipe's step amounts", async () => {
    const { query, g } = await seed();
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');

    expect(await repairUnknownUnitRefs()).toEqual({ fixed: 1, unresolved: 1 });

    const rows = await query<{ id: string; unit_id: string; symbol: string | null }>(
      `SELECT ri.id, ri.unit_id, u.symbol FROM recipe_ingredients ri LEFT JOIN units u ON u.id = ri.unit_id WHERE recipe_id = 'crema' ORDER BY sort_order`
    );
    expect(rows[0]).toMatchObject({ unit_id: g, symbol: 'g' });
    // Nothing anywhere names OLD_KG: left alone rather than guessed.
    expect(rows[1]).toMatchObject({ unit_id: OLD_KG, symbol: null });
  });

  it('bumps only the recipes it rewrote, so only their files are republished', async () => {
    const { query } = await seed();
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');
    await repairUnknownUnitRefs();

    const stamps = Object.fromEntries(
      (await query<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM recipes`)).map((r) => [r.id, r.updated_at])
    );
    expect(stamps.crema).not.toBe('2026-01-01 00:00:00');
    expect(stamps.focaccia).toBe('2026-01-01 00:00:00');
  });

  it('is a no-op on a healthy library', async () => {
    const { query } = await seed();
    await query(`DELETE FROM recipe_ingredients WHERE recipe_id = 'crema'`);
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');
    expect(await repairUnknownUnitRefs()).toEqual({ fixed: 0, unresolved: 0 });
  });
});

describe('repairCategories', () => {
  // The state one library was left in: the portable "Meat" (Italian name
  // "Carni") deleted while holding the meat, its Italian-seeded twin
  // "Carni" alive and empty.
  async function seedCategories() {
    const { query, initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await query(`DELETE FROM ingredient_categories`);
    await query(`INSERT INTO ingredient_categories (id, name, sort_order, deleted_at) VALUES ('cat-meat', 'Meat', 2, '2026-09-01 00:00:00')`);
    await query(`INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('cat-carni', 'Carni', 2)`);
    await query(`INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('cat-fruit', 'Fruit', 1)`);
    await query(`INSERT INTO ingredient_category_translations (id, category_id, language_code, name) VALUES ('t1', 'cat-meat', 'it', 'Carni'), ('t2', 'cat-fruit', 'it', 'Frutta')`);
    await query(`INSERT INTO ingredients (id, category_id, name) VALUES ('beef', 'cat-meat', 'Beef'), ('boar', 'cat-carni', 'Wild Boar'), ('apple', 'cat-fruit', 'Apple')`);
    return query;
  }

  it('folds the twin into the canonical category and brings the canonical one back', async () => {
    const query = await seedCategories();
    const { repairCategories } = await import('./syncReconcile.local');
    expect(await repairCategories()).toEqual({ moved: 1, restored: 1, folded: 1 });

    const live = await query<{ id: string }>(`SELECT id FROM ingredient_categories WHERE deleted_at IS NULL ORDER BY id`);
    expect(live.map((c) => c.id)).toEqual(['cat-fruit', 'cat-meat']);
    const cats = await query<{ id: string; category_id: string }>(`SELECT id, category_id FROM ingredients ORDER BY id`);
    expect(cats).toEqual([
      { id: 'apple', category_id: 'cat-fruit' },
      { id: 'beef', category_id: 'cat-meat' },
      { id: 'boar', category_id: 'cat-meat' },
    ]);
  });

  it('changes nothing the second time', async () => {
    await seedCategories();
    const { repairCategories } = await import('./syncReconcile.local');
    await repairCategories();
    expect(await repairCategories()).toEqual({ moved: 0, restored: 0, folded: 0 });
  });
});

describe('mergeIngredients', () => {
  it('moves pantry, shopping rows and missing translations to the kept ingredient', async () => {
    const { query, initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await query(`INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Other', 0)`);
    await query(`INSERT INTO ingredients (id, category_id, name) VALUES ('salt', 'c', 'Salt'), ('sale', 'c', 'Sale')`);
    await query(`INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ('t1', 'salt', 'it', 'Sale'), ('t2', 'sale', 'fr', 'Sel')`);
    await query(`INSERT INTO pantry_items (id, ingredient_id) VALUES ('p1', 'sale')`);
    await query(`INSERT INTO shopping_lists (id, name) VALUES ('l1', 'List')`);
    await query(`INSERT INTO shopping_list_items (id, shopping_list_id, ingredient_id) VALUES ('s1', 'l1', 'sale')`);

    const { mergeIngredients } = await import('./ingredients.local');
    await mergeIngredients('sale', 'salt');

    expect(await query(`SELECT ingredient_id FROM pantry_items`)).toEqual([{ ingredient_id: 'salt' }]);
    expect(await query(`SELECT ingredient_id FROM shopping_list_items`)).toEqual([{ ingredient_id: 'salt' }]);
    const trs = await query<{ language_code: string; translated_name: string }>(
      `SELECT language_code, translated_name FROM ingredient_translations WHERE ingredient_id = 'salt' ORDER BY language_code`
    );
    expect(trs).toEqual([{ language_code: 'fr', translated_name: 'Sel' }, { language_code: 'it', translated_name: 'Sale' }]);
  });
});

describe('mergeRecipes', () => {
  it('moves collections, meals, cooks and sub-recipe uses to the kept recipe', async () => {
    const { query, initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await query(`INSERT INTO recipes (id, title, times_cooked, rating, tags) VALUES ('keep', 'Crema', 2, NULL, '["dolci"]'), ('dup', 'Crema (2)', 3, 5, '["base"]'), ('tart', 'Crostata', 0, NULL, '[]')`);
    await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, sub_recipe_id) VALUES ('r1', 'tart', 0, 'dup')`);
    await query(`INSERT INTO collections (id, name) VALUES ('c1', 'Dolci')`);
    await query(`INSERT INTO collection_recipes (collection_id, recipe_id) VALUES ('c1', 'dup'), ('c1', 'keep')`);
    await query(`INSERT INTO menus (id, name, week_start) VALUES ('m1', 'Week', '2026-09-21')`);
    await query(`INSERT INTO menu_items (id, menu_id, recipe_id, day_of_week) VALUES ('mi1', 'm1', 'dup', 2)`);
    await query(`INSERT INTO cook_log (id, recipe_id) VALUES ('k1', 'dup')`);

    const { mergeRecipes } = await import('./recipes.local');
    await mergeRecipes('dup', 'keep');

    const keep = (await query<any>(`SELECT times_cooked, rating, tags FROM recipes WHERE id = 'keep'`))[0];
    expect(keep).toMatchObject({ times_cooked: 5, rating: 5 });
    expect(JSON.parse(keep.tags).sort()).toEqual(['base', 'dolci']);
    expect(await query(`SELECT sync_status FROM recipes WHERE id = 'dup'`)).toEqual([{ sync_status: 'deleted' }]);
    expect(await query(`SELECT sub_recipe_id FROM recipe_ingredients WHERE id = 'r1'`)).toEqual([{ sub_recipe_id: 'keep' }]);
    expect(await query(`SELECT recipe_id FROM collection_recipes`)).toEqual([{ recipe_id: 'keep' }]);
    expect(await query(`SELECT recipe_id FROM menu_items`)).toEqual([{ recipe_id: 'keep' }]);
    expect(await query(`SELECT recipe_id FROM cook_log`)).toEqual([{ recipe_id: 'keep' }]);
  });
});
