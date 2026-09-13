// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone-mode backup import
// Accepts the same whole-library snapshot format the server's
// GET /api/backup/export produces (backend/src/services/folder-sync.service.ts's
// Snapshot shape) and loads it into this device's local SQLite store —
// the standalone-mode counterpart to backend/src/routes/backup.ts's
// mergeSnapshot(), but simpler: this is a one-time "bring my existing
// library into a fresh device" import, not a continuous two-way sync (that's
// what Folder Sync / lib/sync/gitSync.ts is for).
//
// ingredients/tools/techniques/recipes: re-importing an id that already
// exists locally *overwrites* it with the file's version (reuses the same
// updateIngredient()/updateTool()/updateRecipe() the normal edit UI calls) —
// matches the Backup & Restore card's own stated behavior ("restoring merges
// it back in, newest wins") and means re-running an import after fixing
// something in the export (e.g. adding embedded images) actually takes
// effect instead of silently no-op'ing against what's already there.
// categories/tags stay skip-only (matched by id or name, see
// existsByName()) — pure catalog/reference rows with no meaningful "newer
// version" to apply, and skip-by-name is what makes the seeded starter
// catalog and an imported one resolve to the same local rows at all.
//
// Units are deliberately NOT imported as their own entity — the snapshot
// format never included them (see folder-sync.service.ts: recipe
// ingredients reference a unit by `unitSymbol`, not a unit id), since the
// small fixed set of units (g, kg, ml, tsp, ...) is expected to already
// exist via db/local.ts's own starter seed. A symbol with no local match
// just leaves that ingredient line's unit blank rather than failing the
// whole import.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import * as ingredientsLocal from './ingredients.local';
import * as recipesLocal from './recipes.local';
import { decodeDataUri, isInlineDataUri, storeImage } from '../lib/localImages';

function newId(): string {
  return crypto.randomUUID();
}

/** The snapshot format embeds images as `data:` URIs, and this used to write
 *  them straight into the column — which is how a restored library ended up
 *  with whole photos inside `recipes.cover_image_url` and
 *  `recipe_steps.image_url`. Every read then dragged them back out, and in
 *  standalone mode a read crosses the Capacitor bridge (see
 *  lib/inlineImageMigration.ts for the measured cost).
 *
 *  Any other value — a remote URL, a bundled asset path, an already-stored
 *  `images/<hash>` path, null — passes through untouched. A decode or write
 *  failure falls back to keeping the original inline value: a bloated image
 *  that works beats a restore that loses one. */
async function intoImageStore(value: string | null | undefined): Promise<string | null | undefined> {
  if (!isInlineDataUri(value)) return value;
  try {
    const { bytes, extHint } = decodeDataUri(value as string);
    return await storeImage(bytes, extHint);
  } catch (err) {
    console.error('SmartChef: could not move a restored image into local storage, keeping it inline:', err);
    return value;
  }
}

interface SnapshotTranslation { lang: string; name?: string | null; description?: string | null }

export interface Snapshot {
  formatVersion?: number;
  categories?: Array<{
    id: string; name: string; description?: string | null; icon?: string | null; color?: string | null;
    deletedAt?: string | null; translations?: SnapshotTranslation[];
  }>;
  tags?: Array<{
    id: string; name: string; groupName?: string; color?: string | null; icon?: string | null;
    excludeTagIds?: string[]; sortOrder?: number; deletedAt?: string | null;
    translations?: Array<{ lang: string; name?: string | null }>;
  }>;
  ingredients?: Array<{
    id: string; name: string; categoryId: string; description?: string | null; icon?: string | null;
    imageUrls?: string[]; tagIds?: string[]; deletedAt?: string | null;
    caloriesKcal?: number | null; proteinG?: number | null; carbsG?: number | null; fatG?: number | null;
    fiberG?: number | null; sugarG?: number | null; sodiumMg?: number | null; seasonalMonths?: number[];
    translations?: Array<{ lang: string; text: string }>;
  }>;
  tools?: Array<{
    id: string; name: string; category?: string | null; description?: string | null; icon?: string | null;
    imageUrls?: string[]; deletedAt?: string | null; translations?: SnapshotTranslation[];
  }>;
  techniques?: Array<{
    id: string; name: string; description?: string | null; icon?: string | null; imageUrls?: string[];
    deletedAt?: string | null; translations?: SnapshotTranslation[];
  }>;
  recipes?: Array<{
    id: string; title: string; description?: string | null; difficulty?: string; servings?: number;
    prepTimeMin?: number | null; cookTimeMin?: number | null; restTimeMin?: number | null; rating?: number | null;
    tags?: string[]; coverImageUrl?: string | null; sourceUrl?: string | null; sources?: unknown[];
    isComponent?: boolean; languageCode?: string | null; deletedAt?: string | null;
    storageInstructions?: string | null; tips?: string | null;
    ingredients?: Array<{
      sortOrder: number; ingredientId?: string; subRecipeId?: string; quantity?: number | null;
      quantityText?: string | null; unitSymbol?: string | null; notes?: string | null; isOptional?: boolean;
      groupName?: string | null;
      /** sortOrder of the ingredient this row is an alternative to — see
       *  db/migrations/042_recipe_ingredient_substitutes.sql. A backup that
       *  dropped it would restore the substitutes as extra ingredients. */
      substituteFor?: number | null;
      translations?: Array<{ lang: string; notes?: string | null }>;
    }>;
    steps?: Array<{
      stepNumber: number; title?: string | null; description: string; durationMin?: number | null;
      toolIds?: string[]; techniqueIds?: string[]; notes?: string | null; imageUrl?: string | null; stepIngredients?: unknown;
      translations?: Array<{ lang: string; title?: string | null; description?: string | null }>;
    }>;
    toolIds?: string[];
    translations?: Array<{ lang: string; title?: string | null; description?: string | null }>;
  }>;
}

export interface ImportSummary {
  categories: number; tags: number; ingredients: number; tools: number; techniques: number; recipes: number;
  // Always empty — standalone import never overwrites an existing local
  // row (every entity is skipped if its id already exists, see the module
  // docstring above), so there's nothing to report a conflict on. Present
  // only so this matches the server-mode SyncSummary shape Account.tsx's
  // SyncSummaryPanel expects — that component reads conflicts.length
  // unconditionally, and crashed on this field being absent.
  conflicts: string[];
}

async function existsById(table: string, id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE id=$1`, [id]);
  return !!row;
}

// Categories collide on name, not just id: db/local.ts seeds a starter
// catalog (initLocalSchema()'s SEED_SQL) using the same category names as
// the server's own seed migration, but with freshly locally-generated ids —
// so a snapshot category with the same name but a different (server-side)
// id passes the id-based existsById() check yet still trips
// ingredient_categories' `UNIQUE(name) WHERE deleted_at IS NULL` index,
// throwing and aborting the entire import partway through (categories are
// processed first). Treat an existing same-name category as the same
// real-world category and skip it, exactly like an id match — matching
// the exact-string collation the actual unique index uses.
/** Returns the existing row's local id if a same-name match exists, else
 *  null. Beyond just "should I skip creating this row" (existsById's job),
 *  callers here also need the *local* id a same-name match actually has —
 *  see the categoryIdRemap/tagIdRemap usage below: a snapshot category/tag
 *  skipped because it matches an existing seeded row by name still gets
 *  referenced by its *original* (server-side) id from every ingredient
 *  that points at it, which doesn't exist locally under that id anymore —
 *  silently fine while this DB had no FK enforcement, but this app's real
 *  SQLite engine does enforce foreign keys, so an unresolved reference
 *  fails the whole import with "FOREIGN KEY constraint failed" the moment
 *  the first such ingredient tries to insert. */
async function existsByName(table: string, name: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE name=$1`, [name]);
  return row?.id ?? null;
}

/** Orders recipes so a sub-recipe (Matrioska) always comes before any
 *  recipe that references it via subRecipeId — Postgres's `SELECT * FROM
 *  recipes` has no defined row order, so a component recipe can easily
 *  land after the recipe that uses it. Depth-first post-order (classic
 *  topo sort); a genuine cycle can't happen in practice (a recipe can't
 *  meaningfully contain itself), but visited-tracking makes one harmless
 *  either way instead of infinite-looping. */
function topoSortBySubRecipe(recipes: NonNullable<Snapshot['recipes']>): NonNullable<Snapshot['recipes']> {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const visited = new Set<string>();
  const ordered: NonNullable<Snapshot['recipes']> = [];
  const visit = (r: NonNullable<Snapshot['recipes']>[number]) => {
    if (visited.has(r.id)) return;
    visited.add(r.id);
    for (const ing of r.ingredients ?? []) {
      const sub = ing.subRecipeId ? byId.get(ing.subRecipeId) : undefined;
      if (sub) visit(sub);
    }
    ordered.push(r);
  };
  for (const r of recipes) visit(r);
  return ordered;
}

const unitIdBySymbol = new Map<string, string | null>();
async function resolveUnitId(symbol?: string | null): Promise<string | undefined> {
  if (!symbol) return undefined;
  if (!unitIdBySymbol.has(symbol)) {
    const row = await queryOne<{ id: string }>('SELECT id FROM units WHERE symbol=$1', [symbol]);
    unitIdBySymbol.set(symbol, row?.id ?? null);
  }
  return unitIdBySymbol.get(symbol) ?? undefined;
}

/** Standalone-mode counterpart to backend/src/routes/backup.ts's GET
 *  /backup/export — produces the same Snapshot shape importSnapshot() above
 *  accepts (and that the server's own export/import round-trips), read
 *  straight off the local SQLite tables. Soft-deleted rows are left out
 *  entirely rather than exported as tombstones: importSnapshot() already
 *  skips anything with `deletedAt` set (see its `if (X.deletedAt) continue`
 *  checks above), so a tombstone would just be dead weight in the file —
 *  Folder Sync, not this file, is what actually propagates deletions
 *  between devices. */
/** Every row of a child table, grouped by the foreign key that ties it to
 *  its parent, in a single query.
 *
 *  The export takes the whole library, so there is nothing to filter and no
 *  parent ids to pass — which makes the per-parent loop this replaces pure
 *  cost. It used to issue one query per category, tag, ingredient, tool and
 *  technique, then per recipe another for its ingredients, its steps, its
 *  tools and its translations, plus one per ingredient row for that row's
 *  own translations and one more for its unit. On a 49-recipe library that
 *  is several hundred sequential reads, each one a Capacitor bridge
 *  round-trip in standalone mode, for a button the user is already waiting
 *  on. */
async function groupByKey<T extends Record<string, unknown>>(
  sql: string,
  key: string,
): Promise<Map<string, T[]>> {
  const grouped = new Map<string, T[]>();
  for (const row of await query<T>(sql)) {
    const id = row[key] as string;
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

export async function exportSnapshot(): Promise<Snapshot> {
  // Parents and children together, all batched. Each child SELECT orders by
  // parent then position, so the grouped lists come out in the order the
  // Snapshot wants without re-sorting.
  const [
    categoryRows, tagRows, ingredientRows, toolRows, techniqueRows, recipeRows,
    categoryTranslations, tagTranslations, ingredientTranslations, ingredientTagRows,
    toolTranslations, techniqueTranslations,
    recipeIngredientRows, riTranslations, unitRows,
    stepRows, stepTranslations, recipeToolRows, recipeTranslations,
  ] = await Promise.all([
    query<Record<string, unknown>>('SELECT * FROM ingredient_categories WHERE deleted_at IS NULL'),
    query<Record<string, unknown>>('SELECT * FROM tags WHERE deleted_at IS NULL'),
    query<Record<string, unknown>>("SELECT * FROM ingredients WHERE sync_status != 'deleted'"),
    query<Record<string, unknown>>('SELECT * FROM tools WHERE deleted_at IS NULL'),
    query<Record<string, unknown>>('SELECT * FROM techniques WHERE deleted_at IS NULL'),
    query<Record<string, unknown>>("SELECT * FROM recipes WHERE sync_status != 'deleted'"),
    groupByKey<{ category_id: string; language_code: string; name: string | null; description: string | null }>(
      'SELECT category_id, language_code, name, description FROM ingredient_category_translations', 'category_id'),
    groupByKey<{ tag_id: string; language_code: string; name: string | null }>(
      'SELECT tag_id, language_code, name FROM tag_translations', 'tag_id'),
    groupByKey<{ ingredient_id: string; language_code: string; translated_name: string }>(
      'SELECT ingredient_id, language_code, translated_name FROM ingredient_translations', 'ingredient_id'),
    groupByKey<{ ingredient_id: string; tag_id: string }>(
      'SELECT ingredient_id, tag_id FROM ingredient_tags', 'ingredient_id'),
    groupByKey<{ tool_id: string; language_code: string; name: string | null; description: string | null }>(
      'SELECT tool_id, language_code, name, description FROM tool_translations', 'tool_id'),
    groupByKey<{ technique_id: string; language_code: string; name: string | null; description: string | null }>(
      'SELECT technique_id, language_code, name, description FROM technique_translations', 'technique_id'),
    groupByKey<Record<string, unknown>>(
      'SELECT * FROM recipe_ingredients ORDER BY recipe_id, sort_order', 'recipe_id'),
    groupByKey<{ recipe_ingredient_id: string; language_code: string; notes: string | null }>(
      'SELECT recipe_ingredient_id, language_code, notes FROM recipe_ingredient_translations', 'recipe_ingredient_id'),
    query<{ id: string; symbol: string }>('SELECT id, symbol FROM units'),
    groupByKey<Record<string, unknown>>(
      'SELECT * FROM recipe_steps ORDER BY recipe_id, step_number', 'recipe_id'),
    groupByKey<{ step_id: string; language_code: string; title: string | null; description: string | null }>(
      'SELECT step_id, language_code, title, description FROM recipe_step_translations', 'step_id'),
    groupByKey<{ recipe_id: string; tool_id: string }>(
      'SELECT recipe_id, tool_id FROM recipe_tools', 'recipe_id'),
    groupByKey<{ recipe_id: string; language_code: string; title: string | null; description: string | null }>(
      'SELECT recipe_id, language_code, title, description FROM recipe_translations', 'recipe_id'),
  ]);

  const unitSymbolById = new Map(unitRows.map(u => [u.id, u.symbol]));

  const categories: NonNullable<Snapshot['categories']> = categoryRows.map(c => ({
    id: c.id as string, name: c.name as string, description: c.description as string | null, icon: c.icon as string | null, color: c.color as string | null,
    translations: (categoryTranslations.get(c.id as string) ?? []).map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
  }));

  const tags: NonNullable<Snapshot['tags']> = tagRows.map(t => ({
    id: t.id as string, name: t.name as string, groupName: t.group_name as string, color: t.color as string | null, icon: t.icon as string | null,
    excludeTagIds: JSON.parse((t.exclude_tag_ids as string) ?? '[]'), sortOrder: t.sort_order as number,
    translations: (tagTranslations.get(t.id as string) ?? []).map(tr => ({ lang: tr.language_code, name: tr.name })),
  }));

  const ingredients: NonNullable<Snapshot['ingredients']> = ingredientRows.map(i => ({
    id: i.id as string, name: i.name as string, categoryId: i.category_id as string, description: i.description as string | null, icon: i.icon as string | null,
    imageUrls: JSON.parse((i.image_urls as string) ?? '[]'),
    tagIds: (ingredientTagRows.get(i.id as string) ?? []).map(r => r.tag_id),
    caloriesKcal: i.calories_kcal as number | null, proteinG: i.protein_g as number | null, carbsG: i.carbs_g as number | null, fatG: i.fat_g as number | null,
    fiberG: i.fiber_g as number | null, sugarG: i.sugar_g as number | null, sodiumMg: i.sodium_mg as number | null,
    seasonalMonths: JSON.parse((i.seasonal_months as string) ?? '[]'),
    translations: (ingredientTranslations.get(i.id as string) ?? []).map(t => ({ lang: t.language_code, text: t.translated_name })),
  }));

  const tools: NonNullable<Snapshot['tools']> = toolRows.map(tool => ({
    id: tool.id as string, name: tool.name as string, category: tool.category as string | null, description: tool.description as string | null, icon: tool.icon as string | null,
    imageUrls: JSON.parse((tool.image_urls as string) ?? '[]'),
    translations: (toolTranslations.get(tool.id as string) ?? []).map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
  }));

  const techniques: NonNullable<Snapshot['techniques']> = techniqueRows.map(tech => ({
    id: tech.id as string, name: tech.name as string, description: tech.description as string | null, icon: tech.icon as string | null,
    imageUrls: JSON.parse((tech.image_urls as string) ?? '[]'),
    translations: (techniqueTranslations.get(tech.id as string) ?? []).map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
  }));

  const recipes: NonNullable<Snapshot['recipes']> = recipeRows.map(r => ({
    id: r.id as string, title: r.title as string, description: r.description as string | null, difficulty: r.difficulty as string, servings: r.servings as number,
    prepTimeMin: r.prep_time_min as number | null, cookTimeMin: r.cook_time_min as number | null, restTimeMin: r.rest_time_min as number | null, rating: r.rating as number | null,
    tags: JSON.parse((r.tags as string) ?? '[]'), coverImageUrl: r.cover_image_url as string | null, sourceUrl: r.source_url as string | null,
    sources: JSON.parse((r.sources as string) ?? '[]'), isComponent: !!r.is_component, languageCode: r.language_code as string | null,
    storageInstructions: r.storage_instructions as string | null, tips: r.tips as string | null,
    ingredients: (recipeIngredientRows.get(r.id as string) ?? []).map(ri => ({
      sortOrder: ri.sort_order as number, ingredientId: (ri.ingredient_id as string) ?? undefined, subRecipeId: (ri.sub_recipe_id as string) ?? undefined,
      quantity: ri.quantity as number | null, quantityText: ri.quantity_text as string | null,
      unitSymbol: ri.unit_id ? unitSymbolById.get(ri.unit_id as string) ?? null : null,
      notes: ri.notes as string | null, isOptional: !!ri.is_optional, groupName: ri.group_name as string | null,
      substituteFor: (ri.substitute_for as number | null) ?? null,
      translations: (riTranslations.get(ri.id as string) ?? []).map(t => ({ lang: t.language_code, notes: t.notes })),
    })),
    steps: (stepRows.get(r.id as string) ?? []).map(st => ({
      stepNumber: st.step_number as number, title: st.title as string | null, description: st.description as string, durationMin: st.duration_min as number | null,
      toolIds: JSON.parse((st.tool_ids as string) ?? '[]'), techniqueIds: JSON.parse((st.technique_ids as string) ?? '[]'),
      notes: st.notes as string | null, imageUrl: st.image_url as string | null,
      stepIngredients: JSON.parse((st.step_ingredients as string) ?? '[]'),
      translations: (stepTranslations.get(st.id as string) ?? []).map(t => ({ lang: t.language_code, title: t.title, description: t.description })),
    })),
    toolIds: (recipeToolRows.get(r.id as string) ?? []).map(t => t.tool_id),
    translations: (recipeTranslations.get(r.id as string) ?? []).map(t => ({ lang: t.language_code, title: t.title, description: t.description })),
  }));

  return { formatVersion: 1, categories, tags, ingredients, tools, techniques, recipes };
}

export async function importSnapshot(snapshot: Snapshot): Promise<ImportSummary> {
  const summary: ImportSummary = { categories: 0, tags: 0, ingredients: 0, tools: 0, techniques: 0, recipes: 0, conflicts: [] };

  // snapshot id -> the actual local id a same-name match resolved to, for
  // every category/tag this import *didn't* create fresh under its own
  // (server-side) id — see existsByName()'s docstring above.
  const categoryIdRemap = new Map<string, string>();
  const tagIdRemap = new Map<string, string>();

  for (const c of snapshot.categories ?? []) {
    if (c.deletedAt || (await existsById('ingredient_categories', c.id))) continue;
    const existingId = await existsByName('ingredient_categories', c.name);
    if (existingId) {
      categoryIdRemap.set(c.id, existingId);
      continue;
    }
    await ingredientsLocal.createCategory({
      id: c.id, name: c.name, description: c.description, icon: c.icon, color: c.color,
      translations: c.translations,
    });
    summary.categories++;
  }

  for (const t of snapshot.tags ?? []) {
    // Same name-collision risk as ingredient_categories above (tags also
    // has `UNIQUE(name) WHERE deleted_at IS NULL`) — nothing pre-seeds it
    // today, but a re-import against a device that already created a
    // same-named tag independently would hit it, so guard it the same way.
    if (t.deletedAt || (await existsById('tags', t.id))) continue;
    const existingId = await existsByName('tags', t.name);
    if (existingId) {
      tagIdRemap.set(t.id, existingId);
      continue;
    }
    await query(
      `INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.id, t.name, t.groupName || 'Altro', t.color ?? null, t.icon ?? null, t.excludeTagIds ?? [], t.sortOrder ?? 0]
    );
    for (const tr of t.translations ?? []) {
      if (!tr.lang || !tr.name) continue;
      await query(`INSERT INTO tag_translations (id, tag_id, language_code, name) VALUES ($1,$2,$3,$4)`, [newId(), t.id, tr.lang, tr.name]);
    }
    summary.tags++;
  }

  for (const ing of snapshot.ingredients ?? []) {
    if (ing.deletedAt) continue;
    const input = {
      id: ing.id, name: ing.name, categoryId: categoryIdRemap.get(ing.categoryId) ?? ing.categoryId,
      description: ing.description, icon: ing.icon,
      imageUrls: ing.imageUrls, tagIds: ing.tagIds?.map(id => tagIdRemap.get(id) ?? id), translations: ing.translations,
      caloriesKcal: ing.caloriesKcal, proteinG: ing.proteinG, carbsG: ing.carbsG, fatG: ing.fatG,
      fiberG: ing.fiberG, sugarG: ing.sugarG, sodiumMg: ing.sodiumMg, seasonalMonths: ing.seasonalMonths,
    };
    if (await existsById('ingredients', ing.id)) {
      await ingredientsLocal.updateIngredient(ing.id, input);
    } else {
      await ingredientsLocal.createIngredient(input);
    }
    summary.ingredients++;
  }

  for (const tool of snapshot.tools ?? []) {
    if (tool.deletedAt) continue;
    const input = {
      id: tool.id, name: tool.name, category: tool.category, description: tool.description, icon: tool.icon,
      imageUrls: tool.imageUrls, translations: tool.translations,
    };
    if (await existsById('tools', tool.id)) {
      await ingredientsLocal.updateTool(tool.id, input);
    } else {
      await ingredientsLocal.createTool(input);
    }
    summary.tools++;
  }

  for (const tech of snapshot.techniques ?? []) {
    if (tech.deletedAt) continue;
    if (await existsById('techniques', tech.id)) {
      await query(
        `UPDATE techniques SET name=$1, description=$2, icon=$3, image_urls=$4, updated_at=now() WHERE id=$5`,
        [tech.name, tech.description ?? null, tech.icon ?? null, tech.imageUrls ?? [], tech.id]
      );
      await query(`DELETE FROM technique_translations WHERE technique_id=$1`, [tech.id]);
    } else {
      await query(
        `INSERT INTO techniques (id, name, description, icon, image_urls) VALUES ($1,$2,$3,$4,$5)`,
        [tech.id, tech.name, tech.description ?? null, tech.icon ?? null, tech.imageUrls ?? []]
      );
    }
    for (const tr of tech.translations ?? []) {
      if (!tr.lang || (!tr.name && !tr.description)) continue;
      await query(
        `INSERT INTO technique_translations (id, technique_id, language_code, name, description) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), tech.id, tr.lang, tr.name ?? null, tr.description ?? null]
      );
    }
    summary.techniques++;
  }

  for (const r of topoSortBySubRecipe(snapshot.recipes ?? [])) {
    if (r.deletedAt) continue;
    const alreadyExists = await existsById('recipes', r.id);

    const ingredientInputs: recipesLocal.RecipeIngredientInput[] = [];
    for (const ri of r.ingredients ?? []) {
      ingredientInputs.push({
        sortOrder: ri.sortOrder,
        ingredientId: ri.ingredientId,
        subRecipeId: ri.subRecipeId,
        quantity: ri.quantity ?? undefined,
        quantityText: ri.quantityText ?? undefined,
        unitId: await resolveUnitId(ri.unitSymbol),
        notes: ri.notes ?? undefined,
        isOptional: ri.isOptional,
        groupName: ri.groupName ?? undefined,
        substituteFor: ri.substituteFor ?? null,
        translations: ri.translations,
      });
    }

    const stepInputs: recipesLocal.RecipeStepInput[] = await Promise.all((r.steps ?? []).map(async (s) => ({
      stepNumber: s.stepNumber,
      title: s.title,
      description: s.description,
      durationMin: s.durationMin,
      toolIds: s.toolIds,
      techniqueIds: s.techniqueIds,
      notes: s.notes,
      imageUrl: await intoImageStore(s.imageUrl),
      translations: s.translations,
      stepIngredients: Array.isArray(s.stepIngredients) ? s.stepIngredients : [],
    })));

    // recipe_ingredients.sub_recipe_id is a real FK (recipes.id) that this
    // app's actual SQLite engine does enforce (confirmed the hard way —
    // "FOREIGN KEY constraint failed" — despite no PRAGMA foreign_keys
    // statement anywhere in this codebase; it appears to default to on for
    // the native Electron/Android engine). topoSortBySubRecipe() above
    // guarantees a sub-recipe is always processed before whatever
    // references it, so by the time this INSERT/UPDATE runs, that id
    // already exists locally.
    const recipeInput = {
      id: r.id, title: r.title, description: r.description, difficulty: r.difficulty, servings: r.servings,
      prepTimeMin: r.prepTimeMin, cookTimeMin: r.cookTimeMin, restTimeMin: r.restTimeMin, rating: r.rating,
      tags: r.tags, coverImageUrl: await intoImageStore(r.coverImageUrl), sourceUrl: r.sourceUrl, sources: r.sources,
      isComponent: r.isComponent, languageCode: r.languageCode ?? undefined,
      storageInstructions: r.storageInstructions ?? undefined, tips: r.tips ?? undefined,
      ingredients: ingredientInputs, steps: stepInputs, toolIds: r.toolIds, translations: r.translations,
    };
    if (alreadyExists) {
      await recipesLocal.updateRecipe(r.id, recipeInput);
    } else {
      await recipesLocal.createRecipe(recipeInput, null);
    }
    summary.recipes++;
  }

  return summary;
}
