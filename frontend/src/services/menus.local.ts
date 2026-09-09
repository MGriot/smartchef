// ════════════════════════════════════════════════════════════════════════
// SmartChef — Weekly menus (the Planner), standalone mode
//
// Port of backend/src/routes/menus.ts and the menu half of
// backend/src/services/nutrition.service.ts onto the local SQLite store.
// Same response shapes as the server, so pages/Planner.tsx can't tell the
// difference — including the detail row's camelCase `items` array, which
// the server builds with json_agg and is rebuilt here by hand.
//
// Same bug as shopping.local.ts fixes: /api/menus had no entry in
// localRouter.ts, so in standalone mode every Planner call fell through to
// an HTTP request to a server that isn't there, and Planner.tsx's handlers
// only console.error — "New Menu" appeared to do nothing at all. That also
// made the Shopping List page's "From a Menu" half permanently empty, since
// there was no way to create a menu in the first place.
//
// Local-only, outside the sync snapshot: a week's plan is personal and
// short-lived, unlike the library content Folder Sync carries.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import { calculatePortions } from './matrioska.local';

export interface MenuItem {
  id: string;
  recipeId: string;
  recipe_title: string | null;
  dayOfWeek: number;
  mealType: string;
  servings: number;
  notes: string | null;
}

export interface MenuDetail extends Record<string, unknown> {
  id: string;
  name: string;
  week_start: string;
  notes: string | null;
  items: MenuItem[];
}

function newId(): string {
  return crypto.randomUUID();
}

/** Summaries for the Planner's menu switcher — snake_case with an
 *  item_count, matching GET /api/menus. */
export async function listMenus(): Promise<Array<Record<string, unknown>>> {
  return query(
    `SELECT m.*, COUNT(mi.id) AS item_count
       FROM menus m
       LEFT JOIN menu_items mi ON mi.menu_id = m.id
      GROUP BY m.id
      ORDER BY m.week_start DESC`,
  );
}

export async function getMenu(id: string): Promise<MenuDetail | null> {
  const menu = await queryOne<{
    id: string; name: string; week_start: string; notes: string | null;
    created_at: string; updated_at: string;
  }>('SELECT * FROM menus WHERE id=$1', [id]);
  if (!menu) return null;

  const items = await query<{
    id: string; recipe_id: string; recipe_title: string | null;
    day_of_week: number; meal_type: string; servings: number; notes: string | null;
  }>(
    `SELECT mi.id, mi.recipe_id, r.title AS recipe_title, mi.day_of_week,
            mi.meal_type, mi.servings, mi.notes
       FROM menu_items mi
       LEFT JOIN recipes r ON r.id = mi.recipe_id
      WHERE mi.menu_id = $1
      ORDER BY mi.day_of_week, mi.meal_type`,
    [id],
  );

  return {
    ...menu,
    items: items.map((i) => ({
      id: i.id,
      recipeId: i.recipe_id,
      recipe_title: i.recipe_title,
      dayOfWeek: i.day_of_week,
      mealType: i.meal_type,
      servings: i.servings,
      notes: i.notes,
    })),
  };
}

export async function createMenu(input: { name: string; weekStart: string; notes?: string | null }): Promise<{ id: string; name: string; weekStart: string }> {
  const id = newId();
  await query('INSERT INTO menus (id, name, week_start, notes) VALUES ($1,$2,$3,$4)', [
    id, input.name, input.weekStart, input.notes ?? null,
  ]);
  return { id, name: input.name, weekStart: input.weekStart };
}

export async function addMenuItem(menuId: string, input: {
  recipeId: string; dayOfWeek: number; mealType?: string; servings?: number; notes?: string | null;
}): Promise<{ id: string } | null> {
  const menu = await queryOne<{ id: string }>('SELECT id FROM menus WHERE id=$1', [menuId]);
  if (!menu) return null;
  const id = newId();
  await query(
    `INSERT INTO menu_items (id, menu_id, recipe_id, day_of_week, meal_type, servings, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, menuId, input.recipeId, input.dayOfWeek, input.mealType ?? 'dinner', input.servings ?? 4, input.notes ?? null],
  );
  await query("UPDATE menus SET updated_at=CURRENT_TIMESTAMP WHERE id=$1", [menuId]);
  return { id };
}

/** Move a planned recipe to another day/meal — the drag-and-drop write.
 *  COALESCE-style partial update so a drag that only changes the day does
 *  not clobber the servings someone set. */
export async function updateMenuItem(menuId: string, itemId: string, input: {
  dayOfWeek?: number; mealType?: string; servings?: number;
}): Promise<boolean> {
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM menu_items WHERE id=$1 AND menu_id=$2', [itemId, menuId],
  );
  if (!existing) return false;
  await query(
    `UPDATE menu_items
        SET day_of_week = COALESCE($1, day_of_week),
            meal_type   = COALESCE($2, meal_type),
            servings    = COALESCE($3, servings)
      WHERE id=$4 AND menu_id=$5`,
    [input.dayOfWeek ?? null, input.mealType ?? null, input.servings ?? null, itemId, menuId],
  );
  await query("UPDATE menus SET updated_at=CURRENT_TIMESTAMP WHERE id=$1", [menuId]);
  return true;
}

export async function removeMenuItem(menuId: string, itemId: string): Promise<void> {
  await query('DELETE FROM menu_items WHERE id=$1 AND menu_id=$2', [itemId, menuId]);
  await query("UPDATE menus SET updated_at=CURRENT_TIMESTAMP WHERE id=$1", [menuId]);
}

export async function deleteMenu(id: string): Promise<void> {
  await query('DELETE FROM menu_items WHERE menu_id=$1', [id]);
  await query('DELETE FROM menus WHERE id=$1', [id]);
}

/** Every recipe planned in a menu, in the shape generateShoppingList()
 *  wants — this is what makes the Shopping List page's "From a Menu" half
 *  work offline. */
export async function menuRecipesForShopping(menuId: string): Promise<Array<{ recipeId: string; servings: number }>> {
  const rows = await query<{ recipe_id: string; servings: number }>(
    'SELECT recipe_id, servings FROM menu_items WHERE menu_id=$1 ORDER BY day_of_week, meal_type',
    [menuId],
  );
  return rows.map((r) => ({ recipeId: r.recipe_id, servings: r.servings }));
}

// ── Nutrition ───────────────────────────────────────────────────────────

export interface NutritionTotals {
  caloriesKcal: number; proteinG: number; carbsG: number; fatG: number;
  fiberG: number; sugarG: number; sodiumMg: number;
}

const ZERO = (): NutritionTotals => ({
  caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0,
});

const round1 = (n: number) => Math.round(n * 10) / 10;

interface IngredientNutritionRow {
  id: string;
  calories_kcal: number | null; protein_g: number | null; carbs_g: number | null;
  fat_g: number | null; fiber_g: number | null; sugar_g: number | null; sodium_mg: number | null;
}

async function recipeNutrition(recipeId: string, servings: number): Promise<{ totals: NutritionTotals; unresolved: string[] }> {
  const portions = await calculatePortions(recipeId, servings);
  const resolved = portions.resolvedIngredients;
  const totals = ZERO();
  const unresolved: string[] = [];

  const ingredientIds = [...new Set(resolved.map((r) => r.ingredientId).filter(Boolean))];
  const unitIds = [...new Set(resolved.map((r) => r.unitId).filter(Boolean))];

  const ingRows = ingredientIds.length
    ? await query<IngredientNutritionRow>(
        `SELECT id, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg
           FROM ingredients WHERE id IN (${ingredientIds.map((_, i) => `$${i + 1}`).join(',')})`,
        ingredientIds,
      )
    : [];
  const unitRows = unitIds.length
    ? await query<{ id: string; unit_type: string; to_base_factor: number | null }>(
        `SELECT id, unit_type, to_base_factor FROM units WHERE id IN (${unitIds.map((_, i) => `$${i + 1}`).join(',')})`,
        unitIds,
      )
    : [];

  const ingredientById = new Map(ingRows.map((r) => [r.id, r]));
  const unitById = new Map(unitRows.map((r) => [r.id, r]));

  for (const item of resolved) {
    const ing = ingredientById.get(item.ingredientId);
    const unit = item.unitId ? unitById.get(item.unitId) : undefined;

    // Weight units only. The server also converts volume via the
    // ingredient's density_g_per_ml, but the local ingredients table has no
    // such column — so a volume line counts as unresolved here rather than
    // being silently guessed at, which is what `unresolved` is for.
    const grams = unit?.unit_type === 'weight' && unit.to_base_factor != null
      ? item.quantity * unit.to_base_factor
      : null;

    const hasData = ing && (
      ing.calories_kcal != null || ing.protein_g != null || ing.carbs_g != null ||
      ing.fat_g != null || ing.fiber_g != null || ing.sugar_g != null || ing.sodium_mg != null
    );

    if (grams == null || grams === 0 || !hasData) {
      unresolved.push(item.ingredientName);
      continue;
    }

    const factor = grams / 100;
    totals.caloriesKcal += (ing!.calories_kcal ?? 0) * factor;
    totals.proteinG += (ing!.protein_g ?? 0) * factor;
    totals.carbsG += (ing!.carbs_g ?? 0) * factor;
    totals.fatG += (ing!.fat_g ?? 0) * factor;
    totals.fiberG += (ing!.fiber_g ?? 0) * factor;
    totals.sugarG += (ing!.sugar_g ?? 0) * factor;
    totals.sodiumMg += (ing!.sodium_mg ?? 0) * factor;
  }

  return { totals, unresolved };
}

export async function menuNutrition(menuId: string): Promise<{
  menuId: string;
  byDay: Record<number, NutritionTotals>;
  weekly: NutritionTotals;
  unresolved: string[];
}> {
  const items = await query<{ recipe_id: string; day_of_week: number; servings: number }>(
    'SELECT recipe_id, day_of_week, servings FROM menu_items WHERE menu_id=$1',
    [menuId],
  );

  const byDay: Record<number, NutritionTotals> = {};
  const weekly = ZERO();
  const unresolved = new Set<string>();

  for (const item of items) {
    const result = await recipeNutrition(item.recipe_id, item.servings);
    result.unresolved.forEach((u) => unresolved.add(u));
    if (!byDay[item.day_of_week]) byDay[item.day_of_week] = ZERO();
    for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
      byDay[item.day_of_week][key] += result.totals[key];
      weekly[key] += result.totals[key];
    }
  }

  for (const day of Object.keys(byDay)) {
    for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
      byDay[Number(day)][key] = round1(byDay[Number(day)][key]);
    }
  }
  for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
    weekly[key] = round1(weekly[key]);
  }

  return { menuId, byDay, weekly, unresolved: [...unresolved] };
}
