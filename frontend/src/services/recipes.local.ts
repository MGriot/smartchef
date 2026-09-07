// ════════════════════════════════════════════════════════════════════════
// SmartChef — Recipes (standalone port)
// Ported from backend/src/routes/recipes.ts. The riskiest file in Stage 1
// — 9 dynamic listing params, unnest()/ANY()/&&-array operators, and
// json_agg/jsonb_build_object/FILTER(WHERE...) nested-JSON assembly, none
// of which SQLite has. Structural changes, applied consistently:
//   - json_agg(...) nested ingredient/step/tool assembly → fetched as flat
//     per-recipe queries and assembled into the same nested shape here in
//     TS. Not a workaround — arguably simpler than the SQL it replaces.
//   - tag/tags/regions array-membership filtering (&&, ANY(), unnest()) →
//     no SQL array type in SQLite, so these apply as a JS .filter() after
//     the SQL-filterable clauses (q, ingredientCategories, difficulty,
//     component, lang) have already narrowed the row set.
//   - ingredientCategories' `= ANY($N::uuid[])` → an IN (...) built from
//     one `$N` placeholder per value (see inPlaceholders below), so the
//     existing $N→? translation in db/local.ts handles it unmodified.
//   - ILIKE → LIKE.
//   - creator_id → dropped (no accounts table in standalone mode);
//     recipes.creator_name is a plain denormalized column set at create
//     time from the local profile's display name (see lib/standalone.ts).
//
// Deliberately NOT ported in this stage (narrow scope per the Seventeenth-
// slice plan) — nutrition, AI translation, LLM import, and collection
// membership all depend on services/tables outside Stage 1's boundary.
// Each throws a clear "not available offline yet" error instead of
// silently no-oping; localRouter.ts is what actually decides which paths
// route here at all.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne, withTransaction, inPlaceholders, type LocalClient } from "../db/local";
import { calculatePortions, resolveCookSequence } from "./matrioska.local";
import { computeAutoTagNames, unionTagNames } from "./tags.local";

function newId(): string {
  return crypto.randomUUID();
}

// SQLite enforces the FK columns below (recipe_ingredients.ingredient_id/
// sub_recipe_id/unit_id, recipes.yield_unit_id) strictly, unlike Postgres
// server mode's more forgiving history here — a stale id (an ingredient
// merged away, a unit that was never actually seeded on this device, ...)
// throws a bare "FOREIGN KEY constraint failed" that aborts the whole save
// with no indication of which field caused it. Checked defensively before
// every insert so a single bad reference just gets dropped (silently
// falls back to null/unset) instead of blocking the entire recipe from
// saving.
async function resolveExistingId(client: LocalClient, table: string, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const res = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id=$1`, [id]);
  return res.rows[0] ? id : null;
}

// Fire-and-forget — a sync failure (folder unreachable, permission not
// granted yet, etc.) must never surface as a save failure. Dynamically
// imported since gitSync.ts pulls in isomorphic-git/@capacitor/filesystem,
// which only matter on native (this whole file only ever runs there
// anyway, reached exclusively through localRouter.ts's standalone-mode
// dispatch — see lib/api.ts).
// Exported for ingredients.local.ts's mergeIngredients(): repointing
// recipe_ingredients.ingredient_id via raw SQL bypasses updateRecipe()'s
// normal path, so the affected recipes' entity files (which embed their
// full ingredients array per ADR 0002) need an explicit re-sync afterward
// or the merge would never propagate through Folder Sync to other devices.
export async function syncRecipe(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM recipes WHERE id=$1', [id]);
    if (!row) return;
    const ingredients = await query<Record<string, unknown>>('SELECT * FROM recipe_ingredients WHERE recipe_id=$1', [id]);
    const steps = await query<Record<string, unknown>>('SELECT * FROM recipe_steps WHERE recipe_id=$1', [id]);
    const toolRows = await query<{ tool_id: string }>('SELECT tool_id FROM recipe_tools WHERE recipe_id=$1', [id]);
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('recipes', id, { ...row, ingredients, steps, toolIds: toolRows.map(t => t.tool_id) });
  } catch (err) {
    console.error('SmartChef sync (recipe) failed:', err);
  }
}

/** Re-writes every local recipe's entity file regardless of whether
 *  anything actually changed — see ingredients.local.ts's
 *  resyncAllIngredients() for why this exists and where it's called from. */
export async function resyncAllRecipes(onProgress?: (done: number, total: number) => void): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM recipes WHERE sync_status != 'deleted'");
  for (let i = 0; i < rows.length; i++) {
    await syncRecipe(rows[i].id);
    onProgress?.(i + 1, rows.length);
  }
  return rows.length;
}


// ── Types ──────────────────────────────────────────────────────────────

export interface RecipeIngredientInput {
  sortOrder: number;
  ingredientId?: string;
  subtypeId?: string;
  subRecipeId?: string;
  quantity?: number;
  quantityText?: string;
  unitId?: string;
  notes?: string;
  isOptional?: boolean;
  /** Optional "Per il condimento"/"Per l'impasto" style header — ingredients
   *  sharing the same (non-null) groupName render under one heading in
   *  sortOrder position, distinct rows with groupName=null render ungrouped.
   *  See db/migrations/031_recipe_ingredient_groups.sql. */
  groupName?: string | null;
  translations?: Array<{ lang: string; notes?: string | null }>;
}

export interface RecipeStepInput {
  stepNumber: number;
  title?: string | null;
  description: string;
  durationMin?: number | null;
  toolIds?: string[];
  /** Cooking technique(s) this step uses (e.g. "Sautéing") — same shape as
   *  toolIds. See db/migrations/032_recipe_step_technique_ids.sql. */
  techniqueIds?: string[];
  notes?: string | null;
  imageUrl?: string | null;
  translations?: Array<{ lang: string; title?: string | null; description?: string | null; notes?: string | null }>;
  stepIngredients?: unknown[];
}

export interface RecipeInput {
  id?: string;
  title: string;
  description?: string | null;
  difficulty?: string;
  servings?: number;
  prepTimeMin?: number | null;
  cookTimeMin?: number | null;
  restTimeMin?: number | null;
  rating?: number | null;
  yieldAmount?: number | null;
  yieldUnitId?: string | null;
  tags?: string[];
  regions?: string[];
  regionCoords?: Record<string, { lat: number; lng: number }>;
  coverImageUrl?: string | null;
  sourceUrl?: string | null;
  sources?: unknown[];
  isComponent?: boolean;
  languageCode?: string;
  /** How to store leftovers ("Come conservare"). See
   *  db/migrations/033_recipe_storage_and_tips.sql. */
  storageInstructions?: string | null;
  /** General tips/notes distinct from the recipe's own short description. */
  tips?: string | null;
  ingredients?: RecipeIngredientInput[];
  steps?: RecipeStepInput[];
  toolIds?: string[];
  translations?: Array<{ lang: string; title?: string | null; description?: string | null }>;
}

// ── GET /recipes ───────────────────────────────────────────────────────

const SORT_OPTIONS: Record<string, string> = {
  "recently-edited": "r.updated_at DESC",
  "newest": "r.created_at DESC",
  "oldest": "r.created_at ASC",
  "alphabetical": "r.title ASC",
};

export interface ListRecipesParams {
  q?: string;
  tag?: string;
  tags?: string;
  ingredientCategories?: string;
  regions?: string;
  difficulty?: string;
  component?: string;
  lang?: string;
  sort?: string;
  /** "true" to only keep recipes whose seasonal-tagged ingredients are all
   *  in season for `seasonalMonth` (defaults to the current real month).
   *  An ingredient with no seasonality data never excludes a recipe — see
   *  db/migrations/034_ingredient_seasonality.sql. */
  seasonalOnly?: string;
  seasonalMonth?: string;
}

/** Looks up every distinct tag name at once (2 queries total, however many
 *  names are passed) instead of one query pair per name — the gallery list
 *  used to call this once per recipe with that recipe's own tagNames,
 *  which meant recipes × tags sequential round-trips through
 *  @capacitor-community/sqlite's plugin bridge. Each of those round-trips
 *  crosses into native code on Android with real per-call latency, so a
 *  library of even a few dozen tagged recipes made the gallery visibly
 *  slow. Callers now do ONE batch lookup across every tag name in the
 *  result set (see listRecipes below) and slice per recipe from the
 *  returned map. */
async function buildTagsDisplayBatch(allTagNames: string[], lang?: string): Promise<Map<string, { translated_name: string; color: string | null }>> {
  const uniqueLower = [...new Set(allTagNames.map(n => n.toLowerCase()))];
  const map = new Map<string, { translated_name: string; color: string | null }>();
  if (uniqueLower.length === 0) return map;

  const tagParams: unknown[] = [];
  const tags = await query<{ id: string; name: string; color: string | null }>(
    `SELECT id, name, color FROM tags WHERE lower(name) IN (${inPlaceholders(tagParams, uniqueLower)})`,
    tagParams
  );
  const tagIdByLowerName = new Map(tags.map(t => [t.name.toLowerCase(), t] as const));

  let translationByTagId = new Map<string, string>();
  if (lang && tags.length > 0) {
    const trParams: unknown[] = [];
    const idPlaceholders = inPlaceholders(trParams, tags.map(t => t.id));
    trParams.push(lang);
    const translations = await query<{ tag_id: string; name: string }>(
      `SELECT tag_id, name FROM tag_translations WHERE tag_id IN (${idPlaceholders}) AND LOWER(language_code) = LOWER($${trParams.length})`,
      trParams
    );
    translationByTagId = new Map(translations.map(t => [t.tag_id, t.name] as const));
  }

  for (const lowerName of uniqueLower) {
    const tag = tagIdByLowerName.get(lowerName);
    const translatedName = tag ? translationByTagId.get(tag.id) ?? null : null;
    map.set(lowerName, { translated_name: translatedName ?? tag?.name ?? lowerName, color: tag?.color ?? null });
  }
  return map;
}

function tagsDisplayFromBatch(tagNames: string[], batch: Map<string, { translated_name: string; color: string | null }>): Array<{ name: string; translated_name: string; color: string | null }> {
  return tagNames.map(name => {
    const entry = batch.get(name.toLowerCase());
    return { name, translated_name: entry?.translated_name ?? name, color: entry?.color ?? null };
  });
}

export async function listRecipes(params: ListRecipesParams) {
  const { q, tag, tags, ingredientCategories, regions, difficulty, component, lang, sort, seasonalOnly, seasonalMonth } = params;
  const sqlParams: unknown[] = [];
  let langJoin = "";
  let translatedCols = "NULL AS translated_title, NULL AS translated_description";
  if (lang) {
    sqlParams.push(lang);
    langJoin = `LEFT JOIN recipe_translations rt ON rt.recipe_id = r.id AND rt.language_code = $${sqlParams.length}`;
    translatedCols = "rt.title AS translated_title, rt.description AS translated_description";
  }

  let sql = `
    SELECT r.*, ${translatedCols},
           (SELECT COUNT(*) FROM recipe_ingredients cri2 WHERE cri2.recipe_id = r.id) AS ingredient_count,
           r.creator_name AS creator_name,
           -- Best-effort: creator_name is a plain denormalized string, not a
           -- profile FK (see the comment at the top of this file), so this
           -- can only match by name — a scalar subquery (not a JOIN) so two
           -- profiles sharing a name never duplicate this row. Picks the
           -- earliest-created match as a deterministic tie-break.
           (SELECT avatar_url FROM profiles cp WHERE cp.name = r.creator_name AND cp.deleted_at IS NULL ORDER BY cp.created_at LIMIT 1) AS creator_avatar_url
    FROM recipes r
    ${langJoin}
    WHERE r.sync_status != 'deleted'
  `;

  if (q) {
    sqlParams.push(`%${q}%`);
    const p = sqlParams.length;
    sql += ` AND (
      r.title LIKE $${p} OR r.description LIKE $${p} OR EXISTS (
        SELECT 1 FROM recipe_ingredients qri
        JOIN ingredients qi ON qi.id = qri.ingredient_id
        LEFT JOIN ingredient_translations qit ON qit.ingredient_id = qi.id
        WHERE qri.recipe_id = r.id AND (qi.name LIKE $${p} OR qit.translated_name LIKE $${p})
      )
    )`;
  }
  if (ingredientCategories) {
    const catList = ingredientCategories.split(",").map(c => c.trim()).filter(Boolean);
    if (catList.length > 0) {
      sql += ` AND EXISTS (
        SELECT 1 FROM recipe_ingredients cri
        JOIN ingredients ci ON ci.id = cri.ingredient_id
        WHERE cri.recipe_id = r.id AND ci.category_id IN (${inPlaceholders(sqlParams, catList)})
      )`;
    }
  }
  if (difficulty) {
    sqlParams.push(difficulty);
    sql += ` AND r.difficulty = $${sqlParams.length}`;
  }
  if (component !== undefined) {
    sqlParams.push(component === "true");
    sql += ` AND r.is_component = $${sqlParams.length}`;
  }

  const orderBy = sort === "alphabetical" && lang
    ? "COALESCE(rt.title, r.title) ASC"
    : SORT_OPTIONS[String(sort)] ?? SORT_OPTIONS["recently-edited"];
  sql += ` ORDER BY ${orderBy}`;

  let recipes = await query<Record<string, unknown>>(sql, sqlParams);

  // Array-membership filters have no SQL equivalent here — applied in JS
  // against the already-narrowed row set.
  if (tag) {
    recipes = recipes.filter(r => (JSON.parse((r.tags as string) ?? '[]') as string[]).includes(tag));
  }
  if (tags) {
    const tagList = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    if (tagList.length > 0) {
      recipes = recipes.filter(r => {
        const rTags = (JSON.parse((r.tags as string) ?? '[]') as string[]).map(t => t.toLowerCase());
        return tagList.some(t => rTags.includes(t));
      });
    }
  }
  if (regions) {
    const regionList = regions.split(",").map(r => r.trim()).filter(Boolean);
    if (regionList.length > 0) {
      recipes = recipes.filter(r => {
        const rRegions = JSON.parse((r.regions as string) ?? '[]') as string[];
        return regionList.some(reg => rRegions.includes(reg));
      });
    }
  }
  if (seasonalOnly === "true" && recipes.length > 0) {
    const month = seasonalMonth ? Number(seasonalMonth) : new Date().getMonth() + 1;
    const ids = recipes.map(r => r.id as string);
    const rows = await query<{ recipe_id: string; seasonal_months: string }>(
      `SELECT ri.recipe_id, ing.seasonal_months
       FROM recipe_ingredients ri
       JOIN ingredients ing ON ing.id = ri.ingredient_id
       WHERE ri.recipe_id IN (${inPlaceholders([], ids)})`,
      ids
    );
    const seasonalMonthsByRecipe = new Map<string, number[][]>();
    for (const row of rows) {
      const months = JSON.parse(row.seasonal_months ?? '[]') as number[];
      if (months.length === 0) continue; // no seasonality data -- never excludes a recipe
      const list = seasonalMonthsByRecipe.get(row.recipe_id) ?? [];
      list.push(months);
      seasonalMonthsByRecipe.set(row.recipe_id, list);
    }
    recipes = recipes.filter(r => {
      const ingredientMonthLists = seasonalMonthsByRecipe.get(r.id as string) ?? [];
      return ingredientMonthLists.every(months => months.includes(month));
    });
  }

  const perRecipeTagNames = recipes.map(r => JSON.parse((r.tags as string) ?? '[]') as string[]);
  const tagsBatch = await buildTagsDisplayBatch(perRecipeTagNames.flat(), lang);

  const result = recipes.map((r, i) => {
    const tagNames = perRecipeTagNames[i];
    return {
      ...r,
      tags: tagNames,
      tags_display: tagsDisplayFromBatch(tagNames, tagsBatch),
      regions: JSON.parse((r.regions as string) ?? '[]'),
      region_coords: JSON.parse((r.region_coords as string) ?? '{}'),
      sources: JSON.parse((r.sources as string) ?? '[]'),
    };
  });
  return { data: result, total: result.length };
}

// ── GET /recipes/:id ───────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getRecipe(id: string, lang?: string) {
  if (!UUID_RE.test(id)) return null;

  const params: unknown[] = [id];
  let langJoin = "";
  let translatedCols = "NULL AS translated_title, NULL AS translated_description";
  if (lang) {
    params.push(lang);
    langJoin = `LEFT JOIN recipe_translations rct ON rct.recipe_id = r.id AND LOWER(rct.language_code) = LOWER($2)`;
    translatedCols = "rct.title AS translated_title, rct.description AS translated_description";
  }

  const recipe = await queryOne<Record<string, unknown>>(
    `SELECT r.*, ${translatedCols}, r.creator_name AS creator_name,
            (SELECT avatar_url FROM profiles cp WHERE cp.name = r.creator_name AND cp.deleted_at IS NULL ORDER BY cp.created_at LIMIT 1) AS creator_avatar_url
     FROM recipes r
     ${langJoin}
     WHERE r.id = $1`,
    params
  );
  if (!recipe) return null;

  const tagNames = JSON.parse((recipe.tags as string) ?? '[]') as string[];
  const tagsDisplay = tagsDisplayFromBatch(tagNames, await buildTagsDisplayBatch(tagNames, lang));

  const translations = await query<{ language_code: string; title: string | null; description: string | null }>(
    `SELECT language_code, title, description FROM recipe_translations WHERE recipe_id = $1`,
    [id]
  );

  // ── Ingredients ──────────────────────────────────────────────────────
  const ingredientRows = await query<Record<string, unknown>>(
    `SELECT ri.*, i.name AS ingredient_name, i.plural_name AS ingredient_plural_name, sr.title AS sub_recipe_title, u.symbol AS unit_symbol
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u ON u.id = ri.unit_id
     WHERE ri.recipe_id = $1
     ORDER BY ri.sort_order`,
    [id]
  );
  const ingredients = [];
  for (const row of ingredientRows) {
    let ingredientName = row.ingredient_name as string | null;
    let ingredientPluralName = row.ingredient_plural_name as string | null;
    let translatedNotes: string | null = null;
    if (lang) {
      if (row.ingredient_id) {
        const it = await queryOne<{ translated_name: string; plural_translation: string | null }>(
          `SELECT translated_name, plural_translation FROM ingredient_translations WHERE ingredient_id = $1 AND LOWER(language_code) = LOWER($2)`,
          [row.ingredient_id, lang]
        );
        ingredientName = it?.translated_name ?? ingredientName;
        ingredientPluralName = it?.plural_translation ?? ingredientPluralName;
      }
      const rit = await queryOne<{ notes: string }>(
        `SELECT notes FROM recipe_ingredient_translations WHERE recipe_ingredient_id = $1 AND LOWER(language_code) = LOWER($2)`,
        [row.id, lang]
      );
      translatedNotes = rit?.notes ?? null;
    }
    const rowTranslations = await query<{ language_code: string; notes: string | null }>(
      `SELECT language_code, notes FROM recipe_ingredient_translations WHERE recipe_ingredient_id = $1`,
      [row.id]
    );
    ingredients.push({
      id: row.id,
      sortOrder: row.sort_order,
      ingredientId: row.ingredient_id,
      ingredientName,
      ingredientPluralName,
      subRecipeId: row.sub_recipe_id,
      subRecipeTitle: row.sub_recipe_title,
      quantity: row.quantity,
      quantityText: row.quantity_text,
      unitSymbol: row.unit_symbol,
      unitId: row.unit_id,
      isOptional: !!row.is_optional,
      notes: row.notes,
      // `ri.*` above already selects group_name, but it wasn't being copied
      // onto the returned object — added so the "Per il condimento" style
      // group headers (see RecipeIngredientInput.groupName above) actually
      // reach the frontend. camelCased to match this push block's existing
      // convention (ingredientName, unitSymbol, ...) and matrioska.local.ts's
      // CookSequenceIngredientRef.groupName.
      groupName: row.group_name as string | null,
      translatedNotes,
      translations: rowTranslations.map(t => ({ lang: t.language_code, notes: t.notes })),
    });
  }

  // ── Steps ────────────────────────────────────────────────────────────
  const stepRows = await query<Record<string, unknown>>(
    `SELECT * FROM recipe_steps WHERE recipe_id = $1 ORDER BY step_number`,
    [id]
  );
  const steps = [];
  for (const row of stepRows) {
    let translatedTitle: string | null = null;
    let translatedDescription: string | null = null;
    let translatedNotes: string | null = null;
    if (lang) {
      const rst = await queryOne<{ title: string | null; description: string | null; notes: string | null }>(
        `SELECT title, description, notes FROM recipe_step_translations WHERE step_id = $1 AND LOWER(language_code) = LOWER($2)`,
        [row.id, lang]
      );
      translatedTitle = rst?.title ?? null;
      translatedDescription = rst?.description ?? null;
      translatedNotes = rst?.notes ?? null;
    }
    const rowTranslations = await query<{ language_code: string; title: string | null; description: string | null; notes: string | null }>(
      `SELECT language_code, title, description, notes FROM recipe_step_translations WHERE step_id = $1`,
      [row.id]
    );
    steps.push({
      id: row.id,
      stepNumber: row.step_number,
      title: row.title,
      description: row.description,
      translatedTitle,
      translatedDescription,
      translatedNotes,
      durationMin: row.duration_min,
      toolIds: JSON.parse((row.tool_ids as string) ?? '[]'),
      techniqueIds: JSON.parse((row.technique_ids as string) ?? '[]'),
      notes: row.notes,
      imageUrl: row.image_url,
      stepIngredients: JSON.parse((row.step_ingredients as string) ?? '[]'),
      translations: rowTranslations.map(t => ({ lang: t.language_code, title: t.title, description: t.description, notes: t.notes })),
    });
  }

  // ── Tools ────────────────────────────────────────────────────────────
  const toolRows = await query<{ id: string; name: string; icon: string | null }>(
    `SELECT t.id, t.name, t.icon FROM recipe_tools rt JOIN tools t ON t.id = rt.tool_id WHERE rt.recipe_id = $1`,
    [id]
  );
  const tools = [];
  for (const t of toolRows) {
    const translatedName = lang
      ? (await queryOne<{ name: string }>(`SELECT name FROM tool_translations WHERE tool_id = $1 AND LOWER(language_code) = LOWER($2)`, [t.id, lang]))?.name ?? null
      : null;
    tools.push({ id: t.id, name: t.name, icon: t.icon, translated_name: translatedName });
  }

  // ── Techniques ───────────────────────────────────────────────────────
  // Every technique tagged on any step, resolved once here (not per-step)
  // so the recipe view can render a tappable technique chip the same way
  // it does for tools — mirrors the Tools section above exactly, just
  // sourced from steps[].techniqueIds instead of a recipe_tools join.
  const techniqueIdSet = new Set<string>();
  for (const s of steps) for (const tid of s.techniqueIds as string[]) techniqueIdSet.add(tid);
  const techniques = [];
  for (const techniqueId of techniqueIdSet) {
    const t = await queryOne<{ id: string; name: string; icon: string | null }>(
      `SELECT id, name, icon FROM techniques WHERE id = $1 AND deleted_at IS NULL`,
      [techniqueId]
    );
    if (!t) continue;
    const translatedName = lang
      ? (await queryOne<{ name: string }>(`SELECT name FROM technique_translations WHERE technique_id = $1 AND LOWER(language_code) = LOWER($2)`, [t.id, lang]))?.name ?? null
      : null;
    techniques.push({ id: t.id, name: t.name, icon: t.icon, translated_name: translatedName });
  }

  return {
    ...recipe,
    tags: tagNames,
    tags_display: tagsDisplay,
    regions: JSON.parse((recipe.regions as string) ?? '[]'),
    region_coords: JSON.parse((recipe.region_coords as string) ?? '{}'),
    sources: JSON.parse((recipe.sources as string) ?? '[]'),
    translations: translations.map(t => ({ lang: t.language_code, title: t.title, description: t.description })),
    ingredients,
    steps,
    tools,
    techniques,
  };
}

// ── Shared create/update logic ────────────────────────────────────────

async function upsertRecipeTranslations(client: LocalClient, recipeId: string, translations?: RecipeInput['translations']) {
  if (!translations) return;
  await client.query("DELETE FROM recipe_translations WHERE recipe_id=$1", [recipeId]);
  for (const t of translations) {
    if (!t.lang || (!t.title && !t.description)) continue;
    await client.query(
      `INSERT INTO recipe_translations (id, recipe_id, language_code, title, description) VALUES ($1, $2, $3, $4, $5)`,
      [newId(), recipeId, t.lang, t.title || null, t.description || null]
    );
  }
}

async function insertStepTranslations(client: LocalClient, stepId: string, translations?: RecipeStepInput['translations']) {
  if (!translations) return;
  for (const t of translations) {
    if (!t.lang || (!t.title && !t.description && !t.notes)) continue;
    await client.query(
      `INSERT INTO recipe_step_translations (id, step_id, language_code, title, description, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), stepId, t.lang, t.title || null, t.description || null, t.notes || null]
    );
  }
}

async function insertIngredientTranslations(client: LocalClient, recipeIngredientId: string, translations?: RecipeIngredientInput['translations']) {
  if (!translations) return;
  for (const t of translations) {
    if (!t.lang || !t.notes) continue;
    await client.query(
      `INSERT INTO recipe_ingredient_translations (id, recipe_ingredient_id, language_code, notes) VALUES ($1, $2, $3, $4)`,
      [newId(), recipeIngredientId, t.lang, t.notes]
    );
  }
}

// ── POST /recipes ──────────────────────────────────────────────────────


/** Starts the Hidden Clone write for `id` WITHOUT blocking the caller.
 *
 *  Every user-facing save used to `await syncRecipe(id)`, which meant the
 *  save waited on gitSync's single shared queue. Nothing in the sync
 *  transports has a timeout (verified across nativeHttpClient,
 *  gitRemoteTransport, electronRemoteTransport, androidRemoteTransport), so
 *  one push or fetch against an unreachable or merely very slow remote
 *  holds that queue indefinitely — and every subsequent save then blocks
 *  forever. In the UI that is a hard freeze: RecipeDetail.tsx's handleSave
 *  never reaches setMode('view') or its `finally` setSaving(false), so the
 *  editor stays open with a spinning button and the recipe looks unsaved
 *  even though SQLite already committed it.
 *
 *  syncRecipe() already swallows its own errors — the intent that "a sync
 *  failure must never surface as a save failure" was always there, it just
 *  didn't cover a sync that never finishes. Not awaiting is what actually
 *  delivers it.
 *
 *  The trade-off: if the app is closed in the seconds between the SQLite
 *  write and the entity-file write, that recipe's change stays local until
 *  it's edited again or resyncAllRecipes() runs (Account -> Change Folder).
 *  The commit was already debounced 2s behind this point, so that exposure
 *  existed regardless; this only widens it slightly, and it is strictly
 *  better than freezing the editor. */
function syncRecipeInBackground(id: string): void {
  void syncRecipe(id);
}

export async function createRecipe(d: RecipeInput, creatorName: string | null): Promise<{ id: string }> {
  const recipeId = d.id ?? newId();

  await withTransaction(async (client) => {
    const yieldUnitId = await resolveExistingId(client, 'units', d.yieldUnitId);
    await client.query(
      `INSERT INTO recipes (id,title,description,difficulty,servings,prep_time_min,
         cook_time_min,rest_time_min,rating,yield_amount,yield_unit_id,tags,regions,region_coords,cover_image_url,source_url,sources,is_component,language_code,creator_name,storage_instructions,tips)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [recipeId, d.title, d.description ?? null, d.difficulty ?? 'medium', d.servings ?? 4, d.prepTimeMin ?? null,
       d.cookTimeMin ?? null, d.restTimeMin ?? null, d.rating ?? null, d.yieldAmount ?? null, yieldUnitId,
       d.tags ?? [], d.regions ?? [], d.regionCoords ?? {}, d.coverImageUrl ?? null, d.sourceUrl ?? null,
       d.sources ?? [], d.isComponent ?? false, d.languageCode ?? null, creatorName,
       d.storageInstructions ?? null, d.tips ?? null]
    );

    for (const ing of d.ingredients ?? []) {
      const recipeIngredientId = newId();
      const ingredientId = await resolveExistingId(client, 'ingredients', ing.ingredientId);
      const subRecipeId = await resolveExistingId(client, 'recipes', ing.subRecipeId);
      const unitId = await resolveExistingId(client, 'units', ing.unitId);
      await client.query(
        `INSERT INTO recipe_ingredients
           (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
            quantity,quantity_text,unit_id,notes,is_optional,group_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [recipeIngredientId, recipeId, ing.sortOrder, ingredientId,
         ing.subtypeId ?? null, subRecipeId, ing.quantity ?? null,
         ing.quantityText ?? null, unitId, ing.notes ?? null, ing.isOptional ?? false,
         ing.groupName ?? null]
      );
      await insertIngredientTranslations(client, recipeIngredientId, ing.translations);
    }

    for (const step of d.steps ?? []) {
      const stepId = newId();
      await client.query(
        `INSERT INTO recipe_steps
           (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,image_url,step_ingredients,technique_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [stepId, recipeId, step.stepNumber, step.title ?? null,
         step.description, step.durationMin ?? null, step.toolIds ?? [], step.notes ?? null,
         step.imageUrl ?? null, step.stepIngredients ?? [], step.techniqueIds ?? []]
      );
      await insertStepTranslations(client, stepId, step.translations);
    }

    for (const toolId of d.toolIds ?? []) {
      if (!(await resolveExistingId(client, 'tools', toolId))) continue;
      await client.query(
        "INSERT INTO recipe_tools (recipe_id,tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [recipeId, toolId]
      );
    }

    const autoTags = await computeAutoTagNames(client, recipeId);
    const finalTags = unionTagNames(d.tags ?? [], autoTags);
    await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, recipeId]);

    await upsertRecipeTranslations(client, recipeId, d.translations);
  });

  syncRecipeInBackground(recipeId);
  return { id: recipeId };
}

// ── PUT /recipes/:id ──────────────────────────────────────────────────

export async function updateRecipe(id: string, d: RecipeInput): Promise<{ id: string }> {
  // Split timing: the SQLite writes below are proportional to the recipe's
  // own size, while syncRecipe() is not — it goes through gitSync's single
  // shared queue, so it can block for seconds behind an unrelated commit or
  // sync cycle no matter how small the recipe is. See gitSync.ts's
  // logIfSlow(). Only prints when something is actually slow.
  const { logIfSlow } = await import('../lib/sync/gitSync');
  const dbStartedAt = performance.now();
  await withTransaction(async (client) => {
    const yieldUnitId = await resolveExistingId(client, 'units', d.yieldUnitId);
    await client.query(
      `UPDATE recipes SET
         title=$2, description=$3, difficulty=$4, servings=$5,
         prep_time_min=$6, cook_time_min=$7, rest_time_min=$8, rating=$9,
         yield_amount=$10, yield_unit_id=$11, tags=$12, regions=$13, region_coords=$14, cover_image_url=$15, source_url=$16, sources=$17, is_component=$18,
         language_code=$19, storage_instructions=$20, tips=$21, updated_at=now()
       WHERE id=$1`,
      [id, d.title, d.description ?? null, d.difficulty ?? 'medium', d.servings ?? 4, d.prepTimeMin ?? null,
       d.cookTimeMin ?? null, d.restTimeMin ?? null, d.rating ?? null, d.yieldAmount ?? null, yieldUnitId,
       d.tags ?? [], d.regions ?? [], d.regionCoords ?? {}, d.coverImageUrl ?? null, d.sourceUrl ?? null, d.sources ?? [], d.isComponent ?? false,
       d.languageCode ?? null, d.storageInstructions ?? null, d.tips ?? null]
    );

    await client.query("DELETE FROM recipe_ingredients WHERE recipe_id=$1", [id]);
    for (const ing of d.ingredients ?? []) {
      const recipeIngredientId = newId();
      const ingredientId = await resolveExistingId(client, 'ingredients', ing.ingredientId);
      // A sub-recipe referencing itself can't be inserted anyway (this row
      // isn't committed yet within this same UPDATE), so treat that the
      // same as any other dangling reference rather than a special case.
      const subRecipeId = ing.subRecipeId === id ? null : await resolveExistingId(client, 'recipes', ing.subRecipeId);
      const unitId = await resolveExistingId(client, 'units', ing.unitId);
      await client.query(
        `INSERT INTO recipe_ingredients
           (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
            quantity,quantity_text,unit_id,notes,is_optional,group_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [recipeIngredientId, id, ing.sortOrder, ingredientId,
         ing.subtypeId ?? null, subRecipeId, ing.quantity ?? null,
         ing.quantityText ?? null, unitId, ing.notes ?? null, ing.isOptional ?? false,
         ing.groupName ?? null]
      );
      await insertIngredientTranslations(client, recipeIngredientId, ing.translations);
    }

    await client.query("DELETE FROM recipe_steps WHERE recipe_id=$1", [id]);
    for (const step of d.steps ?? []) {
      const stepId = newId();
      await client.query(
        `INSERT INTO recipe_steps
           (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,image_url,step_ingredients,technique_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [stepId, id, step.stepNumber, step.title ?? null,
         step.description, step.durationMin ?? null, step.toolIds ?? [], step.notes ?? null,
         step.imageUrl ?? null, step.stepIngredients ?? [], step.techniqueIds ?? []]
      );
      await insertStepTranslations(client, stepId, step.translations);
    }

    await client.query("DELETE FROM recipe_tools WHERE recipe_id=$1", [id]);
    for (const toolId of d.toolIds ?? []) {
      if (!(await resolveExistingId(client, 'tools', toolId))) continue;
      await client.query(
        "INSERT INTO recipe_tools (recipe_id,tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, toolId]
      );
    }

    const autoTags = await computeAutoTagNames(client, id);
    const finalTags = unionTagNames(d.tags ?? [], autoTags);
    await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, id]);

    await upsertRecipeTranslations(client, id, d.translations);
  });

  logIfSlow('updateRecipe db writes', dbStartedAt, `${(d.ingredients ?? []).length} ingredients, ${(d.steps ?? []).length} steps`);

  syncRecipeInBackground(id);
  return { id };
}

// ── PATCH /recipes/:id/rating ──────────────────────────────────────────

export async function patchRating(id: string, rating: number | null): Promise<void> {
  await query("UPDATE recipes SET rating=$1, updated_at=now() WHERE id=$2", [rating, id]);
}

// ── POST /recipes/:id/cooked ───────────────────────────────────────────
// No RETURNING here (unlike the server route) — SQLite's `run()` doesn't
// reliably surface RETURNING columns through this plugin, so this does the
// increment and the read-back as two plain statements instead. Same net
// effect, doesn't touch updated_at (cooking a recipe isn't editing it).

export async function logCooked(id: string, cookedByName: string | null): Promise<{ timesCooked: number } | null> {
  const existing = await queryOne<{ times_cooked: number }>("SELECT times_cooked FROM recipes WHERE id=$1", [id]);
  if (!existing) return null;
  const timesCooked = existing.times_cooked + 1;
  await query("UPDATE recipes SET times_cooked = $1 WHERE id=$2", [timesCooked, id]);
  await query("INSERT INTO cook_log (id, recipe_id, cooked_by_name) VALUES ($1, $2, $3)", [newId(), id, cookedByName]);
  return { timesCooked };
}

// ── DELETE /recipes/:id ────────────────────────────────────────────────

export async function deleteRecipe(id: string): Promise<void> {
  await query("UPDATE recipes SET sync_status='deleted', updated_at=now() WHERE id=$1", [id]);
  // Written out (not removed) so the deletion itself propagates through
  // sync — a file simply vanishing from the folder can't be told apart
  // from "another device hasn't created it yet" by a device that pulls
  // later, whereas a row with sync_status='deleted' unambiguously can.
  syncRecipeInBackground(id);
}

// ── Portions / cook-sequence ────────────────────────────────────────────

export async function getPortions(id: string, servings: number) {
  return calculatePortions(id, servings);
}

export async function getCookSequenceFor(id: string) {
  return { sections: await resolveCookSequence(id) };
}

// ── Not yet ported (Stage 2+) ──────────────────────────────────────────

export function notAvailableOffline(feature: string): never {
  throw new Error(`"${feature}" isn't available in offline mode yet — connect to a server to use it.`);
}
