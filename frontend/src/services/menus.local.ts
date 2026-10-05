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
//
// Two kinds of menu share these tables (db/migrations/043_event_menus.sql):
// the weekly plan (kind 'week', items placed by day_of_week) and the event
// menu for one meal (kind 'event', items placed by course_id + sort_order,
// with the event's date kept in week_start).
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
  courseId: string | null;
  sortOrder: number;
}

export interface MenuCourse {
  id: string;
  name: string;
  mealType?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}

export type MenuKind = 'week' | 'event';

export interface MenuDetail extends Record<string, unknown> {
  id: string;
  name: string;
  week_start: string;
  notes: string | null;
  kind: MenuKind;
  meal_type: string | null;
  guests: number | null;
  courses: MenuCourse[];
  items: MenuItem[];
}

function newId(): string {
  return crypto.randomUUID();
}

/** The courses column as the server's JSONB hands it over: an array, never
 *  the stored text, and never anything malformed. */
const MEAL_TYPE_SET = new Set(['breakfast', 'lunch', 'dinner', 'snack']);

function parseCourses(raw: unknown): MenuCourse[] {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is MenuCourse => !!c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => (MEAL_TYPE_SET.has(c.mealType as string)
      ? { id: c.id, name: c.name, mealType: c.mealType }
      : { id: c.id, name: c.name }));
}

/** Summaries for the Planner's menu switcher — snake_case with an
 *  item_count, matching GET /api/menus. */
export async function listMenus(): Promise<Array<Record<string, unknown>>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT m.*, COUNT(mi.id) AS item_count
       FROM menus m
       LEFT JOIN menu_items mi ON mi.menu_id = m.id
      GROUP BY m.id
      ORDER BY m.week_start DESC`,
  );
  return rows.map((row) => ({ ...row, kind: row.kind === 'event' ? 'event' : 'week', courses: parseCourses(row.courses) }));
}

export async function getMenu(id: string): Promise<MenuDetail | null> {
  const menu = await queryOne<{
    id: string; name: string; week_start: string; notes: string | null;
    kind: string | null; meal_type: string | null; guests: number | null; courses: string | null;
    created_at: string; updated_at: string;
  }>('SELECT * FROM menus WHERE id=$1', [id]);
  if (!menu) return null;

  const items = await query<{
    id: string; recipe_id: string; recipe_title: string | null;
    day_of_week: number; meal_type: string; servings: number; notes: string | null;
    course_id: string | null; sort_order: number | null;
  }>(
    `SELECT mi.id, mi.recipe_id, r.title AS recipe_title, mi.day_of_week,
            mi.meal_type, mi.servings, mi.notes, mi.course_id, mi.sort_order
       FROM menu_items mi
       LEFT JOIN recipes r ON r.id = mi.recipe_id
      WHERE mi.menu_id = $1
      ORDER BY mi.day_of_week, mi.sort_order, mi.meal_type`,
    [id],
  );

  return {
    ...menu,
    kind: menu.kind === 'event' ? 'event' : 'week',
    meal_type: menu.meal_type ?? null,
    guests: menu.guests ?? null,
    courses: parseCourses(menu.courses),
    items: items.map((i) => ({
      id: i.id,
      recipeId: i.recipe_id,
      recipe_title: i.recipe_title,
      dayOfWeek: i.day_of_week,
      mealType: i.meal_type,
      servings: i.servings,
      notes: i.notes,
      courseId: i.course_id ?? null,
      sortOrder: i.sort_order ?? 0,
    })),
  };
}

export interface CreateMenuInput {
  name: string;
  weekStart: string;
  notes?: string | null;
  kind?: MenuKind;
  mealType?: string | null;
  guests?: number | null;
  courses?: MenuCourse[];
}

export async function createMenu(input: CreateMenuInput): Promise<{ id: string; name: string; weekStart: string; kind: MenuKind }> {
  const id = newId();
  const kind: MenuKind = input.kind === 'event' ? 'event' : 'week';
  await query(
    `INSERT INTO menus (id, name, week_start, notes, kind, meal_type, guests, courses)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.name, input.weekStart, input.notes ?? null, kind,
     input.mealType ?? null, input.guests ?? null, JSON.stringify(parseCourses(input.courses ?? []))],
  );
  return { id, name: input.name, weekStart: input.weekStart, kind };
}

export interface UpdateMenuInput {
  name?: string;
  weekStart?: string;
  notes?: string | null;
  mealType?: string | null;
  guests?: number | null;
  courses?: MenuCourse[];
}

/** PATCH /api/menus/:id — only the fields sent are written, like the
 *  server's version. False when there is no such menu. */
export async function updateMenu(id: string, input: UpdateMenuInput): Promise<boolean> {
  const existing = await queryOne<{ id: string }>('SELECT id FROM menus WHERE id=$1', [id]);
  if (!existing) return false;
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column}=$${params.length}`);
  };
  if (typeof input.name === 'string' && input.name.trim()) set('name', input.name.trim());
  if (typeof input.weekStart === 'string' && input.weekStart) set('week_start', input.weekStart);
  if (input.notes !== undefined) set('notes', input.notes);
  if (input.mealType !== undefined) set('meal_type', input.mealType);
  if (input.guests !== undefined) set('guests', input.guests);
  if (input.courses !== undefined) set('courses', JSON.stringify(parseCourses(input.courses)));
  if (sets.length === 0) return true;
  params.push(id);
  await query(`UPDATE menus SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=$${params.length}`, params);
  return true;
}

export async function addMenuItem(menuId: string, input: {
  recipeId: string; dayOfWeek?: number; mealType?: string; servings?: number; notes?: string | null;
  courseId?: string | null; sortOrder?: number;
}): Promise<{ id: string } | null> {
  const menu = await queryOne<{ id: string }>('SELECT id FROM menus WHERE id=$1', [menuId]);
  if (!menu) return null;
  const id = newId();
  const courseId = input.courseId ?? null;
  // A dish added without a position goes to the end of its course. "IS"
  // so a null course (a weekly plan's items) compares equal to itself.
  const sortOrder = typeof input.sortOrder === 'number'
    ? input.sortOrder
    : Number((await queryOne<{ next: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM menu_items WHERE menu_id=$1 AND course_id IS $2',
        [menuId, courseId],
      ))?.next ?? 0);
  await query(
    `INSERT INTO menu_items (id, menu_id, recipe_id, day_of_week, meal_type, servings, notes, course_id, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, menuId, input.recipeId, input.dayOfWeek ?? 0, input.mealType ?? 'dinner', input.servings ?? 4,
     input.notes ?? null, courseId, sortOrder],
  );
  await query("UPDATE menus SET updated_at=CURRENT_TIMESTAMP WHERE id=$1", [menuId]);
  return { id };
}

/** Move a planned recipe to another day/meal — the drag-and-drop write.
 *  COALESCE-style partial update so a drag that only changes the day does
 *  not clobber the servings someone set. */
export async function updateMenuItem(menuId: string, itemId: string, input: {
  dayOfWeek?: number; mealType?: string; servings?: number;
  courseId?: string; sortOrder?: number; notes?: string | null;
}): Promise<boolean> {
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM menu_items WHERE id=$1 AND menu_id=$2', [itemId, menuId],
  );
  if (!existing) return false;
  await query(
    `UPDATE menu_items
        SET day_of_week = COALESCE($1, day_of_week),
            meal_type   = COALESCE($2, meal_type),
            servings    = COALESCE($3, servings),
            course_id   = COALESCE($4, course_id),
            sort_order  = COALESCE($5, sort_order)
      WHERE id=$6 AND menu_id=$7`,
    [input.dayOfWeek ?? null, input.mealType ?? null, input.servings ?? null,
     input.courseId ?? null, input.sortOrder ?? null, itemId, menuId],
  );
  // Notes on their own: null is a real value here ("clear the note"),
  // which COALESCE cannot tell apart from "not sent".
  if (input.notes !== undefined) {
    await query('UPDATE menu_items SET notes=$1 WHERE id=$2 AND menu_id=$3', [input.notes, itemId, menuId]);
  }
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
