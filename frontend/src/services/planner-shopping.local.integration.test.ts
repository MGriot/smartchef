// ════════════════════════════════════════════════════════════════════════
// Standalone-mode Planner + Shopping List.
//
// Neither /api/menus nor /api/shopping had an entry in localRouter.ts, so
// in standalone mode both fell through to an HTTP request against a server
// that isn't configured — apiFetch throws "No server configured" for that,
// and Planner.tsx / ShoppingList.tsx only console.error'd it. "New Menu"
// and "Generate List" were dead buttons with no visible error: the same
// failure as the share/export bug (share.local.integration.test.ts),
// repeated twice.
//
// Runs the ported services end to end through the router, against real
// SQLite via node:sqlite, so the SQL, the JSON columns and the matrioska
// sub-recipe resolution are all genuinely executed rather than mocked.
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

/** A main recipe built on a sub-recipe, plus a second recipe sharing one of
 *  the same ingredients — so aggregation across recipes and matrioska
 *  resolution through a sub-recipe are both exercised. */
async function seed() {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  // initLocalSchema() seeds a default unit catalogue; symbols are UNIQUE, so
  // reuse what's there rather than inserting a duplicate gram.
  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  // Two aisles whose sort_order deliberately contradicts their alphabetical
  // order, so a list grouped by aisle is distinguishable from one that just
  // happens to be sorted by name.
  await query('INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
    ['cat-veg', 'Vegetables', 1, '#4a7', 'TbCarrot']);
  await query('INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
    ['cat-herbs', 'Herbs', 0, '#2a5', 'TbLeaf']);
  await query(
    `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
     VALUES ($1, $2, $3, '[]', 'local')`,
    ['ing-tomato', 'cat-veg', 'Tomato'],
  );
  await query(
    `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
     VALUES ($1, $2, $3, '[]', 'local')`,
    ['ing-basil', 'cat-herbs', 'Basil'],
  );

  const sub = await createRecipe({
    id: 'recipe-sauce',
    title: 'Salsa di pomodoro',
    servings: 4,
    isComponent: true,
    ingredients: [{ sortOrder: 0, ingredientId: 'ing-tomato', quantity: 400, unitId, isOptional: false }],
    steps: [{ stepNumber: 1, description: 'Cuocere i pomodori.', toolIds: [] }],
  } as never, 'Matteo');

  const main = await createRecipe({
    id: 'recipe-main',
    title: 'Pasta al pomodoro',
    servings: 4,
    ingredients: [
      // No unit on a sub-recipe reference means the quantity is SERVINGS of
      // that sub-recipe (matrioska.local.ts): 2 servings of a 4-serving
      // sauce pulls in half its 400g of tomato.
      { sortOrder: 0, subRecipeId: 'recipe-sauce', quantity: 2, isOptional: false },
      { sortOrder: 1, ingredientId: 'ing-basil', quantity: 10, unitId, isOptional: false },
    ],
    steps: [{ stepNumber: 1, description: 'Condire la pasta.', toolIds: [] }],
  } as never, 'Matteo');

  const other = await createRecipe({
    id: 'recipe-bruschetta',
    title: 'Bruschetta',
    servings: 4,
    ingredients: [{ sortOrder: 0, ingredientId: 'ing-tomato', quantity: 100, unitId, isOptional: false }],
    steps: [{ stepNumber: 1, description: 'Tostare il pane.', toolIds: [] }],
  } as never, 'Matteo');

  return { subId: sub.id, mainId: main.id, otherId: other.id, unitId };
}

describe('standalone shopping lists', () => {
  it('routes /api/shopping locally instead of falling through to a server', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');

    // null would mean "not my prefix" — the original bug, where the request
    // escaped to the network and threw "No server configured".
    expect(await dispatchLocal('/api/shopping')).not.toBeNull();
  });

  it('aggregates the same ingredient across recipes, resolving sub-recipes', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId, otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({
        listName: 'Week 1',
        recipes: [
          { recipeId: mainId, servings: 4 },
          { recipeId: otherId, servings: 4 },
        ],
      }),
    });

    expect(res?.status).toBe(201);
    const list = res!.data as { name: string; items: Array<{ ingredientName?: string; totalQuantity?: number; sourceDetails: unknown[] }> };
    expect(list.name).toBe('Week 1');

    // Tomato reaches the list only through recipe-main's SUB-recipe (2 of
    // the sauce's 4 servings = 200g) plus bruschetta's own 100g. 100 would
    // mean the sub-recipe was skipped entirely; 500 would mean its batch was
    // pulled in whole without scaling.
    const tomato = list.items.find((i) => i.ingredientName === 'Tomato');
    expect(tomato?.totalQuantity).toBe(300);
    // One contribution per source recipe, which is what the by-recipe view
    // is rendered from.
    expect(tomato?.sourceDetails).toHaveLength(2);

    const basil = list.items.find((i) => i.ingredientName === 'Basil');
    expect(basil?.totalQuantity).toBe(10);
  });

  it('scales quantities by the requested servings', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ recipes: [{ recipeId: otherId, servings: 8 }] }),
    });

    // Written for 4 servings with 100g of tomato; 8 servings doubles it.
    const list = res!.data as { items: Array<{ ingredientName?: string; totalQuantity?: number }> };
    expect(list.items.find((i) => i.ingredientName === 'Tomato')?.totalQuantity).toBe(200);
  });

  it('persists the list so it reloads identically and can be checked off', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const created = (await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ recipes: [{ recipeId: otherId, servings: 4 }] }),
    }))!.data as { id: string; items: Array<{ id: string; isChecked: boolean }> };

    const itemId = created.items[0].id;
    const checked = await dispatchLocal(`/api/shopping/${created.id}/items/${itemId}/check`, {
      method: 'PATCH',
      body: JSON.stringify({ checked: true }),
    });
    expect(checked?.status).toBe(200);

    const reloaded = (await dispatchLocal(`/api/shopping/${created.id}`))!.data as {
      items: Array<{ id: string; isChecked: boolean }>;
    };
    // SQLite stores 0/1; the page reads a real boolean off isChecked.
    expect(reloaded.items.find((i) => i.id === itemId)?.isChecked).toBe(true);

    const summaries = (await dispatchLocal('/api/shopping'))!.data as Array<{ id: string; item_count: number }>;
    expect(summaries.find((s) => s.id === created.id)?.item_count).toBe(created.items.length);
  });

  it('reports a real error instead of an empty list when nothing is selected', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ recipes: [] }),
    });
    expect(res?.status).toBe(400);
    expect(res?.error).toBeTruthy();
  });
});

describe('standalone menus', () => {
  it('routes /api/menus locally instead of falling through to a server', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');
    expect(await dispatchLocal('/api/menus')).not.toBeNull();
  });

  it('creates a menu, plans recipes into it, and lists it back', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const created = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'Week 1', weekStart: '2026-09-07' }),
    }))!.data as { id: string };

    const added = await dispatchLocal(`/api/menus/${created.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ recipeId: mainId, dayOfWeek: 2, mealType: 'dinner', servings: 6 }),
    });
    expect(added?.status).toBe(201);

    const detail = (await dispatchLocal(`/api/menus/${created.id}`))!.data as {
      name: string;
      items: Array<{ recipeId: string; recipe_title: string; dayOfWeek: number; servings: number }>;
    };
    expect(detail.name).toBe('Week 1');
    expect(detail.items).toHaveLength(1);
    // camelCase item fields plus the joined recipe_title, matching the shape
    // the server's json_agg produces and Planner.tsx reads.
    expect(detail.items[0]).toMatchObject({ recipeId: mainId, recipe_title: 'Pasta al pomodoro', dayOfWeek: 2, servings: 6 });

    const summaries = (await dispatchLocal('/api/menus'))!.data as Array<{ id: string; item_count: number }>;
    expect(summaries.find((m) => m.id === created.id)?.item_count).toBe(1);
  });

  it('generates a shopping list from a saved menu', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId, otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const menu = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'Week 1', weekStart: '2026-09-07' }),
    }))!.data as { id: string };

    for (const recipeId of [mainId, otherId]) {
      await dispatchLocal(`/api/menus/${menu.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ recipeId, dayOfWeek: 1, servings: 4 }),
      });
    }

    const res = await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ menuId: menu.id, listName: 'From the menu' }),
    });

    expect(res?.status).toBe(201);
    const list = res!.data as { menuId?: string; items: Array<{ ingredientName?: string; totalQuantity?: number }> };
    // Same totals as picking the two recipes by hand, and the list keeps a
    // back-reference to the menu it came from.
    expect(list.menuId).toBe(menu.id);
    expect(list.items.find((i) => i.ingredientName === 'Tomato')?.totalQuantity).toBe(300);
  });

  it('refuses to generate from a menu with nothing planned in it', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');

    const menu = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'Empty', weekStart: '2026-09-07' }),
    }))!.data as { id: string };

    const res = await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ menuId: menu.id }),
    });
    expect(res?.status).toBe(400);
  });

  it('deletes a menu and its planned items', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const menu = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'Week 1', weekStart: '2026-09-07' }),
    }))!.data as { id: string };
    await dispatchLocal(`/api/menus/${menu.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ recipeId: mainId, dayOfWeek: 0, servings: 4 }),
    });

    expect((await dispatchLocal(`/api/menus/${menu.id}`, { method: 'DELETE' }))?.status).toBe(200);
    expect((await dispatchLocal(`/api/menus/${menu.id}`))?.status).toBe(404);

    const { query } = await import('../db/local');
    expect(await query('SELECT id FROM menu_items WHERE menu_id=$1', [menu.id])).toHaveLength(0);
  });
});

describe('standalone collections and cook history', () => {
  it('routes /api/collections and /api/cook-log locally', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');
    expect(await dispatchLocal('/api/collections')).not.toBeNull();
    expect(await dispatchLocal('/api/cook-log')).not.toBeNull();
  });

  it('creates a collection, adds recipes, and reads them back nested', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId, otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const created = (await dispatchLocal('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name: 'Weeknight', description: 'Fast ones' }),
    }))!.data as { id: string };

    for (const recipeId of [mainId, otherId]) {
      const added = await dispatchLocal(`/api/collections/${created.id}/recipes`, {
        method: 'POST',
        body: JSON.stringify({ recipeId }),
      });
      expect(added?.status).toBe(201);
    }

    // Re-adding is a no-op, not an error — the server relies on
    // ON CONFLICT DO NOTHING for the same thing.
    expect((await dispatchLocal(`/api/collections/${created.id}/recipes`, {
      method: 'POST',
      body: JSON.stringify({ recipeId: mainId }),
    }))?.status).toBe(201);

    const detail = (await dispatchLocal(`/api/collections/${created.id}`))!.data as {
      name: string; recipes: Array<{ id: string; title: string }>;
    };
    expect(detail.name).toBe('Weeknight');
    expect(detail.recipes).toHaveLength(2);

    const list = (await dispatchLocal('/api/collections'))!.data as Array<{ id: string; item_count: number }>;
    expect(list.find((c) => c.id === created.id)?.item_count).toBe(2);
  });

  it('removes a recipe and soft-deletes the collection', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const created = (await dispatchLocal('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ name: 'Temp' }),
    }))!.data as { id: string };
    await dispatchLocal(`/api/collections/${created.id}/recipes`, {
      method: 'POST',
      body: JSON.stringify({ recipeId: mainId }),
    });

    await dispatchLocal(`/api/collections/${created.id}/recipes/${mainId}`, { method: 'DELETE' });
    const afterRemove = (await dispatchLocal(`/api/collections/${created.id}`))!.data as { recipes: unknown[] };
    expect(afterRemove.recipes).toHaveLength(0);

    expect((await dispatchLocal(`/api/collections/${created.id}`, { method: 'DELETE' }))?.status).toBe(200);
    // Soft delete: gone from the API, row still present.
    expect((await dispatchLocal(`/api/collections/${created.id}`))?.status).toBe(404);
    const { query } = await import('../db/local');
    expect(await query('SELECT id FROM collections WHERE id=$1', [created.id])).toHaveLength(1);
  });

  it('reads back cook-log entries the offline write side recorded', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { query } = await import('../db/local');
    const { dispatchLocal } = await import('./localRouter');

    await query(
      'INSERT INTO cook_log (id, recipe_id, cooked_by_name, cooked_at) VALUES ($1,$2,$3,$4)',
      ['log-1', mainId, 'Matteo', '2026-09-08T18:30:00.000Z'],
    );

    const all = (await dispatchLocal('/api/cook-log'))!.data as Array<{ recipeTitle: string; cookedByName: string }>;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ recipeTitle: 'Pasta al pomodoro', cookedByName: 'Matteo' });

    // The calendar always asks for a month window, so the range filter is
    // the path that actually runs in the app.
    const inRange = (await dispatchLocal('/api/cook-log?from=2026-09-01&to=2026-09-30'))!.data as unknown[];
    expect(inRange).toHaveLength(1);
    const outOfRange = (await dispatchLocal('/api/cook-log?from=2026-10-01&to=2026-10-31'))!.data as unknown[];
    expect(outOfRange).toHaveLength(0);
  });
});

describe('shopping list aisle grouping', () => {
  it('carries the ingredient category onto every item', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const list = (await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ recipes: [{ recipeId: mainId, servings: 4 }] }),
    }))!.data as { items: Array<{ ingredientName?: string; categoryName?: string; categoryColor?: string; categorySortOrder?: number }> };

    const basil = list.items.find((i) => i.ingredientName === 'Basil');
    expect(basil?.categoryName).toBe('Herbs');
    expect(basil?.categoryColor).toBe('#2a5');
    expect(basil?.categorySortOrder).toBe(0);
  });

  it('orders items by aisle, not alphabetically', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId, otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const list = (await dispatchLocal('/api/shopping/generate', {
      method: 'POST',
      body: JSON.stringify({ recipes: [{ recipeId: mainId, servings: 4 }, { recipeId: otherId, servings: 4 }] }),
    }))!.data as { items: Array<{ ingredientName?: string }> };

    // Alphabetically Basil precedes Tomato anyway, so that proves nothing on
    // its own — what matters is that Herbs (sort_order 0) comes before
    // Vegetables (sort_order 1). Assert via groupByAisle, which is what the
    // screen renders.
    const { groupByAisle } = await import('./shopping.local');
    const groups = groupByAisle(list.items as never);
    expect(groups.map((g) => g.categoryName)).toEqual(['Herbs', 'Vegetables']);
  });

  // groupByAisle's uncategorised bucket is defensive rather than reachable
  // from the local store — ingredients.category_id is NOT NULL there, so an
  // ingredient always has a category. It can still arrive from the server
  // (a free-text item with no ingredient_id), so the ordering contract is
  // worth pinning; the pure function is the honest level to pin it at.
  it('sinks uncategorised items below every real aisle', async () => {
    const { groupByAisle } = await import('./shopping.local');
    const groups = groupByAisle([
      // "Aaa" would sort first alphabetically and its sort_order is absent,
      // which defaults to 0 — both of which must lose to a real aisle.
      { id: '1', shoppingListId: 'l', ingredientName: 'Aaa Mystery Powder', isChecked: false, sourceDetails: [] },
      { id: '2', shoppingListId: 'l', ingredientName: 'Tomato', isChecked: false, sourceDetails: [],
        categoryId: 'cat-veg', categoryName: 'Vegetables', categorySortOrder: 1 },
      { id: '3', shoppingListId: 'l', ingredientName: 'Basil', isChecked: false, sourceDetails: [],
        categoryId: 'cat-herbs', categoryName: 'Herbs', categorySortOrder: 0 },
    ], 'Other');

    expect(groups.map((g) => g.categoryName)).toEqual(['Herbs', 'Vegetables', 'Other']);
  });

  it('reorders the aisles through the router', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed();
    const { dispatchLocal } = await import('./localRouter');

    const before = ((await dispatchLocal('/api/ingredients/categories'))!.data as Array<{ id: string }>).map((c) => c.id);
    expect(before.indexOf('cat-herbs')).toBeLessThan(before.indexOf('cat-veg'));

    const res = await dispatchLocal('/api/ingredients/categories/reorder', {
      method: 'PUT',
      body: JSON.stringify({ ids: ['cat-veg', 'cat-herbs'] }),
    });
    expect(res?.status).toBe(200);

    // initLocalSchema() seeds a starter catalogue, so the list holds far more
    // than the two this test created — what matters is that the pair's
    // relative order flipped.
    const cats = (await dispatchLocal('/api/ingredients/categories'))!.data as Array<{ id: string }>;
    const ids = cats.map((c) => c.id);
    expect(ids.indexOf('cat-veg')).toBeLessThan(ids.indexOf('cat-herbs'));
  });
});

describe('moving a planned meal (drag and drop)', () => {
  it('moves an item to another day without losing its servings', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const menu = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'Week 1', weekStart: '2026-09-07' }),
    }))!.data as { id: string };
    const added = (await dispatchLocal(`/api/menus/${menu.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ recipeId: mainId, dayOfWeek: 1, mealType: 'lunch', servings: 6 }),
    }))!.data as { id: string };

    const moved = await dispatchLocal(`/api/menus/${menu.id}/items/${added.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ dayOfWeek: 4 }),
    });
    expect(moved?.status).toBe(200);

    const detail = (await dispatchLocal(`/api/menus/${menu.id}`))!.data as {
      items: Array<{ id: string; dayOfWeek: number; mealType: string; servings: number }>;
    };
    const item = detail.items.find((i) => i.id === added.id)!;
    // A drag changes the day only — the servings and meal someone chose
    // must survive it, which is why this is a partial update and not a
    // delete-and-recreate.
    expect(item.dayOfWeek).toBe(4);
    expect(item.servings).toBe(6);
    expect(item.mealType).toBe('lunch');
  });

  it('404s on an item that is not in that menu', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');
    const menu = (await dispatchLocal('/api/menus', {
      method: 'POST',
      body: JSON.stringify({ name: 'W', weekStart: '2026-09-07' }),
    }))!.data as { id: string };

    const res = await dispatchLocal(`/api/menus/${menu.id}/items/nope`, {
      method: 'PATCH',
      body: JSON.stringify({ dayOfWeek: 2 }),
    });
    expect(res?.status).toBe(404);
  });
});

describe('pantry matching', () => {
  /** Adds a pantry row through the router, the way the screen does. */
  const stock = async (
    dispatchLocal: (p: string, i?: RequestInit) => Promise<unknown>,
    ingredientId: string,
    quantity?: number,
    unitId?: string,
  ) => dispatchLocal('/api/pantry', {
    method: 'PUT',
    body: JSON.stringify({ ingredientId, quantity: quantity ?? null, unitId: unitId ?? null }),
  });

  it('routes /api/pantry locally', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { dispatchLocal } = await import('./localRouter');
    expect(await dispatchLocal('/api/pantry')).not.toBeNull();
  });

  it('upserts by ingredient rather than stacking duplicate rows', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { unitId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    await stock(dispatchLocal as never, 'ing-tomato', 500, unitId);
    await stock(dispatchLocal as never, 'ing-tomato', 900, unitId);

    const rows = (await dispatchLocal('/api/pantry'))!.data as Array<{ quantity: number }>;
    // Topping up edits the row; two "Tomato" lines would have to be summed
    // by the matcher, which is exactly what the UNIQUE constraint prevents.
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(900);
  });

  it('finds a recipe you can cook outright', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { otherId, unitId } = await seed();
    const { dispatchLocal } = await import('./localRouter');
    await stock(dispatchLocal as never, 'ing-tomato', 500, unitId);

    const res = await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({ ingredients: [{ ingredientId: 'ing-tomato', quantity: 500, unit: 'g' }] }),
    });
    expect(res?.status).toBe(200);

    // Bruschetta needs 100 g of tomato and nothing else.
    const cookable = res!.data as Array<{ recipeId: string; matchRatio: number }>;
    expect(cookable.map((c) => c.recipeId)).toContain(otherId);
    expect(cookable.find((c) => c.recipeId === otherId)!.matchRatio).toBe(1);
  });

  it('will not claim you can cook something you have too little of', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { otherId, unitId } = await seed();
    const { dispatchLocal } = await import('./localRouter');
    await stock(dispatchLocal as never, 'ing-tomato', 10, unitId);

    const cookable = (await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({ ingredients: [{ ingredientId: 'ing-tomato', quantity: 10, unit: 'g' }] }),
    }))!.data as Array<{ recipeId: string }>;
    expect(cookable.map((c) => c.recipeId)).not.toContain(otherId);
  });

  it('treats a quantity-less entry as "I have some"', async () => {
    // The frozen contract says an omitted quantity means "don't check
    // amounts" — being forced to weigh the bag is what stops anyone
    // keeping a pantry up to date.
    await (await import('../db/local')).initLocalSchema();
    const { otherId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    const cookable = (await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({ ingredients: [{ ingredientId: 'ing-tomato' }] }),
    }))!.data as Array<{ recipeId: string; matchRatio: number }>;
    expect(cookable.find((c) => c.recipeId === otherId)?.matchRatio).toBe(1);
  });

  it('reports near misses and names what is missing', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    // Pasta al pomodoro needs basil plus the sauce's tomatoes; hold only
    // the tomatoes.
    const cookable = (await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({
        ingredients: [{ ingredientId: 'ing-tomato' }],
        minMatchRatio: 0.4,
      }),
    }))!.data as Array<{ recipeId: string; matchRatio: number; missing: Array<{ name: string }> }>;

    const main = cookable.find((c) => c.recipeId === mainId)!;
    expect(main.matchRatio).toBeLessThan(1);
    expect(main.missing.map((m) => m.name)).toContain('Basil');
  });

  it('resolves sub-recipes, which is what nothing else can do', async () => {
    await (await import('../db/local')).initLocalSchema();
    const { mainId } = await seed();
    const { dispatchLocal } = await import('./localRouter');

    // The main recipe lists no tomato of its own — its tomatoes come from
    // the sauce it uses. Holding both basil and tomato must make it
    // cookable, which is only true if the sub-recipe was resolved.
    const cookable = (await dispatchLocal('/api/recipes/filter-by-pantry', {
      method: 'POST',
      body: JSON.stringify({
        ingredients: [{ ingredientId: 'ing-tomato' }, { ingredientId: 'ing-basil' }],
      }),
    }))!.data as Array<{ recipeId: string }>;
    expect(cookable.map((c) => c.recipeId)).toContain(mainId);
  });
});
