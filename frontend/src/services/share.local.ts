// ════════════════════════════════════════════════════════════════════════
// SmartChef — Share/export (standalone port)
// Ported from backend/src/routes/share.ts's export half, following the same
// convention as ingredients.local.ts/recipes.local.ts: route handlers become
// plain async functions called from localRouter.ts.
//
// Why this exists: localRouter.ts's dispatch list didn't include "share", so
// GET /api/share/recipes/:id/export fell straight through to a server —
// which in standalone mode isn't there. "Export recipe" on the Windows app
// therefore failed silently (RecipeDetail.tsx's handler only console.errors).
//
// Structural changes from the server original, all of them the usual
// Postgres -> SQLite ones:
//   - TEXT[]/JSONB columns (tags, sources, tool_ids, step_ingredients,
//     image_urls) are JSON-encoded TEXT here, so they're JSON.parse'd on
//     the way out rather than arriving as real arrays.
//   - BOOLEAN columns are 0/1 integers, so they're coerced with !!.
//   - node-pg's "NUMERIC comes back as a string" workaround is unnecessary
//     (SQLite returns real numbers) but harmless, and keeping the Number()
//     coercion means both implementations emit identical bundles.
//
// Only the *export* half is ported. Import (POST /api/share/import) is a
// much larger surface with its own matching/dedup logic, and nothing in
// the app calls it in standalone mode today. Collection export is likewise
// left out: standalone has no collection_recipes table to read.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";

/** Must match backend/src/routes/share.ts's FORMAT_VERSION — a bundle
 *  exported here is meant to import into a server-backed instance and vice
 *  versa, so the two have to agree on the number. */
const FORMAT_VERSION = 1;

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Walks sub_recipe_id references, returning recipe ids in dependency
 *  (child-before-parent) order so replaying them at import time never
 *  references a not-yet-created recipe. */
async function collectRecipeClosure(rootIds: string[]): Promise<string[]> {
  const visited = new Set<string>();
  const order: string[] = [];

  async function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const subRows = await query<{ sub_recipe_id: string }>(
      `SELECT DISTINCT sub_recipe_id FROM recipe_ingredients
       WHERE recipe_id=$1 AND sub_recipe_id IS NOT NULL`,
      [id]
    );
    for (const row of subRows) await visit(row.sub_recipe_id);
    order.push(id);
  }

  for (const id of rootIds) await visit(id);
  return order;
}

async function loadBundleRecipe(id: string) {
  const r = await queryOne<Record<string, any>>("SELECT * FROM recipes WHERE id=$1", [id]);
  if (!r) throw new Error(`Recipe ${id} not found`);

  const ingredientRows = await query<Record<string, any>>(
    `SELECT ri.sort_order, ri.ingredient_id, ri.sub_recipe_id, ri.quantity, ri.quantity_text,
            ri.notes, ri.is_optional, u.symbol AS unit_symbol
     FROM recipe_ingredients ri LEFT JOIN units u ON u.id = ri.unit_id
     WHERE ri.recipe_id=$1 ORDER BY ri.sort_order`,
    [id]
  );

  const stepRows = await query<Record<string, any>>(
    `SELECT id, step_number, title, description, duration_min, tool_ids, notes, image_url, step_ingredients
     FROM recipe_steps WHERE recipe_id=$1 ORDER BY step_number`,
    [id]
  );

  const steps = [];
  for (const s of stepRows) {
    const translations = await query<Record<string, any>>(
      "SELECT language_code AS lang, title, description FROM recipe_step_translations WHERE step_id=$1",
      [s.id]
    );
    steps.push({
      stepNumber: s.step_number,
      title: s.title,
      description: s.description,
      durationMin: s.duration_min,
      toolIds: parseJsonArray(s.tool_ids) as string[],
      notes: s.notes,
      imageUrl: s.image_url,
      stepIngredients: parseJsonArray(s.step_ingredients),
      translations,
    });
  }

  const toolRows = await query<{ tool_id: string }>(
    "SELECT tool_id FROM recipe_tools WHERE recipe_id=$1",
    [id]
  );
  const translations = await query<Record<string, any>>(
    "SELECT language_code AS lang, title, description FROM recipe_translations WHERE recipe_id=$1",
    [id]
  );

  return {
    id: r.id,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    servings: r.servings,
    prepTimeMin: r.prep_time_min,
    cookTimeMin: r.cook_time_min,
    restTimeMin: r.rest_time_min,
    rating: r.rating,
    timesCooked: r.times_cooked,
    tags: parseJsonArray(r.tags) as string[],
    coverImageUrl: r.cover_image_url,
    sourceUrl: r.source_url,
    sources: parseJsonArray(r.sources),
    isComponent: !!r.is_component,
    languageCode: r.language_code,
    ingredients: ingredientRows.map((i) => ({
      sortOrder: i.sort_order,
      ingredientId: i.ingredient_id ?? undefined,
      subRecipeId: i.sub_recipe_id ?? undefined,
      quantity: numberOrNull(i.quantity),
      quantityText: i.quantity_text,
      unitSymbol: i.unit_symbol,
      notes: i.notes,
      isOptional: !!i.is_optional,
    })),
    steps,
    toolIds: toolRows.map((t) => t.tool_id),
    translations,
  };
}

async function loadBundleIngredient(id: string) {
  const row = await queryOne<Record<string, any>>(
    `SELECT i.*, c.name AS category_name FROM ingredients i
     LEFT JOIN ingredient_categories c ON c.id = i.category_id WHERE i.id=$1`,
    [id]
  );
  if (!row) throw new Error(`Ingredient ${id} not found`);

  const translations = await query<Record<string, any>>(
    "SELECT language_code AS lang, translated_name AS name FROM ingredient_translations WHERE ingredient_id=$1",
    [id]
  );
  return {
    id: row.id,
    // LEFT JOIN, not the server's inner JOIN: a category_id synced in from
    // another device points at that device's own random category id and
    // matches nothing here (see db/local.ts's ingredients comment), and an
    // inner join would silently drop the ingredient from the bundle —
    // producing an export whose recipes reference ingredients it omits.
    categoryName: row.category_name ?? "Uncategorized",
    name: row.name,
    description: row.description,
    // Standalone's ingredients table has no density/default-unit columns.
    // Emitted as null so the bundle keeps the shape the import side's Zod
    // schema expects rather than omitting the keys.
    densityGPerMl: null,
    defaultUnit: null,
    imageUrls: parseJsonArray(row.image_urls) as string[],
    icon: row.icon,
    caloriesKcal: numberOrNull(row.calories_kcal),
    proteinG: numberOrNull(row.protein_g),
    carbsG: numberOrNull(row.carbs_g),
    fatG: numberOrNull(row.fat_g),
    fiberG: numberOrNull(row.fiber_g),
    sugarG: numberOrNull(row.sugar_g),
    sodiumMg: numberOrNull(row.sodium_mg),
    translations,
  };
}

async function loadBundleTool(id: string) {
  const row = await queryOne<Record<string, any>>("SELECT * FROM tools WHERE id=$1", [id]);
  if (!row) throw new Error(`Tool ${id} not found`);
  const translations = await query<Record<string, any>>(
    "SELECT language_code AS lang, name, description FROM tool_translations WHERE tool_id=$1",
    [id]
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    imageUrls: parseJsonArray(row.image_urls) as string[],
    translations,
  };
}

export async function buildBundle(rootRecipeIds: string[]) {
  const recipeIds = await collectRecipeClosure(rootRecipeIds);
  const recipes = [];
  for (const id of recipeIds) recipes.push(await loadBundleRecipe(id));

  const ingredientIds = new Set<string>();
  const toolIds = new Set<string>();
  for (const r of recipes) {
    for (const ing of r.ingredients) if (ing.ingredientId) ingredientIds.add(ing.ingredientId);
    for (const tid of r.toolIds) toolIds.add(tid);
    for (const s of r.steps) for (const tid of s.toolIds) toolIds.add(tid);
  }

  const ingredients = [];
  for (const id of ingredientIds) ingredients.push(await loadBundleIngredient(id));
  const tools = [];
  for (const id of toolIds) tools.push(await loadBundleTool(id));

  return { formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), recipes, ingredients, tools };
}

/** GET /api/share/recipes/:id/export */
export async function exportRecipe(id: string) {
  const exists = await queryOne<{ id: string }>(
    "SELECT id FROM recipes WHERE id=$1 AND sync_status != 'deleted'",
    [id]
  );
  if (!exists) return null;
  return buildBundle([id]);
}

/** POST /api/share/recipes/export-bulk */
export async function exportRecipesBulk(recipeIds: string[]) {
  return buildBundle(recipeIds);
}
