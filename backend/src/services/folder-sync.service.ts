// ════════════════════════════════════════════════════════════════════════
// SmartChef — Folder-based Multi-Device Sync
// Periodic full-library snapshot exchange through a shared folder (a plain
// local folder, or one an OS-level client like OneDrive/Google Drive keeps
// in sync across devices). Each device writes only its own
// `smartchef-<deviceId>.json`; on every tick it reads every *other*
// device's file and merges each entity row in by id, last-write-wins on
// `updatedAt`. See the Tenth-slice plan for why this replaces the
// vector-clock CRDT engine (mdns.service.ts) rather than reusing it — that
// engine never actually logged local writes, so there was nothing to sync.
// ════════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { query, withTransaction } from "../db/pool";
import { DEVICE_ID, DEVICE_NAME } from "./device-identity.service";
import { computeAutoTagNames, unionTagNames } from "./tags.service";

const FORMAT_VERSION = 1;
export const SYNC_FOLDER = process.env.SYNC_FOLDER ?? "/app/sync";
export const SYNC_ENABLED = process.env.SYNC_ENABLED === "true";

function snapshotFilePath(deviceId: string): string {
  return path.join(SYNC_FOLDER, `smartchef-${deviceId}.json`);
}

// ── Snapshot shape ───────────────────────────────────────────────────────
// Every entity carries `updatedAt` (the LWW ordering signal) and
// `deletedAt` (null unless it's a tombstone) alongside its real `id`, which
// is kept stable across devices — unlike the Ninth-slice share.ts bundles,
// which mint fresh ids because they're merging into a *different* library,
// this one replicates the *same* logical library.

interface Translated { lang: string; name?: string | null; description?: string | null }

interface SnapshotCategory {
  id: string; name: string; description: string | null; icon: string | null; color: string | null;
  sortOrder: number; updatedAt: string; deletedAt: string | null; translations: Translated[];
}
interface SnapshotTool {
  id: string; name: string; description: string | null; icon: string | null; category: string | null;
  imageUrls: string[]; updatedAt: string; deletedAt: string | null; translations: Translated[];
}
interface SnapshotTechnique {
  id: string; name: string; description: string | null; icon: string | null; imageUrls: string[];
  updatedAt: string; deletedAt: string | null; translations: Translated[];
}
interface SnapshotTag {
  id: string; name: string; groupName: string; color: string | null; icon: string | null;
  excludeTagIds: string[]; sortOrder: number; updatedAt: string; deletedAt: string | null;
  translations: Array<{ lang: string; name?: string | null }>; ingredientIds: string[];
}
interface SnapshotIngredient {
  id: string; name: string; categoryId: string; description: string | null; densityGPerMl: number | null;
  defaultUnit: string | null; icon: string | null; imageUrls: string[];
  caloriesKcal: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
  fiberG: number | null; sugarG: number | null; sodiumMg: number | null;
  updatedAt: string; deletedAt: string | null;
  translations: Array<{ lang: string; text: string }>; tagIds: string[];
}
interface SnapshotCollection {
  id: string; name: string; description: string | null; sortOrder: number;
  updatedAt: string; deletedAt: string | null; recipeIds: string[];
}
interface SnapshotRecipeIngredient {
  sortOrder: number; ingredientId?: string; subRecipeId?: string;
  quantity: number | null; quantityText: string | null; unitSymbol: string | null;
  notes: string | null; isOptional: boolean;
}
interface SnapshotRecipeStep {
  stepNumber: number; title: string | null; description: string; durationMin: number | null;
  toolIds: string[]; notes: string | null; imageUrl: string | null; stepIngredients: unknown;
  translations: Array<{ lang: string; title?: string | null; description?: string | null }>;
}
interface SnapshotRecipe {
  id: string; title: string; description: string | null; difficulty: string; servings: number;
  prepTimeMin: number | null; cookTimeMin: number | null; restTimeMin: number | null; rating: number | null; timesCooked: number; tags: string[];
  coverImageUrl: string | null; sourceUrl: string | null; sources: unknown[]; isComponent: boolean;
  languageCode: string | null; updatedAt: string; deletedAt: string | null;
  ingredients: SnapshotRecipeIngredient[]; steps: SnapshotRecipeStep[]; toolIds: string[];
  translations: Array<{ lang: string; title?: string | null; description?: string | null }>;
}

export interface Snapshot {
  formatVersion: number;
  deviceId: string;
  deviceName: string;
  exportedAt: string;
  categories: SnapshotCategory[];
  tools: SnapshotTool[];
  techniques: SnapshotTechnique[];
  tags: SnapshotTag[];
  ingredients: SnapshotIngredient[];
  collections: SnapshotCollection[];
  recipes: SnapshotRecipe[];
}

// ── Export: build the full-library snapshot ────────────────────────────

async function loadCategories(): Promise<SnapshotCategory[]> {
  const rows = await query<any>("SELECT * FROM ingredient_categories");
  const out: SnapshotCategory[] = [];
  for (const r of rows) {
    const translations = await query<Translated>(
      "SELECT language_code AS lang, name, description FROM ingredient_category_translations WHERE category_id=$1",
      [r.id]
    );
    out.push({
      id: r.id, name: r.name, description: r.description, icon: r.icon, color: r.color,
      sortOrder: r.sort_order, updatedAt: r.updated_at, deletedAt: r.deleted_at, translations,
    });
  }
  return out;
}

async function loadTools(): Promise<SnapshotTool[]> {
  const rows = await query<any>("SELECT * FROM tools");
  const out: SnapshotTool[] = [];
  for (const r of rows) {
    const translations = await query<Translated>(
      "SELECT language_code AS lang, name, description FROM tool_translations WHERE tool_id=$1", [r.id]
    );
    out.push({
      id: r.id, name: r.name, description: r.description, icon: r.icon, category: r.category,
      imageUrls: r.image_urls ?? [], updatedAt: r.updated_at, deletedAt: r.deleted_at, translations,
    });
  }
  return out;
}

async function loadTechniques(): Promise<SnapshotTechnique[]> {
  const rows = await query<any>("SELECT * FROM techniques");
  const out: SnapshotTechnique[] = [];
  for (const r of rows) {
    const translations = await query<Translated>(
      "SELECT language_code AS lang, name, description FROM technique_translations WHERE technique_id=$1", [r.id]
    );
    out.push({
      id: r.id, name: r.name, description: r.description, icon: r.icon,
      imageUrls: r.image_urls ?? [], updatedAt: r.updated_at, deletedAt: r.deleted_at, translations,
    });
  }
  return out;
}

async function loadTags(): Promise<SnapshotTag[]> {
  const rows = await query<any>("SELECT * FROM tags");
  const out: SnapshotTag[] = [];
  for (const r of rows) {
    const translations = await query<{ lang: string; name: string | null }>(
      "SELECT language_code AS lang, name FROM tag_translations WHERE tag_id=$1", [r.id]
    );
    const ingredientRows = await query<{ ingredient_id: string }>(
      "SELECT ingredient_id FROM ingredient_tags WHERE tag_id=$1", [r.id]
    );
    out.push({
      id: r.id, name: r.name, groupName: r.group_name, color: r.color, icon: r.icon,
      excludeTagIds: r.exclude_tag_ids ?? [], sortOrder: r.sort_order,
      updatedAt: r.updated_at, deletedAt: r.deleted_at, translations,
      ingredientIds: ingredientRows.map((i) => i.ingredient_id),
    });
  }
  return out;
}

async function loadIngredients(): Promise<SnapshotIngredient[]> {
  const rows = await query<any>("SELECT * FROM ingredients");
  const out: SnapshotIngredient[] = [];
  for (const r of rows) {
    const translations = await query<{ lang: string; text: string }>(
      "SELECT language_code AS lang, translated_name AS text FROM ingredient_translations WHERE ingredient_id=$1", [r.id]
    );
    const tagRows = await query<{ tag_id: string }>(
      "SELECT tag_id FROM ingredient_tags WHERE ingredient_id=$1", [r.id]
    );
    out.push({
      id: r.id, name: r.name, categoryId: r.category_id, description: r.description,
      densityGPerMl: r.density_g_per_ml !== null ? Number(r.density_g_per_ml) : null,
      defaultUnit: r.default_unit, icon: r.icon, imageUrls: r.image_urls ?? [],
      caloriesKcal: r.calories_kcal !== null ? Number(r.calories_kcal) : null,
      proteinG: r.protein_g !== null ? Number(r.protein_g) : null,
      carbsG: r.carbs_g !== null ? Number(r.carbs_g) : null,
      fatG: r.fat_g !== null ? Number(r.fat_g) : null,
      fiberG: r.fiber_g !== null ? Number(r.fiber_g) : null,
      sugarG: r.sugar_g !== null ? Number(r.sugar_g) : null,
      sodiumMg: r.sodium_mg !== null ? Number(r.sodium_mg) : null,
      updatedAt: r.updated_at, deletedAt: r.sync_status === "deleted" ? r.updated_at : null,
      translations, tagIds: tagRows.map((t) => t.tag_id),
    });
  }
  return out;
}

async function loadCollections(): Promise<SnapshotCollection[]> {
  const rows = await query<any>("SELECT * FROM collections");
  const out: SnapshotCollection[] = [];
  for (const r of rows) {
    const recipeRows = await query<{ recipe_id: string }>(
      "SELECT recipe_id FROM collection_recipes WHERE collection_id=$1 ORDER BY sort_order", [r.id]
    );
    out.push({
      id: r.id, name: r.name, description: r.description, sortOrder: r.sort_order,
      updatedAt: r.updated_at, deletedAt: r.deleted_at, recipeIds: recipeRows.map((x) => x.recipe_id),
    });
  }
  return out;
}

async function loadRecipes(): Promise<SnapshotRecipe[]> {
  const rows = await query<any>("SELECT * FROM recipes");
  const out: SnapshotRecipe[] = [];
  for (const r of rows) {
    const ingredientRows = await query<any>(
      `SELECT ri.sort_order, ri.ingredient_id, ri.sub_recipe_id, ri.quantity, ri.quantity_text,
              ri.notes, ri.is_optional, u.symbol AS unit_symbol
       FROM recipe_ingredients ri LEFT JOIN units u ON u.id = ri.unit_id
       WHERE ri.recipe_id=$1 ORDER BY ri.sort_order`,
      [r.id]
    );
    const stepRows = await query<any>(
      `SELECT id, step_number, title, description, duration_min, tool_ids, notes, image_url, step_ingredients
       FROM recipe_steps WHERE recipe_id=$1 ORDER BY step_number`,
      [r.id]
    );
    const steps: SnapshotRecipeStep[] = [];
    for (const s of stepRows) {
      const translations = await query<any>(
        "SELECT language_code AS lang, title, description FROM recipe_step_translations WHERE step_id=$1", [s.id]
      );
      steps.push({
        stepNumber: s.step_number, title: s.title, description: s.description, durationMin: s.duration_min,
        toolIds: s.tool_ids ?? [], notes: s.notes, imageUrl: s.image_url,
        stepIngredients: s.step_ingredients ?? [], translations,
      });
    }
    const toolRows = await query<{ tool_id: string }>("SELECT tool_id FROM recipe_tools WHERE recipe_id=$1", [r.id]);
    const translations = await query<any>(
      "SELECT language_code AS lang, title, description FROM recipe_translations WHERE recipe_id=$1", [r.id]
    );

    out.push({
      id: r.id, title: r.title, description: r.description, difficulty: r.difficulty, servings: r.servings,
      prepTimeMin: r.prep_time_min, cookTimeMin: r.cook_time_min, restTimeMin: r.rest_time_min, rating: r.rating,
      timesCooked: r.times_cooked,
      tags: r.tags ?? [], coverImageUrl: r.cover_image_url, sourceUrl: r.source_url,
      sources: r.sources ?? [], isComponent: r.is_component, languageCode: r.language_code,
      updatedAt: r.updated_at, deletedAt: r.sync_status === "deleted" ? r.updated_at : null,
      ingredients: ingredientRows.map((i: any) => ({
        sortOrder: i.sort_order, ingredientId: i.ingredient_id ?? undefined, subRecipeId: i.sub_recipe_id ?? undefined,
        quantity: i.quantity !== null ? Number(i.quantity) : null, quantityText: i.quantity_text,
        unitSymbol: i.unit_symbol, notes: i.notes, isOptional: i.is_optional,
      })),
      steps, toolIds: toolRows.map((t) => t.tool_id), translations,
    });
  }
  return out;
}

export async function buildFullSnapshot(): Promise<Snapshot> {
  return {
    formatVersion: FORMAT_VERSION,
    deviceId: DEVICE_ID,
    deviceName: DEVICE_NAME,
    exportedAt: new Date().toISOString(),
    categories: await loadCategories(),
    tools: await loadTools(),
    techniques: await loadTechniques(),
    tags: await loadTags(),
    ingredients: await loadIngredients(),
    collections: await loadCollections(),
    recipes: await loadRecipes(),
  };
}

export async function writeSnapshot(): Promise<void> {
  const snapshot = await buildFullSnapshot();
  await fs.mkdir(SYNC_FOLDER, { recursive: true });
  await fs.writeFile(snapshotFilePath(DEVICE_ID), JSON.stringify(snapshot), "utf-8");
}

// ── Import: merge every *other* device's snapshot in by id, LWW ────────

/** True if `remote` should overwrite `local` — remote wins on a strict
 *  newer `updatedAt`; ties keep the local value untouched (deterministic,
 *  avoids write storms — both sides converge without needing to negotiate
 *  who "wins" a tie by device id). */
function remoteWins(remoteUpdatedAt: string, localUpdatedAt: string | undefined): boolean {
  if (!localUpdatedAt) return true;
  return new Date(remoteUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();
}

async function localUpdatedAt(client: PoolClient, table: string, id: string): Promise<string | undefined> {
  const res = await client.query<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id=$1`, [id]);
  return res.rows[0]?.updated_at;
}

async function upsertCategory(client: PoolClient, c: SnapshotCategory): Promise<boolean> {
  if (!remoteWins(c.updatedAt, await localUpdatedAt(client, "ingredient_categories", c.id))) return false;
  await client.query(
    `INSERT INTO ingredient_categories (id, name, description, icon, color, sort_order, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, icon=$4, color=$5, sort_order=$6, deleted_at=$7, updated_at=$8`,
    [c.id, c.name, c.description, c.icon, c.color, c.sortOrder, c.deletedAt, c.updatedAt]
  );
  await client.query("DELETE FROM ingredient_category_translations WHERE category_id=$1", [c.id]);
  for (const t of c.translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await client.query(
      "INSERT INTO ingredient_category_translations (category_id, language_code, name, description) VALUES ($1,$2,$3,$4)",
      [c.id, t.lang, t.name ?? null, t.description ?? null]
    );
  }
  return true;
}

async function upsertTool(client: PoolClient, t: SnapshotTool): Promise<boolean> {
  if (!remoteWins(t.updatedAt, await localUpdatedAt(client, "tools", t.id))) return false;
  await client.query(
    `INSERT INTO tools (id, name, description, icon, category, image_urls, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, icon=$4, category=$5, image_urls=$6, deleted_at=$7, updated_at=$8`,
    [t.id, t.name, t.description, t.icon, t.category, t.imageUrls, t.deletedAt, t.updatedAt]
  );
  await client.query("DELETE FROM tool_translations WHERE tool_id=$1", [t.id]);
  for (const tr of t.translations) {
    if (!tr.lang || (!tr.name && !tr.description)) continue;
    await client.query(
      "INSERT INTO tool_translations (tool_id, language_code, name, description) VALUES ($1,$2,$3,$4)",
      [t.id, tr.lang, tr.name ?? null, tr.description ?? null]
    );
  }
  return true;
}

async function upsertTechnique(client: PoolClient, t: SnapshotTechnique): Promise<boolean> {
  if (!remoteWins(t.updatedAt, await localUpdatedAt(client, "techniques", t.id))) return false;
  await client.query(
    `INSERT INTO techniques (id, name, description, icon, image_urls, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, icon=$4, image_urls=$5, deleted_at=$6, updated_at=$7`,
    [t.id, t.name, t.description, t.icon, t.imageUrls, t.deletedAt, t.updatedAt]
  );
  await client.query("DELETE FROM technique_translations WHERE technique_id=$1", [t.id]);
  for (const tr of t.translations) {
    if (!tr.lang || (!tr.name && !tr.description)) continue;
    await client.query(
      "INSERT INTO technique_translations (technique_id, language_code, name, description) VALUES ($1,$2,$3,$4)",
      [t.id, tr.lang, tr.name ?? null, tr.description ?? null]
    );
  }
  return true;
}

async function upsertIngredient(client: PoolClient, i: SnapshotIngredient): Promise<boolean> {
  const res = await client.query<{ updated_at: string }>("SELECT updated_at FROM ingredients WHERE id=$1", [i.id]);
  if (!remoteWins(i.updatedAt, res.rows[0]?.updated_at)) return false;

  // category must exist first — guard against a snapshot ordering issue
  // (shouldn't happen since categories are imported before ingredients,
  // but a peer's category could itself have lost an earlier merge race).
  const categoryExists = await client.query("SELECT 1 FROM ingredient_categories WHERE id=$1", [i.categoryId]);
  if (!categoryExists.rows[0]) return false;

  await client.query(
    `INSERT INTO ingredients (id, category_id, name, description, density_g_per_ml, default_unit, icon, image_urls,
       calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, sync_status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO UPDATE SET
       category_id=$2, name=$3, description=$4, density_g_per_ml=$5, default_unit=$6, icon=$7, image_urls=$8,
       calories_kcal=$9, protein_g=$10, carbs_g=$11, fat_g=$12, fiber_g=$13, sugar_g=$14, sodium_mg=$15,
       sync_status=$16, updated_at=$17`,
    [i.id, i.categoryId, i.name, i.description, i.densityGPerMl, i.defaultUnit, i.icon, i.imageUrls,
     i.caloriesKcal, i.proteinG, i.carbsG, i.fatG, i.fiberG, i.sugarG, i.sodiumMg,
     i.deletedAt ? "deleted" : "synced", i.updatedAt]
  );
  await client.query("DELETE FROM ingredient_translations WHERE ingredient_id=$1", [i.id]);
  for (const t of i.translations) {
    if (!t.lang || !t.text) continue;
    await client.query(
      "INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name) VALUES ($1,$2,$3)",
      [i.id, t.lang, t.text]
    );
  }
  await client.query("DELETE FROM ingredient_tags WHERE ingredient_id=$1", [i.id]);
  for (const tagId of i.tagIds) {
    await client.query(
      "INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [i.id, tagId]
    );
  }
  return true;
}

async function upsertTag(client: PoolClient, t: SnapshotTag): Promise<boolean> {
  if (!remoteWins(t.updatedAt, await localUpdatedAt(client, "tags", t.id))) return false;
  await client.query(
    `INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids, sort_order, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       name=$2, group_name=$3, color=$4, icon=$5, exclude_tag_ids=$6, sort_order=$7, deleted_at=$8, updated_at=$9`,
    [t.id, t.name, t.groupName, t.color, t.icon, t.excludeTagIds, t.sortOrder, t.deletedAt, t.updatedAt]
  );
  await client.query("DELETE FROM tag_translations WHERE tag_id=$1", [t.id]);
  for (const tr of t.translations) {
    if (!tr.lang || !tr.name) continue;
    await client.query("INSERT INTO tag_translations (tag_id, language_code, name) VALUES ($1,$2,$3)", [t.id, tr.lang, tr.name]);
  }
  // ingredient_tags for this tag are re-derived from the ingredient side
  // (upsertIngredient already writes its own tagIds) — nothing to do here
  // beyond what's already been applied by the time tags are processed.
  return true;
}

async function upsertRecipeBaseRow(client: PoolClient, r: SnapshotRecipe): Promise<boolean> {
  if (!remoteWins(r.updatedAt, await localUpdatedAt(client, "recipes", r.id))) return false;
  await client.query(
    `INSERT INTO recipes (id, title, description, difficulty, servings, prep_time_min, cook_time_min, rest_time_min, rating, times_cooked,
       tags, cover_image_url, source_url, sources, is_component, language_code, sync_status, crdt_clock, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'{}',$18)
     ON CONFLICT (id) DO UPDATE SET
       title=$2, description=$3, difficulty=$4, servings=$5, prep_time_min=$6, cook_time_min=$7, rest_time_min=$8, rating=$9, times_cooked=$10,
       tags=$11, cover_image_url=$12, source_url=$13, sources=$14, is_component=$15, language_code=$16,
       sync_status=$17, updated_at=$18`,
    [r.id, r.title, r.description, r.difficulty, r.servings, r.prepTimeMin, r.cookTimeMin, r.restTimeMin, r.rating, r.timesCooked,
     r.tags, r.coverImageUrl, r.sourceUrl, JSON.stringify(r.sources), r.isComponent, r.languageCode,
     r.deletedAt ? "deleted" : "synced", r.updatedAt]
  );
  return true;
}

async function replaceRecipeNestedData(client: PoolClient, r: SnapshotRecipe): Promise<void> {
  await client.query("DELETE FROM recipe_ingredients WHERE recipe_id=$1", [r.id]);
  for (const ing of r.ingredients) {
    if (!ing.ingredientId && !ing.subRecipeId) continue;
    let unitId: string | null = null;
    if (ing.unitSymbol) {
      const u = await client.query<{ id: string }>("SELECT id FROM units WHERE symbol=$1", [ing.unitSymbol]);
      unitId = u.rows[0]?.id ?? null;
    }
    await client.query(
      `INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id, sub_recipe_id, quantity, quantity_text, unit_id, notes, is_optional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuidv4(), r.id, ing.sortOrder, ing.ingredientId ?? null, ing.subRecipeId ?? null,
       ing.quantity, ing.quantityText, unitId, ing.notes, ing.isOptional]
    );
  }

  await client.query("DELETE FROM recipe_steps WHERE recipe_id=$1", [r.id]);
  for (const step of r.steps) {
    const stepId = uuidv4();
    await client.query(
      `INSERT INTO recipe_steps (id, recipe_id, step_number, title, description, duration_min, tool_ids, notes, image_url, step_ingredients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [stepId, r.id, step.stepNumber, step.title, step.description, step.durationMin,
       step.toolIds, step.notes, step.imageUrl, JSON.stringify(step.stepIngredients ?? [])]
    );
    for (const t of step.translations) {
      if (!t.lang || (!t.title && !t.description)) continue;
      await client.query(
        "INSERT INTO recipe_step_translations (step_id, language_code, title, description) VALUES ($1,$2,$3,$4)",
        [stepId, t.lang, t.title ?? null, t.description ?? null]
      );
    }
  }

  await client.query("DELETE FROM recipe_tools WHERE recipe_id=$1", [r.id]);
  for (const toolId of r.toolIds) {
    await client.query("INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [r.id, toolId]);
  }

  await client.query("DELETE FROM recipe_translations WHERE recipe_id=$1", [r.id]);
  for (const t of r.translations) {
    if (!t.lang || (!t.title && !t.description)) continue;
    await client.query(
      "INSERT INTO recipe_translations (recipe_id, language_code, title, description) VALUES ($1,$2,$3,$4)",
      [r.id, t.lang, t.title ?? null, t.description ?? null]
    );
  }

  const autoTags = await computeAutoTagNames(client, r.id);
  const finalTags = unionTagNames(r.tags ?? [], autoTags);
  await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, r.id]);
}

async function upsertCollection(client: PoolClient, c: SnapshotCollection): Promise<boolean> {
  if (!remoteWins(c.updatedAt, await localUpdatedAt(client, "collections", c.id))) return false;
  await client.query(
    `INSERT INTO collections (id, name, description, sort_order, deleted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, sort_order=$4, deleted_at=$5, updated_at=$6`,
    [c.id, c.name, c.description, c.sortOrder, c.deletedAt, c.updatedAt]
  );
  await client.query("DELETE FROM collection_recipes WHERE collection_id=$1", [c.id]);
  let sortOrder = 0;
  for (const recipeId of c.recipeIds) {
    const exists = await client.query("SELECT 1 FROM recipes WHERE id=$1", [recipeId]);
    if (!exists.rows[0]) continue; // recipe not (yet) present on this device — skip defensively
    await client.query(
      "INSERT INTO collection_recipes (collection_id, recipe_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [c.id, recipeId, sortOrder++]
    );
  }
  return true;
}

export interface SyncSummary {
  categories: number; tools: number; techniques: number; tags: number;
  ingredients: number; recipes: number; collections: number;
  // Human-readable notes on anything skipped this cycle — e.g. a row that
  // collided (two devices independently creating an ingredient with the
  // same name+category while offline from each other). Still no field-level
  // conflict *resolution* UI (that needs the full CRDT retrofit noted as
  // out of scope back when folder sync was built) — this is just visibility
  // into what the automatic last-write-wins merge did.
  conflicts: string[];
}

function emptySyncSummary(): SyncSummary {
  return { categories: 0, tools: 0, techniques: 0, tags: 0, ingredients: 0, recipes: 0, collections: 0, conflicts: [] };
}

async function listPeerSnapshotFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SYNC_FOLDER);
    return entries.filter((f) => f.startsWith("smartchef-") && f.endsWith(".json") && f !== `smartchef-${DEVICE_ID}.json`);
  } catch {
    return [];
  }
}

// Merges one snapshot (from a peer file, or an uploaded backup — same
// shape either way) into the local DB, mutating `summary` in place with
// per-entity counts and any conflict notes. Shared by importFromPeers()
// (below) and the manual backup-restore route (backup.ts).
export async function mergeSnapshot(snapshot: Snapshot, summary: SyncSummary, label: string): Promise<void> {
  if (snapshot.formatVersion !== FORMAT_VERSION) {
    const msg = `Skipped ${label} — unsupported format version ${snapshot.formatVersion}`;
    console.warn(`⚠️ ${msg}`);
    summary.conflicts.push(msg);
    return;
  }

  try {
    await withTransaction(async (client) => {
      for (const c of snapshot.categories) if (await upsertCategory(client, c)) summary.categories++;
      for (const i of snapshot.ingredients) if (await upsertIngredient(client, i)) summary.ingredients++;
      for (const t of snapshot.tools) if (await upsertTool(client, t)) summary.tools++;
      for (const t of snapshot.techniques) if (await upsertTechnique(client, t)) summary.techniques++;
      for (const t of snapshot.tags) if (await upsertTag(client, t)) summary.tags++;

      for (const r of snapshot.recipes) {
        const applied = await upsertRecipeBaseRow(client, r);
        if (applied) summary.recipes++;
      }
      // Second pass: nested data (ingredients/steps/tools) can now safely
      // reference any sub-recipe in this same snapshot, since every
      // recipe's base row exists after the loop above. Only replace it
      // when this remote version is the one that's actually now stored —
      // i.e. it won the base-row upsert (or already matched) — otherwise
      // a locally-newer recipe's nested data would get clobbered by an
      // older remote copy of the same recipe.
      for (const r of snapshot.recipes) {
        const current = await client.query<{ updated_at: string }>("SELECT updated_at FROM recipes WHERE id=$1", [r.id]);
        if (current.rows[0] && new Date(current.rows[0].updated_at).getTime() === new Date(r.updatedAt).getTime()) {
          await replaceRecipeNestedData(client, r);
        }
      }

      for (const c of snapshot.collections) if (await upsertCollection(client, c)) summary.collections++;
    });
  } catch (err) {
    // A single colliding row shouldn't block every other entity's merge —
    // note it and move on. The colliding row will keep failing until one
    // side renames/removes it.
    const msg = `Skipped a conflicting item while merging ${label}: ${(err as Error).message}`;
    console.warn(`⚠️ Folder sync: ${msg}`);
    summary.conflicts.push(msg);
  }
}

export async function importFromPeers(): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const files = await listPeerSnapshotFiles();

  for (const file of files) {
    let snapshot: Snapshot;
    try {
      const raw = await fs.readFile(path.join(SYNC_FOLDER, file), "utf-8");
      snapshot = JSON.parse(raw);
    } catch (err) {
      const msg = `Skipped unreadable sync file ${file}: ${(err as Error).message}`;
      console.warn(`⚠️ ${msg}`);
      summary.conflicts.push(msg);
      continue;
    }
    await mergeSnapshot(snapshot, summary, file);
  }

  return summary;
}

export async function runSyncCycle(): Promise<{ imported: SyncSummary; exportedAt: string }> {
  const imported = await importFromPeers();
  await writeSnapshot();
  return { imported, exportedAt: new Date().toISOString() };
}

export async function getLastLocalSnapshotMeta(): Promise<{ exportedAt: string } | null> {
  try {
    const raw = await fs.readFile(snapshotFilePath(DEVICE_ID), "utf-8");
    const snapshot = JSON.parse(raw) as Snapshot;
    return { exportedAt: snapshot.exportedAt };
  } catch {
    return null;
  }
}

export async function listPeers(): Promise<Array<{ deviceId: string; deviceName: string; lastSeenAt: string }>> {
  const files = await listPeerSnapshotFiles();
  const peers: Array<{ deviceId: string; deviceName: string; lastSeenAt: string }> = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(SYNC_FOLDER, file), "utf-8");
      const snapshot = JSON.parse(raw) as Snapshot;
      peers.push({ deviceId: snapshot.deviceId, deviceName: snapshot.deviceName, lastSeenAt: snapshot.exportedAt });
    } catch {
      // unreadable/partial file (e.g. mid-write from a cloud sync client) — skip
    }
  }
  return peers;
}

let loopHandle: NodeJS.Timeout | null = null;

export function startFolderSyncLoop(intervalMs = 90_000): void {
  if (!SYNC_ENABLED || loopHandle) return;
  loopHandle = setInterval(async () => {
    try {
      const { imported } = await runSyncCycle();
      const total = Object.values(imported).reduce((a, b) => a + b, 0);
      if (total > 0) {
        console.log(`🔄 Folder sync: applied ${total} change(s) from peers`, imported);
      }
    } catch (err) {
      console.warn("⚠️ Folder sync cycle failed:", (err as Error).message);
    }
  }, intervalMs);
}
