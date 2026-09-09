// ════════════════════════════════════════════════════════════════════════
// Standalone-mode pantry: "what can I cook right now?"
//
// Two things are under test, and the second is why the file exists.
//
// 1. The answer itself, resolved through the matrioska engine — a dish
//    whose sauce is a separate recipe must be judged on the sauce's
//    ingredients too, which is the thing no competitor's pantry does.
//
// 2. The cost of the answer. filterByPantry() originally resolved each
//    recipe on its own, so it issued a query per recipe per sub-recipe
//    node. In standalone mode every one of those crosses the Capacitor
//    bridge, which is exactly the pattern
//    docs/plans/2026-08-22-android-performance-plan.md exists to keep out.
//    The guard below is per-recipe cost, not a magic number: seed more
//    recipes, and the query count must not move.
//
// Runs against real SQLite via node:sqlite so the SQL, the joins and the
// sub-recipe scaling are genuinely executed rather than mocked.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
/** Bumped by the mock below on every read that reaches SQLite. */
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
          const stmt = db.prepare(sql);
          return { values: stmt.all(...(params as never[])) };
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

/** Pasta al pomodoro is built on a sauce that is itself a recipe, so its
 *  tomato requirement only exists if the engine descends into the sauce. */
async function seed() {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  await query('INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
    ['cat-veg', 'Vegetables', 1, '#4a7', 'TbCarrot']);
  for (const [id, name] of [['ing-tomato', 'Tomato'], ['ing-basil', 'Basil'], ['ing-garlic', 'Garlic']]) {
    await query(
      `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
       VALUES ($1, 'cat-veg', $2, '[]', 'local')`,
      [id, name],
    );
  }

  await createRecipe({
    id: 'recipe-sauce',
    title: 'Salsa di pomodoro',
    servings: 4,
    isComponent: true,
    ingredients: [{ sortOrder: 0, ingredientId: 'ing-tomato', quantity: 400, unitId, isOptional: false }],
    steps: [{ stepNumber: 1, description: 'Cuocere i pomodori.', toolIds: [] }],
  } as never, 'Matteo');

  await createRecipe({
    id: 'recipe-main',
    title: 'Pasta al pomodoro',
    servings: 4,
    ingredients: [
      // Unitless sub-recipe quantity = servings of that sub-recipe: 2 of the
      // sauce's 4 servings is half its 400g of tomato.
      { sortOrder: 0, subRecipeId: 'recipe-sauce', quantity: 2, isOptional: false },
      { sortOrder: 1, ingredientId: 'ing-basil', quantity: 10, unitId, isOptional: true },
    ],
    steps: [{ stepNumber: 1, description: 'Condire la pasta.', toolIds: [] }],
  } as never, 'Matteo');

  await createRecipe({
    id: 'recipe-bruschetta',
    title: 'Bruschetta',
    servings: 4,
    ingredients: [
      { sortOrder: 0, ingredientId: 'ing-tomato', quantity: 100, unitId, isOptional: false },
      { sortOrder: 1, ingredientId: 'ing-garlic', quantity: 5, unitId, isOptional: false },
    ],
    steps: [{ stepNumber: 1, description: 'Tostare il pane.', toolIds: [] }],
  } as never, 'Matteo');

  return { unitId };
}

/** createRecipe() deliberately does not await its entity-file sync (see
 *  syncRecipeInBackground in recipes.local.ts, which exists to stop a slow
 *  sync from freezing the editor). Those queries land after the seed call
 *  returns, so let them drain before counting anything. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
}

/** Extra standalone recipes, to prove the cost per recipe is flat. */
async function seedMore(unitId: string, count: number) {
  const { createRecipe } = await import('./recipes.local');
  for (let i = 0; i < count; i++) {
    await createRecipe({
      id: `recipe-filler-${i}`,
      title: `Filler ${i}`,
      servings: 4,
      ingredients: [{ sortOrder: 0, ingredientId: 'ing-garlic', quantity: 5, unitId, isOptional: false }],
      steps: [{ stepNumber: 1, description: 'Cuocere.', toolIds: [] }],
    } as never, 'Matteo');
  }
}

describe('standalone pantry', () => {
  it('routes /api/pantry locally instead of falling through to a server', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');
    expect(await dispatchLocal('/api/pantry')).not.toBeNull();
    expect(await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({ ingredients: [] }),
    })).not.toBeNull();
  });

  it('counts a sub-recipe’s ingredients against the pantry', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { unitId } = await seed();
    const { filterByPantry } = await import('./pantry.local');

    // Enough tomato for the bruschetta's 100g, not for the pasta's sauce,
    // which needs 200g. Without matrioska resolution the pasta has no
    // tomato requirement at all and would come back cookable.
    const cookable = await filterByPantry([
      { ingredientId: 'ing-tomato', quantity: 150, unit: 'g' },
      { ingredientId: 'ing-garlic' },
    ]);

    expect(cookable.map((r) => r.title)).toEqual(['Bruschetta']);
    expect(unitId).toBeTruthy();
  });

  it('ignores optional ingredients and treats a quantity-less entry as enough', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    const { filterByPantry } = await import('./pantry.local');

    // No basil at all, and no amount given for the tomato. Basil is
    // optional in the pasta, so it must not count against it.
    const cookable = await filterByPantry([
      { ingredientId: 'ing-tomato' },
      { ingredientId: 'ing-garlic' },
    ]);

    expect(cookable.map((r) => r.title).sort()).toEqual(['Bruschetta', 'Pasta al pomodoro']);
    expect(cookable.every((r) => r.matchRatio === 1)).toBe(true);
  });

  it('reports how close a near miss is, and what is short', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    const { filterByPantry } = await import('./pantry.local');

    const [bruschetta] = await filterByPantry(
      [{ ingredientId: 'ing-tomato' }],
      0.5,
    ).then((rows) => rows.filter((r) => r.title === 'Bruschetta'));

    expect(bruschetta.have).toBe(1);
    expect(bruschetta.required).toBe(2);
    expect(bruschetta.missing.map((m) => m.name)).toEqual(['Garlic']);
  });

  it('does not issue more queries as the library grows', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { unitId } = await seed();
    const { filterByPantry } = await import('./pantry.local');
    const stock = [{ ingredientId: 'ing-tomato' }, { ingredientId: 'ing-garlic' }];

    await settle();
    queryCount = 0;
    await filterByPantry(stock);
    const withThree = queryCount;

    await seedMore(unitId, 10);
    await settle();

    queryCount = 0;
    await filterByPantry(stock);
    const withThirteen = queryCount;

    // The whole point: four reads — the units catalogue, the recipe list and
    // the two preload queries — and not a per-recipe walk. Ten more recipes
    // cost nothing. Before the preload this grew by a query per recipe plus
    // one per sub-recipe node.
    expect(withThree).toBe(4);
    expect(withThirteen).toBe(withThree);
  });
});
