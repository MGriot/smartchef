// ════════════════════════════════════════════════════════════════════════
// SmartChef — the parts of the library that live outside an entity's own row
// (ADR 0006, whole-library sync)
//
// Sync used to carry each entity's bare row only — a recipe's steps and
// ingredient rows, but none of its translations; an ingredient without its
// translations or its tags; categories and units not at all. The same
// recipe then arrived on another device split from the library it lives in.
// Everything a library item owns is now embedded in its one entity file:
//
//   translations         — every entity type, keyed by `lang`
//   steps[].translations,
//   ingredients[].translations — inside a recipe's whole-array fields
//   tag_ids              — an ingredient's ingredient_tags links
//   group_translations   — a tag's group-name translations
//
// and categories/units became synced entity types themselves, with portable
// ids (see portableCategoryId/portableUnitId).
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';

function newId(): string {
  return crypto.randomUUID();
}

interface TranslationTable {
  table: string;
  fk: string;
  columns: string[];
}

/** Each entity type's translations table and the columns it carries. */
export const TRANSLATION_TABLES: Record<string, TranslationTable> = {
  recipe: { table: 'recipe_translations', fk: 'recipe_id', columns: ['title', 'description'] },
  ingredient: { table: 'ingredient_translations', fk: 'ingredient_id', columns: ['translated_name', 'plural_translation'] },
  tool: { table: 'tool_translations', fk: 'tool_id', columns: ['name', 'description'] },
  tag: { table: 'tag_translations', fk: 'tag_id', columns: ['name'] },
  technique: { table: 'technique_translations', fk: 'technique_id', columns: ['name', 'description'] },
  category: { table: 'ingredient_category_translations', fk: 'category_id', columns: ['name', 'description'] },
  unit: { table: 'unit_translations', fk: 'unit_id', columns: ['name'] },
};

export type TranslationEntry = { lang: string } & Record<string, unknown>;

/** Fields beyond an entity's scalar columns that sync carries, per type. */
export const EXTRA_FIELDS: Record<string, string[]> = {
  recipe: ['translations'],
  ingredient: ['translations', 'tag_ids'],
  tool: ['translations'],
  tag: ['translations', 'group_translations'],
  technique: ['translations'],
  category: ['translations'],
  unit: ['translations'],
};

export function isExtraField(entityType: string, fieldName: string): boolean {
  return EXTRA_FIELDS[entityType]?.includes(fieldName) ?? false;
}

// ── Translations ────────────────────────────────────────────────────────

export async function readTranslations(entityType: string, entityId: string): Promise<TranslationEntry[]> {
  const cfg = TRANSLATION_TABLES[entityType];
  if (!cfg) return [];
  const rows = await query<Record<string, unknown>>(
    `SELECT language_code, ${cfg.columns.join(', ')} FROM ${cfg.table} WHERE ${cfg.fk} = $1 ORDER BY language_code`,
    [entityId]
  );
  return rows.map((row) => {
    const entry: TranslationEntry = { lang: String(row.language_code) };
    for (const column of cfg.columns) entry[column] = row[column] ?? null;
    return entry;
  });
}

function asEntries(value: unknown): TranslationEntry[] {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? (list as TranslationEntry[]).filter((e) => e && typeof e.lang === 'string' && e.lang) : [];
}

/** Replaces an entity's translations with `value` — the whole set, as the
 *  merge settled it. */
export async function writeTranslations(entityType: string, entityId: string, value: unknown): Promise<void> {
  const cfg = TRANSLATION_TABLES[entityType];
  if (!cfg) return;
  await query(`DELETE FROM ${cfg.table} WHERE ${cfg.fk} = $1`, [entityId]);
  for (const entry of asEntries(value)) {
    const values = cfg.columns.map((c) => entry[c] ?? null);
    // translated_name / tag name are NOT NULL — an entry without one says
    // nothing and is skipped rather than failing the whole write.
    if (values[0] === null && cfg.columns.length === 1) continue;
    if (entityType === 'ingredient' && !entry.translated_name) continue;
    const placeholders = cfg.columns.map((_, i) => `$${i + 4}`).join(', ');
    await query(
      `INSERT INTO ${cfg.table} (id, ${cfg.fk}, language_code, ${cfg.columns.join(', ')}) VALUES ($1, $2, $3, ${placeholders})`,
      [newId(), entityId, entry.lang, ...values]
    );
  }
}

// ── Ingredient tags ─────────────────────────────────────────────────────

export async function readIngredientTagIds(ingredientId: string): Promise<string[]> {
  const rows = await query<{ tag_id: string }>(`SELECT tag_id FROM ingredient_tags WHERE ingredient_id = $1 ORDER BY tag_id`, [ingredientId]);
  return rows.map((r) => r.tag_id);
}

/** Links only tags that exist here — a tag this device hasn't received yet
 *  would violate ingredient_tags' foreign key. Tags are merged before
 *  ingredients (mergeBridge.ts ENTITY_DIRS), so that is the rare case. */
export async function writeIngredientTagIds(ingredientId: string, value: unknown): Promise<void> {
  let ids = value;
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = [];
    }
  }
  await query(`DELETE FROM ingredient_tags WHERE ingredient_id = $1`, [ingredientId]);
  for (const tagId of Array.isArray(ids) ? ids : []) {
    if (typeof tagId !== 'string') continue;
    await query(
      `INSERT INTO ingredient_tags (ingredient_id, tag_id) SELECT $1, id FROM tags WHERE id = $2 ON CONFLICT DO NOTHING`,
      [ingredientId, tagId]
    );
  }
}

// ── Tag group translations ──────────────────────────────────────────────

export async function readTagGroupTranslations(groupName: unknown): Promise<TranslationEntry[]> {
  if (typeof groupName !== 'string' || !groupName) return [];
  const rows = await query<{ language_code: string; name: string }>(
    `SELECT language_code, name FROM tag_group_translations WHERE group_name = $1 ORDER BY language_code`,
    [groupName]
  );
  return rows.map((r) => ({ lang: r.language_code, name: r.name }));
}

/** Upserts only — a group is shared by several tags, so one tag's copy
 *  never deletes another's entries. */
export async function writeTagGroupTranslations(tagId: string, value: unknown): Promise<void> {
  const rows = await query<{ group_name: string | null }>(`SELECT group_name FROM tags WHERE id = $1`, [tagId]);
  const groupName = rows[0]?.group_name;
  if (!groupName) return;
  for (const entry of asEntries(value)) {
    if (!entry.name) continue;
    await query(
      `INSERT INTO tag_group_translations (id, group_name, language_code, name) VALUES ($1, $2, $3, $4)
       ON CONFLICT(group_name, language_code) DO UPDATE SET name = excluded.name`,
      [newId(), groupName, entry.lang, entry.name]
    );
  }
}

/** Writes one extra field (see EXTRA_FIELDS) onto this device. */
export async function writeExtraField(entityType: string, entityId: string, fieldName: string, value: unknown): Promise<void> {
  if (fieldName === 'translations') return writeTranslations(entityType, entityId, value);
  if (fieldName === 'tag_ids' && entityType === 'ingredient') return writeIngredientTagIds(entityId, value);
  if (fieldName === 'group_translations' && entityType === 'tag') return writeTagGroupTranslations(entityId, value);
  throw new Error(`writeExtraField: '${fieldName}' is not a synced extra field on '${entityType}'`);
}

/** The extra fields for one entity, for its entity file. */
export async function readExtraFields(entityType: string, entityId: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (TRANSLATION_TABLES[entityType]) out.translations = await readTranslations(entityType, entityId);
  if (entityType === 'ingredient') out.tag_ids = await readIngredientTagIds(entityId);
  if (entityType === 'tag') out.group_translations = await readTagGroupTranslations(row.group_name);
  return out;
}

// ── Recipe child-row translations ───────────────────────────────────────

/** Step and ingredient-row translations for a whole recipe, one query per
 *  table, grouped by row id. */
export async function readRecipeRowTranslations(recipeId: string): Promise<{
  steps: Map<string, TranslationEntry[]>;
  ingredients: Map<string, TranslationEntry[]>;
}> {
  const stepRows = await query<{ step_id: string; language_code: string; title: string | null; description: string | null; notes: string | null }>(
    `SELECT t.step_id, t.language_code, t.title, t.description, t.notes FROM recipe_step_translations t
       JOIN recipe_steps s ON s.id = t.step_id WHERE s.recipe_id = $1 ORDER BY t.language_code`,
    [recipeId]
  );
  const ingredientRows = await query<{ recipe_ingredient_id: string; language_code: string; notes: string | null }>(
    `SELECT t.recipe_ingredient_id, t.language_code, t.notes FROM recipe_ingredient_translations t
       JOIN recipe_ingredients ri ON ri.id = t.recipe_ingredient_id WHERE ri.recipe_id = $1 ORDER BY t.language_code`,
    [recipeId]
  );
  const steps = new Map<string, TranslationEntry[]>();
  for (const r of stepRows) {
    const list = steps.get(r.step_id) ?? [];
    list.push({ lang: r.language_code, title: r.title, description: r.description, notes: r.notes });
    steps.set(r.step_id, list);
  }
  const ingredients = new Map<string, TranslationEntry[]>();
  for (const r of ingredientRows) {
    const list = ingredients.get(r.recipe_ingredient_id) ?? [];
    list.push({ lang: r.language_code, notes: r.notes });
    ingredients.set(r.recipe_ingredient_id, list);
  }
  return { steps, ingredients };
}

export async function writeStepTranslations(stepId: string, value: unknown): Promise<void> {
  await query(`DELETE FROM recipe_step_translations WHERE step_id = $1`, [stepId]);
  for (const entry of asEntries(value)) {
    await query(
      `INSERT INTO recipe_step_translations (id, step_id, language_code, title, description, notes) VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), stepId, entry.lang, entry.title ?? null, entry.description ?? null, entry.notes ?? null]
    );
  }
}

export async function writeRecipeIngredientTranslations(rowId: string, value: unknown): Promise<void> {
  await query(`DELETE FROM recipe_ingredient_translations WHERE recipe_ingredient_id = $1`, [rowId]);
  for (const entry of asEntries(value)) {
    await query(
      `INSERT INTO recipe_ingredient_translations (id, recipe_ingredient_id, language_code, notes) VALUES ($1, $2, $3, $4)`,
      [newId(), rowId, entry.lang, entry.notes ?? null]
    );
  }
}

// ── Portable ids for categories and units ───────────────────────────────
// Both were seeded per device with random ids, so the same "Frutta" or "g"
// had a different id everywhere and could not be synced as an entity. Ids
// derived from the name/symbol are the same on every device; db/local.ts
// re-keys existing rows once (rekeyPortableIds).

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

export function portableCategoryId(name: string): string {
  return `cat-${slugify(name)}`;
}

export function portableUnitId(symbol: string): string {
  return `unit-${slugify(symbol)}`;
}

// Tools, techniques and tags carry the same hazard categories and units
// carried before ADR 0006: created with crypto.randomUUID() on whichever
// device saw them first, so the same real-world "Whisk" is two unrelated
// ids on two devices. Their tables also hold a unique index on the active
// name, so the second device's row cannot even be inserted — see
// conflicts.local.ts NAME_UNIQUE_TYPES.
//
// Unlike a unit symbol, a tool's name is user-editable. That does not make
// a name-derived id wrong: the id is assigned at birth (and at collision
// repair) and NEVER recomputed on rename, exactly as updateCategory()
// already behaves. It only has to be the id two devices would independently
// arrive at for the same thing, not a name that never changes.

export function portableToolId(name: string): string {
  return `tool-${slugify(name)}`;
}

export function portableTechniqueId(name: string): string {
  return `technique-${slugify(name)}`;
}

export function portableTagId(name: string): string {
  return `tag-${slugify(name)}`;
}

/** A new row's id: the portable one for its name when that id is free, a
 *  random one otherwise. Two devices creating the same thing land on the
 *  same id; two genuinely different things whose names happen to slugify
 *  alike still get rows of their own.
 *
 *  Lives here rather than in ingredients.local.ts (which has had a private
 *  copy since ADR 0006) so tags and techniques can use it without
 *  importing the ingredients module for one helper. */
export async function freshPortableId(table: string, portable: string): Promise<string> {
  return (await queryOne(`SELECT id FROM ${table} WHERE id=$1`, [portable])) ? crypto.randomUUID() : portable;
}
