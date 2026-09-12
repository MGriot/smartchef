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

import { query, queryOne, inPlaceholders, chunk } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale. Exported so conflicts.local.ts's
// applyResolvedConflict() can re-commit a resolved field into the Hidden
// Clone — resolving a conflict only updates Local Storage's own row on its
// own; without this, the resolution would never reach the Sync Folder or
// any other device.
export async function syncIngredient(id: string): Promise<void> {
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
export async function resyncAllIngredients(onProgress?: (done: number, total: number) => void): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM ingredients WHERE sync_status != 'deleted'");
  for (let i = 0; i < rows.length; i++) {
    await syncIngredient(rows[i].id);
    onProgress?.(i + 1, rows.length);
  }
  return rows.length;
}

// ── Ingredients ────────────────────────────────────────────────────────

export interface ListIngredientsParams {
  q?: string;
  lang?: string;
}

/** Result cap applied ONLY to the `q` search path, where the caller wants a
 *  short pick-list rather than the whole library (RecipeImport.tsx's
 *  runSearch() slices to 8 anyway). The unfiltered path is deliberately
 *  uncapped: every one of its callers — LibraryIngredients.tsx,
 *  LibrarySeasonality.tsx, RecipeCreate.tsx, RecipeDetail.tsx and
 *  localMatcher.ts — consumes the whole list client-side (grouping it by
 *  category, or matching against it), so a cap there doesn't paginate,
 *  it just silently deletes ingredients from the UI. A shared `LIMIT 200`
 *  used to sit here and did exactly that: with 220 ingredients ordered by
 *  category name, the entire last-sorting category ("Vegetables & Produce")
 *  fell past row 200 and rendered as an empty section, and localMatcher.ts
 *  couldn't see those rows either, so importing a recipe naming one of them
 *  created a duplicate ingredient instead of matching the existing row. */
const SEARCH_RESULT_LIMIT = 200;

export async function listIngredients({ q, lang }: ListIngredientsParams) {
  const params: unknown[] = [];
  let where = `WHERE i.sync_status != 'deleted'`;
  if (q) {
    // Matches on the canonical name OR any synonym — synonyms is a
    // JSON-encoded array, so this is a plain substring match against its
    // serialized text rather than a real per-element search, same
    // trade-off db/local.ts's other JSON-array columns already make.
    params.push(`%${q}%`, `%${q}%`);
    let clause = `i.name LIKE $${params.length - 1} OR i.synonyms LIKE $${params.length}`;
    // Also search the content-language name. Without this the Import review
    // step's "search existing" box was English-only: typing "burro" matched
    // nothing at all, because `q` only ever hit the base name and the
    // JSON-encoded synonyms. The translated name lives in a side table, so
    // this is an EXISTS rather than another column to LIKE against, and it
    // only applies when a language is actually in play.
    if (lang) {
      params.push(`%${q}%`, lang);
      clause += ` OR EXISTS (SELECT 1 FROM ingredient_translations tr
                             WHERE tr.ingredient_id = i.id
                               AND tr.translated_name LIKE $${params.length - 1}
                               AND LOWER(tr.language_code) = LOWER($${params.length}))`;
    }
    where += ` AND (${clause})`;
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT i.*, ic.name AS category_name, ic.icon AS category_icon, ic.color AS category_color,
            p.name AS parent_name
     FROM ingredients i
     LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
     LEFT JOIN ingredients p ON p.id = i.parent_ingredient_id
     ${where}
     ORDER BY COALESCE(ic.name, 'Uncategorized'), i.name
     ${q ? `LIMIT ${SEARCH_RESULT_LIMIT}` : ''}`,
    params
  );
  if (rows.length === 0) return [];

  // Everything below resolves translations/tags for the WHOLE result set in
  // a fixed number of queries instead of once (or once per tag) per row.
  // With the LIMIT gone this is what keeps the page affordable: the old
  // per-row version cost roughly `rows x 3 + tags` sequential bridge
  // round-trips, which grew without bound as the library grew — the exact
  // N+1 shape docs/plans/2026-08-22-android-performance-plan.md exists to
  // stamp out.
  const ids = rows.map(r => r.id as string);

  const translationsByIngredient = new Map<string, Array<{ language_code: string; translated_name: string }>>();
  for (const idBatch of chunk(ids)) {
    const p: unknown[] = [];
    const trs = await query<{ ingredient_id: string; language_code: string; translated_name: string }>(
      `SELECT ingredient_id, language_code, translated_name
       FROM ingredient_translations WHERE ingredient_id IN (${inPlaceholders(p, idBatch)})`,
      p
    );
    for (const t of trs) {
      const list = translationsByIngredient.get(t.ingredient_id);
      if (list) list.push(t);
      else translationsByIngredient.set(t.ingredient_id, [t]);
    }
  }

  const categoryNameByCategoryId = new Map<string, string>();
  const categoryIds = [...new Set(rows.map(r => r.category_id).filter(Boolean))] as string[];
  if (lang && categoryIds.length > 0) {
    for (const catBatch of chunk(categoryIds)) {
      const p: unknown[] = [];
      const placeholders = inPlaceholders(p, catBatch);
      p.push(lang);
      const cts = await query<{ category_id: string; name: string }>(
        `SELECT category_id, name FROM ingredient_category_translations
         WHERE category_id IN (${placeholders}) AND LOWER(language_code) = LOWER($${p.length})`,
        p
      );
      for (const c of cts) categoryNameByCategoryId.set(c.category_id, c.name);
    }
  }

  const tagRowsByIngredient = new Map<string, Array<{ id: string; name: string; color: string | null; icon: string | null }>>();
  const allTagIds = new Set<string>();
  for (const idBatch of chunk(ids)) {
    const p: unknown[] = [];
    const tagRows = await query<{ ingredient_id: string; id: string; name: string; color: string | null; icon: string | null }>(
      `SELECT igt.ingredient_id, tg.id, tg.name, tg.color, tg.icon
       FROM ingredient_tags igt
       JOIN tags tg ON tg.id = igt.tag_id
       WHERE igt.ingredient_id IN (${inPlaceholders(p, idBatch)})`,
      p
    );
    for (const t of tagRows) {
      allTagIds.add(t.id);
      const list = tagRowsByIngredient.get(t.ingredient_id);
      if (list) list.push(t);
      else tagRowsByIngredient.set(t.ingredient_id, [t]);
    }
  }

  const tagTranslationByTagId = new Map<string, string>();
  if (lang && allTagIds.size > 0) {
    for (const tagBatch of chunk([...allTagIds])) {
      const p: unknown[] = [];
      const placeholders = inPlaceholders(p, tagBatch);
      p.push(lang);
      const tts = await query<{ tag_id: string; name: string }>(
        `SELECT tag_id, name FROM tag_translations
         WHERE tag_id IN (${placeholders}) AND LOWER(language_code) = LOWER($${p.length})`,
        p
      );
      for (const t of tts) tagTranslationByTagId.set(t.tag_id, t.name);
    }
  }

  return rows.map(row => {
    const id = row.id as string;
    const translations = translationsByIngredient.get(id) ?? [];
    const translatedName = lang
      ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.translated_name ?? null
      : null;
    const translatedCategoryName = lang && row.category_id
      ? categoryNameByCategoryId.get(row.category_id as string) ?? row.category_name
      : row.category_name;

    const tags = (tagRowsByIngredient.get(id) ?? []).map(t => ({
      id: t.id,
      name: t.name,
      translated_name: lang ? tagTranslationByTagId.get(t.id) ?? null : null,
      color: t.color,
      icon: t.icon,
    }));

    return {
      ...row,
      image_urls: JSON.parse((row.image_urls as string) ?? '[]'),
      seasonal_months: JSON.parse((row.seasonal_months as string) ?? '[]'),
      synonyms: JSON.parse((row.synonyms as string) ?? '[]'),
      translated_category_name: translatedCategoryName,
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, text: t.translated_name })),
      tags,
    };
  });
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
  /** Alternate names, search-only — see db/migrations/035_synonyms.sql. */
  synonyms?: string[];
  /** "This is a variety of" — see db/migrations/036_ingredient_parent.sql. */
  parentIngredientId?: string | null;
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


/** Ingredient counterpart of recipes.local.ts's syncRecipeInBackground() —
 *  see that function for why a save must not await the git queue. */
function syncIngredientInBackground(id: string): void {
  void syncIngredient(id);
}

export async function createIngredient(d: IngredientInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    `INSERT INTO ingredients (id, name, category_id, description, icon, image_urls,
       calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, seasonal_months,
       synonyms, parent_ingredient_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [id, d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? [],
     d.synonyms ?? [], d.parentIngredientId ?? null]
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

  syncIngredientInBackground(id);
  return { id };
}

export async function updateIngredient(id: string, d: IngredientInput): Promise<void> {
  // A variant can't be its own parent, directly or by way of one of its
  // own descendants — walk up from the proposed parent and refuse if this
  // ingredient's own id shows up, rather than silently creating a cycle
  // the UI would then render as an infinite chain.
  let parentIngredientId = d.parentIngredientId ?? null;
  if (parentIngredientId) {
    let cursor: string | null = parentIngredientId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) { parentIngredientId = null; break; }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const ancestorRow: { parent_ingredient_id: string | null } | null = await queryOne('SELECT parent_ingredient_id FROM ingredients WHERE id=$1', [cursor]);
      cursor = ancestorRow?.parent_ingredient_id ?? null;
    }
  }

  await query(
    `UPDATE ingredients SET name=$1, category_id=$2, description=$3, icon=$4, image_urls=$5,
       calories_kcal=$6, protein_g=$7, carbs_g=$8, fat_g=$9, fiber_g=$10, sugar_g=$11, sodium_mg=$12,
       seasonal_months=$13, synonyms=$14, parent_ingredient_id=$15, updated_at=now()
     WHERE id=$16`,
    [d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? [],
     d.synonyms ?? [], parentIngredientId, id]
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
  syncIngredientInBackground(id);
}

export async function deleteIngredient(id: string): Promise<void> {
  await query("UPDATE ingredients SET sync_status='deleted', updated_at=now() WHERE id=$1", [id]);
  syncIngredientInBackground(id);
}

/** Folds a mistakenly-duplicated ingredient into another one — every recipe
 *  that referenced `sourceId` is repointed to `targetId` instead (so
 *  existing recipes aren't affected, just correctly point at one ingredient
 *  going forward) and `sourceId` is tombstoned. `ingredient_translations`
 *  for the source are simply discarded — the target's own translations
 *  are what's kept, same as any other field a merge has to pick a side on. */
export async function mergeIngredients(sourceId: string, targetId: string): Promise<{ recipesUpdated: number }> {
  if (sourceId === targetId) throw new Error('Cannot merge an ingredient into itself');

  const affectedRecipes = await query<{ recipe_id: string }>(
    "SELECT DISTINCT recipe_id FROM recipe_ingredients WHERE ingredient_id=$1",
    [sourceId]
  );

  await query("UPDATE recipe_ingredients SET ingredient_id=$1 WHERE ingredient_id=$2", [targetId, sourceId]);

  // Union the tag sets rather than clobbering the target's — dedupe via
  // ON CONFLICT DO NOTHING against ingredient_tags' (ingredient_id, tag_id)
  // primary key.
  await query(
    "INSERT INTO ingredient_tags (ingredient_id, tag_id) SELECT $1, tag_id FROM ingredient_tags WHERE ingredient_id=$2 ON CONFLICT DO NOTHING",
    [targetId, sourceId]
  );
  await query("DELETE FROM ingredient_tags WHERE ingredient_id=$1", [sourceId]);

  await deleteIngredient(sourceId);
  syncIngredientInBackground(targetId);

  const { syncRecipe } = await import('./recipes.local');
  for (const row of affectedRecipes) await syncRecipe(row.recipe_id);

  return { recipesUpdated: affectedRecipes.length };
}

// ── Categories ─────────────────────────────────────────────────────────

/** The aisle order — see the server's PUT /ingredients/categories/reorder
 *  for why this takes the whole sequence rather than one moved item. */
export async function reorderCategories(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await query('UPDATE ingredient_categories SET sort_order=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2', [i, ids[i]]);
  }
}

export async function listCategories({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM ingredient_categories WHERE deleted_at IS NULL ORDER BY sort_order, name`
  );
  // One batched read instead of one per category. The gallery fetches
  // /api/ingredients/categories on mount alongside /api/tags, so this sat on
  // the same critical path — and every Capacitor bridge round-trip here is
  // one the recipe grid waits behind, since db/local.ts serializes them all
  // through a single queue.
  const translationsByCategoryId = new Map<string, Array<{ language_code: string; name: string; description: string | null }>>();
  for (const batch of chunk(rows.map(r => r.id as string))) {
    const p: unknown[] = [];
    const trs = await query<{ category_id: string; language_code: string; name: string; description: string | null }>(
      `SELECT category_id, language_code, name, description FROM ingredient_category_translations
       WHERE category_id IN (${inPlaceholders(p, batch)}) ORDER BY rowid`,
      p
    );
    for (const t of trs) {
      const list = translationsByCategoryId.get(t.category_id);
      if (list) list.push(t);
      else translationsByCategoryId.set(t.category_id, [t]);
    }
  }

  return rows.map(row => {
    const translations = translationsByCategoryId.get(row.id as string) ?? [];
    return {
      ...row,
      translated_name: lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
    };
  });
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

  // Batched for the same reason as listCategories() above. Units are the
  // smallest of these catalogs (the starter seed ships nine), but this list
  // is fetched by the recipe editor, RecipeCreate, Pantry and the shopping
  // list, so the per-row version was a round-trip tax on four screens.
  const translationsByUnitId = new Map<string, Array<{ language_code: string; name: string }>>();
  for (const batch of chunk(rows.map(r => r.id as string))) {
    const p: unknown[] = [];
    const trs = await query<{ unit_id: string; language_code: string; name: string }>(
      `SELECT unit_id, language_code, name FROM unit_translations
       WHERE unit_id IN (${inPlaceholders(p, batch)}) ORDER BY rowid`,
      p
    );
    for (const t of trs) {
      const list = translationsByUnitId.get(t.unit_id);
      if (list) list.push(t);
      else translationsByUnitId.set(t.unit_id, [t]);
    }
  }

  return rows.map(row => {
    const translations = translationsByUnitId.get(row.id as string) ?? [];
    return {
      ...row,
      translated_name: lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name })),
    };
  });
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
// rationale — also exported for conflicts.local.ts, same reason.
export async function syncTool(id: string): Promise<void> {
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
export async function resyncAllTools(onProgress?: (done: number, total: number) => void): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM tools");
  for (let i = 0; i < rows.length; i++) {
    await syncTool(rows[i].id);
    onProgress?.(i + 1, rows.length);
  }
  return rows.length;
}

export async function listTools({ lang, q }: { lang?: string; q?: string }) {
  const params: unknown[] = [];
  let where = `WHERE deleted_at IS NULL`;
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    let clause = `name LIKE $${params.length - 1} OR synonyms LIKE $${params.length}`;
    // Same translated-name search as listIngredients() above — the review
    // step searches tools through the identical UI.
    if (lang) {
      params.push(`%${q}%`, lang);
      clause += ` OR EXISTS (SELECT 1 FROM tool_translations tr
                             WHERE tr.tool_id = tools.id
                               AND tr.name LIKE $${params.length - 1}
                               AND LOWER(tr.language_code) = LOWER($${params.length}))`;
    }
    where += ` AND (${clause})`;
  }
  const rows = await query<Record<string, unknown>>(`SELECT * FROM tools ${where} ORDER BY category, name`, params);
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
      synonyms: JSON.parse((row.synonyms as string) ?? '[]'),
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
  synonyms?: string[];
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
    "INSERT INTO tools (id, name, category, description, icon, image_urls, synonyms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? []]
  );
  await upsertToolTranslations(id, d.translations);
  await syncTool(id);
  return { id };
}

export async function updateTool(id: string, d: ToolInput): Promise<void> {
  await query(
    "UPDATE tools SET name=$1, category=$2, description=$3, icon=$4, image_urls=$5, synonyms=$6, updated_at=now() WHERE id=$7",
    [d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? [], id]
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

/** Folds a mistakenly-duplicated tool into another one — the same shape as
 *  mergeIngredients() above, with one extra place to repoint that
 *  ingredients don't have: `recipe_steps.tool_ids` is a JSON array of tool
 *  ids, so a merge that only rewrote `recipe_tools` would leave the source
 *  id dangling inside individual steps (StepEditor renders those by id, so
 *  the step would silently lose its tool the moment the source row was
 *  tombstoned). Translations/photos on the source are discarded — the
 *  target's own are what a merge keeps, same rule as everywhere else. */
export async function mergeTools(sourceId: string, targetId: string): Promise<{ recipesUpdated: number }> {
  if (sourceId === targetId) throw new Error('Cannot merge a tool into itself');
  const source = await queryOne<{ id: string }>("SELECT id FROM tools WHERE id=$1", [sourceId]);
  const target = await queryOne<{ id: string }>("SELECT id FROM tools WHERE id=$1 AND deleted_at IS NULL", [targetId]);
  if (!source || !target) throw new Error('Tool not found');

  const affected = new Set<string>();

  // recipe_tools is a (recipe_id, tool_id) join table: union rather than
  // UPDATE, so a recipe that already carried BOTH tools doesn't trip the
  // primary key.
  for (const row of await query<{ recipe_id: string }>("SELECT recipe_id FROM recipe_tools WHERE tool_id=$1", [sourceId])) {
    affected.add(row.recipe_id);
  }
  await query(
    "INSERT INTO recipe_tools (recipe_id, tool_id) SELECT recipe_id, $1 FROM recipe_tools WHERE tool_id=$2 ON CONFLICT DO NOTHING",
    [targetId, sourceId],
  );
  await query("DELETE FROM recipe_tools WHERE tool_id=$1", [sourceId]);

  for (const step of await query<{ id: string; recipe_id: string; tool_ids: string }>(
    "SELECT id, recipe_id, tool_ids FROM recipe_steps WHERE tool_ids LIKE $1", [`%${sourceId}%`],
  )) {
    const ids: string[] = JSON.parse(step.tool_ids || '[]');
    if (!ids.includes(sourceId)) continue;
    const replaced = Array.from(new Set(ids.map((id) => (id === sourceId ? targetId : id))));
    await query("UPDATE recipe_steps SET tool_ids=$1 WHERE id=$2", [replaced, step.id]);
    affected.add(step.recipe_id);
  }

  await deleteTool(sourceId);
  await syncTool(targetId);

  const { syncRecipe } = await import('./recipes.local');
  for (const recipeId of affected) await syncRecipe(recipeId);

  return { recipesUpdated: affected.size };
}
