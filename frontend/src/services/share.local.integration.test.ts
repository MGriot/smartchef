// ════════════════════════════════════════════════════════════════════════
// Standalone-mode recipe export.
//
// /api/share/recipes/:id/export had no entry in localRouter.ts's dispatch
// list, so in standalone mode it fell through to an HTTP request to a
// server that isn't there — and RecipeDetail.tsx's handler only
// console.errors, so "Export recipe" on the Windows app did nothing at all,
// silently. This exercises the ported path (share.local.ts) end to end
// through the router, against real SQLite via node:sqlite, so the SQL and
// the JSON-column decoding are both actually run rather than mocked.
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
        query: async (sql: string, params: unknown[] = []) => {
          const stmt = db.prepare(sql);
          return { values: stmt.all(...(params as never[])) };
        },
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

// createRecipe() stamps the active profile's name onto the row; standalone
// profile lookup isn't what's under test here.
vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

/** A main recipe that uses a sub-recipe, so the bundle's dependency
 *  closure (child before parent) is exercised too. */
async function seedRecipes() {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  // initLocalSchema() seeds a default category/unit catalogue, so reuse
  // what's there (unit symbols are UNIQUE) rather than inserting duplicates.
  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  await query('INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)', ['cat-1', 'Test Category']);
  await query(
    `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
     VALUES ($1, $2, $3, $4, 'local')`,
    ['ing-tomato', 'cat-1', 'Tomato', '["/img/tomato.jpg"]']
  );
  await query(
    'INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ($1, $2, $3, $4)',
    ['itr-1', 'ing-tomato', 'it', 'Pomodoro']
  );
  await query('INSERT INTO tools (id, name, category, image_urls) VALUES ($1, $2, $3, $4)', ['tool-tm6', 'TM6', 'appliance', '[]']);

  const sub = await createRecipe({
    id: 'recipe-sauce',
    title: 'Salsa di pomodoro',
    servings: 4,
    isComponent: true,
    ingredients: [{ sortOrder: 0, ingredientId: 'ing-tomato', quantity: 400, unitId, isOptional: false }],
    steps: [{ stepNumber: 1, description: 'Cuocere i pomodori.', durationMin: 20, toolIds: [] }],
  } as never, 'Matteo');

  const main = await createRecipe({
    id: 'recipe-main',
    title: 'Pasta al pomodoro',
    servings: 4,
    tags: ['Vegano', 'Veloce'],
    prepTimeMin: 10,
    ingredients: [
      { sortOrder: 0, subRecipeId: 'recipe-sauce', quantity: 1, isOptional: false },
      { sortOrder: 1, ingredientId: 'ing-tomato', quantity: 200, unitId, isOptional: true },
    ],
    steps: [{ stepNumber: 1, description: 'Condire la pasta.', toolIds: ['tool-tm6'] }],
    toolIds: ['tool-tm6'],
  } as never, 'Matteo');

  return { subId: sub.id, mainId: main.id };
}

describe('standalone share export', () => {
  it('is routed locally instead of falling through to a server', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const res = await dispatchLocal(`/api/share/recipes/${mainId}/export`);

    // null here would mean "not my prefix" — i.e. the original bug, where
    // the request escaped to the network.
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
  });

  it('bundles the recipe with the ingredients and tools it depends on', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const bundle = (await dispatchLocal(`/api/share/recipes/${mainId}/export`))?.data as any;

    expect(bundle.formatVersion).toBe(1);
    expect(typeof bundle.exportedAt).toBe('string');

    // Child before parent, so an import can replay them in order.
    expect(bundle.recipes.map((r: any) => r.id)).toEqual(['recipe-sauce', 'recipe-main']);
    expect(bundle.ingredients.map((i: any) => i.id)).toEqual(['ing-tomato']);
    expect(bundle.tools.map((t: any) => t.id)).toEqual(['tool-tm6']);
  });

  it('decodes the JSON-encoded columns SQLite stores as TEXT', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const bundle = (await dispatchLocal(`/api/share/recipes/${mainId}/export`))?.data as any;
    const main = bundle.recipes.find((r: any) => r.id === 'recipe-main');

    // Real arrays, not the raw '["Vegano","Veloce"]' strings — the server
    // bundle has arrays here and the import side's schema expects them.
    expect(main.tags).toEqual(['Vegano', 'Veloce']);
    expect(Array.isArray(main.sources)).toBe(true);
    expect(main.steps[0].toolIds).toEqual(['tool-tm6']);
    expect(bundle.ingredients[0].imageUrls).toEqual(['/img/tomato.jpg']);
  });

  it('converts SQLite 0/1 columns back into real booleans', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const bundle = (await dispatchLocal(`/api/share/recipes/${mainId}/export`))?.data as any;
    const main = bundle.recipes.find((r: any) => r.id === 'recipe-main');
    const sauce = bundle.recipes.find((r: any) => r.id === 'recipe-sauce');

    expect(sauce.isComponent).toBe(true);
    expect(main.isComponent).toBe(false);
    expect(main.ingredients.find((i: any) => i.ingredientId === 'ing-tomato').isOptional).toBe(true);
  });

  it('carries unit symbols and translations through', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const bundle = (await dispatchLocal(`/api/share/recipes/${mainId}/export`))?.data as any;
    const main = bundle.recipes.find((r: any) => r.id === 'recipe-main');

    expect(main.ingredients.find((i: any) => i.ingredientId === 'ing-tomato').unitSymbol).toBe('g');
    expect(bundle.ingredients[0].translations).toEqual([{ lang: 'it', name: 'Pomodoro' }]);
  });

  it('404s for a recipe that does not exist', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const res = await dispatchLocal('/api/share/recipes/nope/export');
    expect(res?.status).toBe(404);
  });

  it('still reports the unported parts as unavailable rather than reaching the network', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    // Collection export has no local table to read; it must be claimed and
    // refused, not silently escape to a server that isn't there.
    const res = await dispatchLocal('/api/share/collections/abc/export');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(501);
  });

  it('exports several recipes at once, de-duplicating shared dependencies', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId, subId } = await seedRecipes();

    const { dispatchLocal } = await import('./localRouter');
    const res = await dispatchLocal('/api/share/recipes/export-bulk', {
      method: 'POST',
      body: JSON.stringify({ recipeIds: [mainId, subId] }),
    });
    const bundle = res?.data as any;

    // recipe-sauce is both a root and a dependency of recipe-main — it must
    // appear exactly once.
    expect(bundle.recipes.map((r: any) => r.id)).toEqual(['recipe-sauce', 'recipe-main']);
    expect(bundle.ingredients).toHaveLength(1);
  });
});
