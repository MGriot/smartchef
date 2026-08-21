// ════════════════════════════════════════════════════════════════════════
// SmartChef — Ingredients/Units/Tools (standalone port)
// Ported from backend/src/routes/ingredients.ts. Route handlers become
// plain async functions called directly from localRouter.ts — no Express,
// no HTTP layer. Two structural changes throughout:
//   - json_agg(...)/json_build_object(...) subqueries (Postgres nests
//     translations/tags into each row DB-side) → fetched as separate flat
//     queries per row and assembled here in TS instead.
//   - ILIKE → LIKE (SQLite's LIKE is already ASCII-case-insensitive).
// Zod request validation is deliberately dropped — unlike the server route,
// this runs in the same process as its only caller (the frontend UI that
// already controls the request shape), so it's not a real trust boundary.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale.
async function syncIngredient(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM ingredients WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('ingredients', id, row);
  } catch (err) {
    console.error('SmartChef sync (ingredient) failed:', err);
  }
}

/** Re-writes every local ingredient's entity file regardless of whether
 *  anything actually changed — normal create/update calls only ever touch
 *  the one row involved, so a row whose file never made it into the sync
 *  folder (an import that predates a sync bug fix, a sync target that got
 *  reset/corrupted, ...) has no other way to catch up short of editing it
 *  by hand. Called when pointing Folder Sync at a folder — see
 *  Account.tsx's handleChangeFolder() — so a freshly chosen target starts
 *  populated instead of empty until each row happens to be edited again. */
export async function resyncAllIngredients(): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM ingredients WHERE sync_status != 'deleted'");
  for (const row of rows) await syncIngredient(row.id);
  return rows.length;
}

// ── Ingredients ────────────────────────────────────────────────────────

export interface ListIngredientsParams {
  q?: string;
  lang?: string;
}

export async function listIngredients({ q, lang }: ListIngredientsParams) {
  const params: unknown[] = [];
  let where = `WHERE i.sync_status != 'deleted'`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND i.name LIKE $${params.length}`;
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT i.*, ic.name AS category_name, ic.icon AS category_icon, ic.color AS category_color
     FROM ingredients i
     LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
     ${where}
     ORDER BY COALESCE(ic.name, 'Uncategorized'), i.name
     LIMIT 200`,
    params
  );

  const result = [];
  for (const row of rows) {
    const id = row.id as string;
    const translations = await query<{ language_code: string; translated_name: string }>(
      `SELECT language_code, translated_name FROM ingredient_translations WHERE ingredient_id = $1`,
      [id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.translated_name ?? null : null;
    const translatedCategoryName = lang && row.category_id
      ? (await queryOne<{ name: string }>(
          `SELECT name FROM ingredient_category_translations WHERE category_id = $1 AND LOWER(language_code) = LOWER($2)`,
          [row.category_id, lang]
        ))?.name ?? row.category_name
      : row.category_name;

    const tagRows = await query<{ id: string; name: string; color: string | null; icon: string | null }>(
      `SELECT tg.id, tg.name, tg.color, tg.icon
       FROM ingredient_tags igt
       JOIN tags tg ON tg.id = igt.tag_id
       WHERE igt.ingredient_id = $1`,
      [id]
    );
    const tags = [];
    for (const t of tagRows) {
      const translatedTagName = lang
        ? (await queryOne<{ name: string }>(`SELECT name FROM tag_translations WHERE tag_id = $1 AND LOWER(language_code) = LOWER($2)`, [t.id, lang]))?.name ?? null
        : null;
      tags.push({ id: t.id, name: t.name, translated_name: translatedTagName, color: t.color, icon: t.icon });
    }

    result.push({
      ...row,
      image_urls: JSON.parse((row.image_urls as string) ?? '[]'),
      seasonal_months: JSON.parse((row.seasonal_months as string) ?? '[]'),
      translated_category_name: translatedCategoryName,
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, text: t.translated_name })),
      tags,
    });
  }
  return result;
}

export interface IngredientInput {
  id?: string;
  name: string;
  categoryId: string;
  description?: string | null;
  icon?: string | null;
  imageUrls?: string[];
  tagIds?: string[];
  translations?: Array<{ lang: string; text: string }>;
  caloriesKcal?: number | null;
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  /** Month numbers (1-12, Northern hemisphere) this ingredient is in
   *  season for — empty/undefined means "no seasonality data", not
   *  "year-round". See db/migrations/034_ingredient_seasonality.sql. */
  seasonalMonths?: number[];
}

async function upsertIngredientTags(ingredientId: string, tagIds?: string[]) {
  if (!tagIds) return;
  await query("DELETE FROM ingredient_tags WHERE ingredient_id=$1", [ingredientId]);
  for (const tagId of tagIds) {
    await query(
      "INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [ingredientId, tagId]
    );
  }
}

export async function createIngredient(d: IngredientInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    `INSERT INTO ingredients (id, name, category_id, description, icon, image_urls,
       calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, seasonal_months)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? []]
  );

  if (d.translations && d.translations.length > 0) {
    for (const t of d.translations) {
      await query(
        `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [newId(), id, t.lang, t.text]
      );
    }
  }
  await upsertIngredientTags(id, d.tagIds);

  await syncIngredient(id);
  return { id };
}

export async function updateIngredient(id: string, d: IngredientInput): Promise<void> {
  await query(
    `UPDATE ingredients SET name=$1, category_id=$2, description=$3, icon=$4, image_urls=$5,
       calories_kcal=$6, protein_g=$7, carbs_g=$8, fat_g=$9, fiber_g=$10, sugar_g=$11, sodium_mg=$12,
       seasonal_months=$13, updated_at=now()
     WHERE id=$14`,
    [d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? [], id]
  );

  if (d.translations) {
    await query("DELETE FROM ingredient_translations WHERE ingredient_id=$1", [id]);
    for (const t of d.translations) {
      if (t.lang && t.text) {
        await query(
          `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ($1, $2, $3, $4)`,
          [newId(), id, t.lang, t.text]
        );
      }
    }
  }
  await upsertIngredientTags(id, d.tagIds);
  await syncIngredient(id);
}

export async function deleteIngredient(id: string): Promise<void> {
  await query("UPDATE ingredients SET sync_status='deleted', updated_at=now() WHERE id=$1", [id]);
  await syncIngredient(id);
}

// ── Categories ─────────────────────────────────────────────────────────

export async function listCategories({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM ingredient_categories WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  const result = [];
  for (const row of rows) {
    const translations = await query<{ language_code: string; name: string; description: string | null }>(
      `SELECT language_code, name, description FROM ingredient_category_translations WHERE category_id = $1`,
      [row.id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null;
    result.push({
      ...row,
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
    });
  }
  return result;
}

export interface CategoryInput {
  id?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  translations?: Array<{ lang: string; name?: string | null; description?: string | null }>;
}

async function upsertCategoryTranslations(categoryId: string, translations?: CategoryInput['translations']) {
  if (!translations) return;
  await query("DELETE FROM ingredient_category_translations WHERE category_id=$1", [categoryId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(
      `INSERT INTO ingredient_category_translations (id, category_id, language_code, name, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), categoryId, t.lang, t.name || null, t.description || null]
    );
  }
}

export async function createCategory(d: CategoryInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    "INSERT INTO ingredient_categories (id, name, description, icon, color) VALUES ($1, $2, $3, $4, $5)",
    [id, d.name, d.description || null, d.icon || null, d.color || null]
  );
  await upsertCategoryTranslations(id, d.translations);
  return { id };
}

export async function updateCategory(id: string, d: CategoryInput): Promise<void> {
  await query(
    "UPDATE ingredient_categories SET name=$1, description=$2, icon=$3, color=$4, updated_at=now() WHERE id=$5",
    [d.name, d.description || null, d.icon || null, d.color || null, id]
  );
  await upsertCategoryTranslations(id, d.translations);
}

export async function deleteCategory(id: string): Promise<void> {
  await query("UPDATE ingredient_categories SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
}

// ── Units ──────────────────────────────────────────────────────────────

export async function listUnits({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM units ORDER BY unit_type, name`);
  const result = [];
  for (const row of rows) {
    const translations = await query<{ language_code: string; name: string }>(
      `SELECT language_code, name FROM unit_translations WHERE unit_id = $1`,
      [row.id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null;
    result.push({ ...row, translated_name: translatedName, translations: translations.map(t => ({ lang: t.language_code, name: t.name })) });
  }
  return result;
}

export interface UnitInput {
  name: string;
  symbol: string;
  unitType?: string;
  system?: string;
  toBaseFactor?: number;
  translations?: Array<{ lang: string; name?: string | null }>;
}

async function upsertUnitTranslations(unitId: string, translations?: UnitInput['translations']) {
  if (!translations) return;
  await query("DELETE FROM unit_translations WHERE unit_id=$1", [unitId]);
  for (const t of translations) {
    if (!t.lang || !t.name) continue;
    await query(`INSERT INTO unit_translations (id, unit_id, language_code, name) VALUES ($1, $2, $3, $4)`, [newId(), unitId, t.lang, t.name]);
  }
}

export async function createUnit(d: UnitInput): Promise<{ id: string }> {
  const id = newId();
  await query(
    `INSERT INTO units (id, name, symbol, unit_type, system, to_base_factor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, d.name, d.symbol, d.unitType || null, d.system || null, d.toBaseFactor ?? 1]
  );
  await upsertUnitTranslations(id, d.translations);
  return { id };
}

export async function updateUnit(id: string, d: UnitInput): Promise<void> {
  await query(
    `UPDATE units SET name=$1, symbol=$2, unit_type=$3, system=$4, to_base_factor=$5 WHERE id=$6`,
    [d.name, d.symbol, d.unitType || null, d.system || null, d.toBaseFactor ?? 1, id]
  );
  await upsertUnitTranslations(id, d.translations);
}

export async function deleteUnit(id: string): Promise<void> {
  await query("DELETE FROM units WHERE id=$1", [id]);
}

// ── Tools ──────────────────────────────────────────────────────────────

// See syncIngredient() above for the same fire-and-forget + dynamic-import
// rationale.
async function syncTool(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM tools WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('tools', id, row);
  } catch (err) {
    console.error('SmartChef sync (tool) failed:', err);
  }
}

/** Re-writes every local tool's entity file regardless of whether anything
 *  actually changed — see resyncAllIngredients() above for why this exists
 *  and where it's called from. Deliberately includes soft-deleted tools too
 *  (unlike resyncAllIngredients()'s sync_status filter): a tool deleted via
 *  a direct write that bypassed deleteTool()'s own syncTool() call would
 *  otherwise never push its deleted_at tombstone at all. */
export async function resyncAllTools(): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM tools");
  for (const row of rows) await syncTool(row.id);
  return rows.length;
}

export async function listTools({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tools WHERE deleted_at IS NULL ORDER BY category, name`);
  const result = [];
  for (const row of rows) {
    const translations = await query<{ language_code: string; name: string; description: string | null }>(
      `SELECT language_code, name, description FROM tool_translations WHERE tool_id = $1`,
      [row.id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null;
    result.push({
      ...row,
      image_urls: JSON.parse((row.image_urls as string) ?? '[]'),
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
    });
  }
  return result;
}

export interface ToolInput {
  id?: string;
  name: string;
  category?: string | null;
  description?: string | null;
  icon?: string | null;
  imageUrls?: string[];
  translations?: Array<{ lang: string; name?: string | null; description?: string | null }>;
}

async function upsertToolTranslations(toolId: string, translations?: ToolInput['translations']) {
  if (!translations) return;
  await query("DELETE FROM tool_translations WHERE tool_id=$1", [toolId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(`INSERT INTO tool_translations (id, tool_id, language_code, name, description) VALUES ($1, $2, $3, $4, $5)`, [newId(), toolId, t.lang, t.name || null, t.description || null]);
  }
}

export async function createTool(d: ToolInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    "INSERT INTO tools (id, name, category, description, icon, image_urls) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || []]
  );
  await upsertToolTranslations(id, d.translations);
  await syncTool(id);
  return { id };
}

export async function updateTool(id: string, d: ToolInput): Promise<void> {
  await query(
    "UPDATE tools SET name=$1, category=$2, description=$3, icon=$4, image_urls=$5, updated_at=now() WHERE id=$6",
    [d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], id]
  );
  await upsertToolTranslations(id, d.translations);
  await syncTool(id);
}

// Diverges from the real backend route on purpose: that route still does a
// hard DELETE FROM tools despite `tools.deleted_at` existing precisely for
// folder-sync tombstones (migration 021's own comment says so) — the route
// itself was just never switched over. A hard delete here would give the
// Sync Engine nothing to propagate: the row would simply vanish on this
// device while staying alive everywhere else, forever. Standalone mode
// needs the tombstone to actually sync, so this is a deliberate correction,
// not a faithful port of the server's current (arguably buggy) behavior.
export async function deleteTool(id: string): Promise<void> {
  await query("UPDATE tools SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
  await syncTool(id);
}
