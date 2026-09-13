// ════════════════════════════════════════════════════════════════════════
// Two standalone-mode behaviours that only show up against a real
// database, and were both wrong in ways a mock would have hidden:
//
// 1. An ingredient row marked as a SUBSTITUTE for another one ("or 100 g
//    of margarine") is an alternative, not a further thing the recipe
//    needs. It has to survive the round-trip through recipe_ingredients,
//    and it has to be invisible to everything built on the matrioska
//    engine — the shopping list, the nutrition totals, the pantry matcher
//    — or the list buys both halves of an either/or and the pantry refuses
//    a recipe over an ingredient the cook was offered a way around.
//
// 2. The pantry reads two names nothing else on its page does (the
//    ingredient and its category), and never asked for a language, so a
//    library browsed in Italian listed "Butter" under "Dairy & Eggs".
//
// Runs against real SQLite via node:sqlite — same harness as
// pantry.local.integration.test.ts — so the columns, joins and the
// addColumnIfMissing() backfill are genuinely executed.
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
        query: async (sql: string, params: unknown[] = []) => ({
          values: db.prepare(sql).all(...(params as never[])),
        }),
        run: async (sql: string, params: unknown[] = []) => {
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

/** getRecipe() refuses anything that isn't UUID-shaped (it is what tells a
 *  recipe id from a route verb like "filter-by-pantry"), so this one is a
 *  real UUID rather than the readable ids the catalog rows use. */
const RECIPE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

/** Butter, with margarine standing in for it, plus flour so the recipe has
 *  something ordinary to count as well. */
async function seed() {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  await query(
    'INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
    ['cat-dairy', 'Dairy & Eggs', 1, '#e8a', 'TbMilk'],
  );
  await query(
    'INSERT INTO ingredient_category_translations (id, category_id, language_code, name) VALUES ($1,$2,$3,$4)',
    ['cat-dairy-it', 'cat-dairy', 'it', 'Latticini e uova'],
  );
  for (const [id, name] of [['ing-butter', 'Butter'], ['ing-margarine', 'Margarine'], ['ing-flour', 'Flour']]) {
    await query(
      `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
       VALUES ($1, 'cat-dairy', $2, '[]', 'local')`,
      [id, name],
    );
  }
  await query(
    'INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ($1,$2,$3,$4)',
    ['tr-butter-it', 'ing-butter', 'it', 'Burro'],
  );

  await createRecipe({
    id: RECIPE_ID,
    title: 'Pasta frolla',
    servings: 4,
    ingredients: [
      { sortOrder: 0, ingredientId: 'ing-flour', quantity: 250, unitId, isOptional: false },
      { sortOrder: 1, ingredientId: 'ing-butter', quantity: 100, unitId, isOptional: false },
      // The alternative to the butter above — never a third thing to buy.
      { sortOrder: 2, ingredientId: 'ing-margarine', quantity: 100, unitId, isOptional: false, substituteFor: 1 },
    ],
    steps: [{ stepNumber: 1, description: 'Impastare.', toolIds: [] }],
  } as never, 'Matteo');

  return { unitId };
}

/** createRecipe() does not await its entity-file sync — let it drain. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
}

describe('ingredient substitutes', () => {
  it('round-trips substituteFor through the recipe', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    await settle();

    const { getRecipe } = await import('./recipes.local');
    const recipe = await getRecipe(RECIPE_ID) as unknown as {
      ingredients: Array<{ ingredientName: string; substituteFor: number | null }>;
    };
    const byName = new Map(recipe.ingredients.map((i) => [i.ingredientName, i.substituteFor]));
    expect(byName.get('Flour')).toBeNull();
    expect(byName.get('Butter')).toBeNull();
    expect(byName.get('Margarine')).toBe(1);
  });

  it('keeps the substitute off the shopping list', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    await settle();

    const { generateShoppingList } = await import('./shopping.local');
    const list = await generateShoppingList([{ recipeId: RECIPE_ID, servings: 4 }], 'Spesa');
    const names = list.items.map((i) => i.ingredientName).sort();
    expect(names).toEqual(['Butter', 'Flour']);
  });

  it('does not make the pantry demand both halves of an either/or', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    await settle();

    const { filterByPantry } = await import('./pantry.local');
    // Flour and butter in the cupboard, no margarine — that is the whole
    // recipe. Counted as a third ingredient the margarine would drag this
    // down to two of three and hide the recipe at 100%.
    const cookable = await filterByPantry(
      [{ ingredientId: 'ing-flour' }, { ingredientId: 'ing-butter' }],
      1,
    );
    expect(cookable.map((r) => r.recipeId)).toEqual([RECIPE_ID]);
    expect(cookable[0].required).toBe(2);
    expect(cookable[0].matchRatio).toBe(1);
  });
});

describe('pantry language', () => {
  it('names what is in the cupboard in the reader’s language', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    await settle();

    const { putPantryItem, listPantry } = await import('./pantry.local');
    await putPantryItem({ ingredientId: 'ing-butter', quantity: 250 });

    const english = await listPantry();
    expect(english[0].ingredient_name).toBe('Butter');
    expect(english[0].category_name).toBe('Dairy & Eggs');

    const italian = await listPantry('it');
    expect(italian[0].ingredient_name).toBe('Burro');
    expect(italian[0].category_name).toBe('Latticini e uova');
  });

  it('names a missing ingredient in the same language as the recipe it is missing from', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    await settle();

    const { query } = await import('../db/local');
    await query(
      'INSERT INTO recipe_translations (id, recipe_id, language_code, title) VALUES ($1,$2,$3,$4)',
      ['rt-it', RECIPE_ID, 'it', 'Pasta frolla (IT)'],
    );

    const { filterByPantry } = await import('./pantry.local');
    const [match] = await filterByPantry([{ ingredientId: 'ing-flour' }], 0, 'it');
    expect(match.title).toBe('Pasta frolla (IT)');
    // Butter is the one thing missing, and it used to come back "Butter"
    // next to an Italian recipe title.
    expect(match.missing.map((m) => m.name)).toEqual(['Burro']);
  });
});
