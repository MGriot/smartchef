// ════════════════════════════════════════════════════════════════════════
// SmartChef — Structured Merge conflict records (standalone mode)
// wayfinder ticket 04 (standalone-storage-sync map, ADR 0001/0002): one row
// per pending conflict on a single (entity, field) pair, surfaced to the
// user instead of auto-resolved. Conflicts are created during a real sync
// cycle by mergeBridge.ts (via applyEntityMergeResult() below); resolved
// by the user picking mine/theirs in Account.tsx's Conflicts card (via
// resolveConflict() + applyResolvedConflict() below), which both writes
// the chosen value onto the entity's own row/child tables AND re-commits
// it into the Hidden Clone so the resolution actually reaches the Sync
// Folder on the next cycle, not just this device.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";
import type { ConflictPolicy, EntityMergeResult } from "../lib/structuredMerge";
import { fieldValuesEqual, isEmptyValue, mergeKeyedList, mergeSetField, parseTimestamp, KEYED_LIST_FIELDS, SET_FIELDS } from "../lib/mergeNormalize";
import {
  EXTRA_FIELDS, isExtraField, writeExtraField, writeStepTranslations, writeRecipeIngredientTranslations, portableCategoryId,
} from "./syncExtras.local";

function newId(): string {
  return crypto.randomUUID();
}

export interface SyncConflict {
  id: string;
  entityType: string;
  entityId: string;
  fieldName: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  /** Each side's entity updated_at when recorded — null on rows recorded
   *  before these columns existed. */
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  detectedAt: string;
}

interface ConflictRow {
  id: string;
  entity_type: string;
  entity_id: string;
  field_name: string;
  base_value: string | null;
  local_value: string | null;
  remote_value: string | null;
  local_updated_at?: string | null;
  remote_updated_at?: string | null;
  detected_at: string;
}

function fromRow(row: ConflictRow): SyncConflict {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fieldName: row.field_name,
    baseValue: row.base_value === null ? null : JSON.parse(row.base_value),
    localValue: row.local_value === null ? null : JSON.parse(row.local_value),
    remoteValue: row.remote_value === null ? null : JSON.parse(row.remote_value),
    localUpdatedAt: row.local_updated_at ?? null,
    remoteUpdatedAt: row.remote_updated_at ?? null,
    detectedAt: row.detected_at,
  };
}

export interface UpsertConflictInput {
  entityType: string;
  entityId: string;
  fieldName: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  localUpdatedAt?: string | null;
  remoteUpdatedAt?: string | null;
}

/** Records a genuine Structured Merge conflict — a field that changed on
 *  both sides since the common ancestor. One live row per (entity, field):
 *  a repeated sync before the user resolves it refreshes the row in place
 *  rather than accumulating duplicates. Both sides are refreshed: the local
 *  value used to stay pinned to its first detection, so a row could keep
 *  showing — and, if picked, write back — a value this device had since
 *  moved on from. */
export async function upsertConflict(input: UpsertConflictInput): Promise<void> {
  await query(
    `INSERT INTO sync_conflicts (id, entity_type, entity_id, field_name, base_value, local_value, remote_value, local_updated_at, remote_updated_at, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       base_value = excluded.base_value,
       local_value = excluded.local_value,
       remote_value = excluded.remote_value,
       local_updated_at = excluded.local_updated_at,
       remote_updated_at = excluded.remote_updated_at,
       detected_at = now()`,
    [
      newId(),
      input.entityType,
      input.entityId,
      input.fieldName,
      JSON.stringify(input.baseValue),
      JSON.stringify(input.localValue),
      JSON.stringify(input.remoteValue),
      input.localUpdatedAt ?? null,
      input.remoteUpdatedAt ?? null,
    ]
  );
}

/** All pending conflicts, newest first — the future Conflicts list UI's
 *  main query (ticket 06's prototype assumed exactly this shape). */
export async function listPendingConflicts(): Promise<SyncConflict[]> {
  const rows = await query<ConflictRow>(`SELECT * FROM sync_conflicts ORDER BY detected_at DESC`);
  return rows.map(fromRow);
}

export async function listPendingConflictsForEntity(entityType: string, entityId: string): Promise<SyncConflict[]> {
  const rows = await query<ConflictRow>(
    `SELECT * FROM sync_conflicts WHERE entity_type = $1 AND entity_id = $2 ORDER BY field_name`,
    [entityType, entityId]
  );
  return rows.map(fromRow);
}

export interface ResolvedConflict {
  entityType: string;
  entityId: string;
  fieldName: string;
  chosenValue: unknown;
}

// ── Applying a resolution back onto the entity ──────────────────────────
// entity_type/field_name only ever originate from the (future) Sync Engine
// writing legitimate conflict records, never from user input — but since a
// column name can't be a bound SQL parameter, each is still checked against
// an explicit allowlist before being interpolated, rather than trusted blind.

interface EntityConfig {
  table: string;
  nameColumn: string;
  scalarFields: Set<string>;
  /** False for tables with no updated_at column (units). */
  hasUpdatedAt?: boolean;
}

// One entry per conflictable entity type — table, display-name column, and
// the allowlisted scalar fields applyResolvedConflict() may write. Kept as
// a single map (rather than parallel per-concern maps) so a new entity type
// is one entry, not four scattered edits.
const ENTITY_CONFIG: Record<string, EntityConfig> = {
  recipe: {
    table: 'recipes',
    nameColumn: 'title',
    scalarFields: new Set([
      'title', 'description', 'difficulty', 'servings', 'prep_time_min', 'cook_time_min',
      'rest_time_min', 'rating', 'yield_amount', 'yield_unit_id', 'cover_image_url',
      'source_url', 'is_component', 'language_code', 'tags', 'regions', 'region_coords',
      'sources', 'creator_name', 'storage_instructions', 'tips',
    ]),
  },
  ingredient: {
    table: 'ingredients',
    nameColumn: 'name',
    scalarFields: new Set([
      'name', 'description', 'icon', 'calories_kcal', 'protein_g', 'carbs_g',
      'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'category_id',
      // image_urls was missing here too — same "field just never made it
      // onto the sync allowlist" class of gap this session already found
      // and fixed for recipes/tools/techniques.
      'image_urls', 'seasonal_months',
      // Left out of sync until ADR 0006's whole-library pass.
      'synonyms', 'plural_name', 'parent_ingredient_id',
    ]),
  },
  tool: {
    table: 'tools',
    nameColumn: 'name',
    // deleted_at included so a soft-delete on one device (createTool()/
    // updateTool()/deleteTool() in ingredients.local.ts) fast-forwards
    // through Structured Merge like any other field, instead of the
    // deletion silently never reaching other devices.
    scalarFields: new Set(['name', 'category', 'description', 'icon', 'image_urls', 'deleted_at']),
  },
  tag: {
    table: 'tags',
    nameColumn: 'name',
    scalarFields: new Set(['name', 'group_name', 'color', 'icon', 'sort_order', 'exclude_tag_ids', 'deleted_at']),
  },
  technique: {
    table: 'techniques',
    nameColumn: 'name',
    scalarFields: new Set(['name', 'description', 'icon', 'image_urls', 'deleted_at']),
  },
  profile: {
    table: 'profiles',
    nameColumn: 'name',
    scalarFields: new Set(['name', 'avatar_url', 'role', 'deleted_at']),
  },
  // Synced since ADR 0006, on the portable ids db/local.ts rekeyPortableIds()
  // gives them — before, each device had its own random ids for these.
  category: {
    table: 'ingredient_categories',
    nameColumn: 'name',
    scalarFields: new Set(['name', 'description', 'icon', 'color', 'sort_order', 'deleted_at']),
  },
  unit: {
    table: 'units',
    nameColumn: 'name',
    scalarFields: new Set(['name', 'symbol', 'unit_type', 'base_unit_symbol', 'to_base_factor', 'system']),
    hasUpdatedAt: false,
  },
};

// recipes.steps/ingredients/toolIds are normalized child tables, not
// columns on recipes — merged as whole-array fields per ADR 0002. Writing a
// resolved value back means the same delete+insert path recipes.local.ts's
// own create/update logic already uses for its nested rows — see
// writeArrayField() below, called from both applyEntityMergeResult() (an
// automatic fast-forward) and applyResolvedConflict() (a user's explicit
// mine/theirs pick). Field name is `toolIds`, matching the actual key gitSync.ts's
// writeEntityFile()/recipes.local.ts already serialize recipe tool
// associations under — NOT `tools` (ticket 02's Answer uses "tools" as
// shorthand for the concept; the real entity JSON's key is toolIds).
const ARRAY_FIELDS = new Set(['steps', 'ingredients', 'toolIds']);

/** The full set of field names Structured Merge should compare for an
 *  entity type — scalar columns plus, for recipes, the three whole-array
 *  pseudo-fields. Exported so the Sync Engine's merge bridge doesn't need
 *  its own copy of this list to hand to structuredMerge.ts's mergeEntity(). */
export function getMergeableFieldNames(entityType: string): string[] | null {
  const config = ENTITY_CONFIG[entityType];
  if (!config) return null;
  const arrayFields = entityType === 'recipe' ? [...ARRAY_FIELDS] : [];
  // An ingredient's category is merged by NAME. Categories are per-device
  // seed rows with random ids (db/local.ts), so the same "Frutta" has a
  // different category_id on every device: comparing ids flagged every
  // ingredient as changed, and applying one filed every synced-in
  // ingredient under "Uncategorized". syncIngredient() serializes the name
  // alongside; writeScalarField() maps it back to this device's own id.
  const scalars = entityType === 'ingredient'
    ? [...[...config.scalarFields].filter((f) => f !== 'category_id'), CATEGORY_NAME_FIELD]
    : [...config.scalarFields];
  return [...scalars, ...arrayFields, ...(EXTRA_FIELDS[entityType] ?? [])];
}

const CATEGORY_NAME_FIELD = 'category_name';

/** This device's ingredient category for a name, created if it has none —
 *  a category someone made on another device arrives with its first
 *  ingredient instead of that ingredient landing in "Uncategorized". */
export async function resolveCategoryIdByName(name: string, preferredId?: unknown): Promise<string> {
  // Portable ids (ADR 0006) make the incoming id itself usually right.
  if (typeof preferredId === 'string' && preferredId && await queryOne(`SELECT id FROM ingredient_categories WHERE id = $1`, [preferredId])) {
    return preferredId;
  }
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM ingredient_categories WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
    [name]
  );
  if (existing) return existing.id;
  let id = typeof preferredId === 'string' && preferredId ? preferredId : portableCategoryId(name);
  if (await queryOne(`SELECT id FROM ingredient_categories WHERE id = $1`, [id])) id = newId();
  await query(`INSERT INTO ingredient_categories (id, name, icon, color, sort_order) VALUES ($1, $2, 'FaTag', '#71717a', 99)`, [id, name]);
  return id;
}

/** Writes one allowlisted scalar field's value onto an entity row and
 *  bumps updated_at, so the change rides the next normal sync/push per
 *  ticket 03's dirty-tracking — same as any other local edit. Shared by
 *  applyResolvedConflict() and applyEntityMergeResult(), the two places
 *  that write a merge/resolution outcome back onto Local Storage. Throws
 *  for the three whole-array fields or any name outside the entity's
 *  allowlist — callers decide whether that's fatal (applyResolvedConflict,
 *  a single-field operation) or something to catch and report per-field
 *  (applyEntityMergeResult, a batch). */
async function writeScalarField(config: EntityConfig, entityType: string, entityId: string, fieldName: string, value: unknown): Promise<void> {
  if (isExtraField(entityType, fieldName)) {
    await writeExtraField(entityType, entityId, fieldName, value);
    return;
  }
  if (entityType === 'ingredient' && fieldName === CATEGORY_NAME_FIELD) {
    if (typeof value !== 'string' || value.trim() === '') return; // no category to map — keep this device's
    const categoryId = await resolveCategoryIdByName(value.trim());
    await query(`UPDATE ingredients SET category_id = $1, updated_at = now() WHERE id = $2`, [categoryId, entityId]);
    return;
  }
  if (ARRAY_FIELDS.has(fieldName)) {
    throw new Error(
      `writeScalarField: '${fieldName}' is a whole-array field — writing it back requires the nested ` +
      `delete+insert path the future Sync Engine will use, not a plain column UPDATE. Not yet implemented.`
    );
  }
  if (!config.scalarFields.has(fieldName)) {
    throw new Error(`writeScalarField: '${fieldName}' is not a recognized scalar field on '${entityType}'`);
  }
  const touch = config.hasUpdatedAt === false ? '' : ', updated_at = now()';
  await query(`UPDATE ${config.table} SET ${fieldName} = $1${touch} WHERE id = $2`, [value, entityId]);
}

// recipes.steps/ingredients/toolIds are normalized child tables (recipe_
// steps/recipe_ingredients/recipe_tools), so "writing" one means a delete-
// then-reinsert of that table's rows for this recipe — the same pattern
// recipes.local.ts's own updateRecipe() uses, not a column UPDATE. The
// value shape here is exactly what gitSync.ts's writeEntityFile() captured
// in the first place (recipes.local.ts's syncRecipe(): raw `SELECT * FROM
// recipe_ingredients`/`recipe_steps` rows, and a bare array of tool ids —
// see that function's own comment) — so each row's fields are read by
// their snake_case DB column names directly, not through the camelCase
// RecipeInput shape createRecipe()/updateRecipe() take from the UI, which
// this data never passed through.
interface RawRecipeIngredientRow {
  id?: string;
  sort_order?: number;
  ingredient_id?: string | null;
  subtype_id?: string | null;
  sub_recipe_id?: string | null;
  quantity?: number | null;
  quantity_text?: string | null;
  unit_id?: string | null;
  notes?: string | null;
  is_optional?: number | null;
  group_name?: string | null;
  /** The unit's symbol, serialized next to unit_id by syncRecipe() — see
   *  writeArrayField() for why. */
  unit_symbol?: string | null;
  /** [{lang, notes}] — recipe_ingredient_translations, embedded. */
  translations?: unknown;
  /** sortOrder of the row this one is an alternative to — see
   *  db/migrations/042_recipe_ingredient_substitutes.sql. Carried through
   *  here or a recipe arriving from another device would land with its
   *  substitutes turned back into ordinary ingredients. */
  substitute_for?: number | null;
}

interface RawRecipeStepRow {
  id?: string;
  step_number?: number;
  title?: string | null;
  description?: string;
  duration_min?: number | null;
  tool_ids?: unknown;
  technique_ids?: unknown;
  notes?: string | null;
  image_url?: string | null;
  step_ingredients?: unknown;
  /** [{lang, title, description, notes}] — recipe_step_translations, embedded. */
  translations?: unknown;
}

/** Writes one whole-array field's complete value onto a recipe's child
 *  tables, replacing whatever was there — correct for both a brand-new
 *  entity (nothing to replace yet) and a fast-forwarded existing one
 *  (ADR 0002: no per-row identity across devices, so a changed array field
 *  is one opaque value, not row-level deltas). Ids from the incoming rows
 *  are preserved rather than regenerated, so re-syncing the same
 *  unchanged value is idempotent instead of accumulating new row ids each
 *  cycle.
 *
 *  Uses ON CONFLICT(id) DO UPDATE, not a plain INSERT: recipe_ingredients.id/
 *  recipe_steps.id are GLOBAL primary keys (only `UNIQUE(recipe_id,
 *  step_number)` is recipe-scoped — see db/migrations/001_initial_schema.sql),
 *  so the DELETE just above (scoped to `WHERE recipe_id = $1`) does nothing
 *  to protect against an incoming row's id already existing under a
 *  DIFFERENT recipe — a real case, not hypothetical: two independently-
 *  synced devices can each have generated a row with the same id for
 *  unrelated recipes, surfacing as `UNIQUE constraint failed` the moment
 *  this write path first tries to insert one. Upserting instead of
 *  inserting makes the write idempotent no matter which recipe that id
 *  previously belonged to — it ends up owned by (and matching) exactly
 *  this call's `entityId`/values, which is what "this is now the complete,
 *  authoritative array for this recipe" is supposed to mean regardless. */
async function writeArrayField(entityType: string, entityId: string, fieldName: string, value: unknown): Promise<void> {
  if (entityType !== 'recipe' || !ARRAY_FIELDS.has(fieldName)) {
    throw new Error(`writeArrayField: '${fieldName}' is not a whole-array field on '${entityType}'`);
  }

  if (fieldName === 'ingredients') {
    const rows = (value as RawRecipeIngredientRow[] | null) ?? [];
    const unitIds = await localUnitIdsBySymbol(rows);
    await query(`DELETE FROM recipe_ingredient_translations WHERE recipe_ingredient_id IN (SELECT id FROM recipe_ingredients WHERE recipe_id = $1)`, [entityId]);
    await query(`DELETE FROM recipe_ingredients WHERE recipe_id = $1`, [entityId]);
    for (const incoming of rows) {
      // Units are per-device rows with random ids, like categories: the
      // symbol travels with the row and is what picks this device's unit.
      const localUnitId = incoming.unit_symbol ? unitIds.get(incoming.unit_symbol) : undefined;
      const row = localUnitId ? { ...incoming, unit_id: localUnitId } : incoming;
      await query(
        `INSERT INTO recipe_ingredients
           (id, recipe_id, sort_order, ingredient_id, subtype_id, sub_recipe_id, quantity, quantity_text, unit_id, notes, is_optional, group_name, substitute_for)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(id) DO UPDATE SET
           recipe_id = excluded.recipe_id, sort_order = excluded.sort_order, ingredient_id = excluded.ingredient_id,
           subtype_id = excluded.subtype_id, sub_recipe_id = excluded.sub_recipe_id, quantity = excluded.quantity,
           quantity_text = excluded.quantity_text, unit_id = excluded.unit_id, notes = excluded.notes,
           is_optional = excluded.is_optional, group_name = excluded.group_name,
           substitute_for = excluded.substitute_for`,
        [
          row.id ?? newId(), entityId, row.sort_order ?? 0, row.ingredient_id ?? null, row.subtype_id ?? null,
          row.sub_recipe_id ?? null, row.quantity ?? null, row.quantity_text ?? null, row.unit_id ?? null,
          row.notes ?? null, row.is_optional ?? 0, row.group_name ?? null, row.substitute_for ?? null,
        ]
      );
      if (row.id && row.translations !== undefined) await writeRecipeIngredientTranslations(row.id, row.translations);
    }
    return;
  }

  if (fieldName === 'steps') {
    await query(`DELETE FROM recipe_step_translations WHERE step_id IN (SELECT id FROM recipe_steps WHERE recipe_id = $1)`, [entityId]);
    await query(`DELETE FROM recipe_steps WHERE recipe_id = $1`, [entityId]);
    for (const row of (value as RawRecipeStepRow[] | null) ?? []) {
      await query(
        `INSERT INTO recipe_steps
           (id, recipe_id, step_number, title, description, duration_min, tool_ids, technique_ids, notes, image_url, step_ingredients)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT(id) DO UPDATE SET
           recipe_id = excluded.recipe_id, step_number = excluded.step_number, title = excluded.title,
           description = excluded.description, duration_min = excluded.duration_min, tool_ids = excluded.tool_ids,
           technique_ids = excluded.technique_ids, notes = excluded.notes, image_url = excluded.image_url,
           step_ingredients = excluded.step_ingredients`,
        [
          row.id ?? newId(), entityId, row.step_number ?? 0, row.title ?? null, row.description ?? '',
          row.duration_min ?? null, row.tool_ids ?? '[]', row.technique_ids ?? '[]', row.notes ?? null,
          row.image_url ?? null, row.step_ingredients ?? '[]',
        ]
      );
      if (row.id && row.translations !== undefined) await writeStepTranslations(row.id, row.translations);
    }
    return;
  }

  // toolIds
  await query(`DELETE FROM recipe_tools WHERE recipe_id = $1`, [entityId]);
  for (const toolId of (value as string[] | null) ?? []) {
    await query(`INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [entityId, toolId]);
  }
}

async function localUnitIdsBySymbol(rows: RawRecipeIngredientRow[]): Promise<Map<string, string>> {
  const symbols = [...new Set(rows.map((r) => r.unit_symbol).filter((s): s is string => !!s))];
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map((_, i) => `$${i + 1}`).join(', ');
  const found = await query<{ id: string; symbol: string }>(`SELECT id, symbol FROM units WHERE symbol IN (${placeholders})`, symbols);
  return new Map(found.map((u) => [u.symbol, u.id]));
}

// ── Readable lines for the Conflicts list's diff view ───────────────────
// ADR 0002 still stands — these three fields have no per-row identity, so
// this doesn't turn them into a real per-row merge. It just renders the
// same whole-array values the count-only view already had access to as
// short human-readable lines (resolving ingredient/subtype/sub-recipe/
// unit/tool ids through this device's own local tables), so lineDiff.ts's
// existing LCS diff — already used for tags/regions — has readable text to
// work with instead of raw row objects, which is what steps/ingredients
// actually needed to stop being "3 items vs 0 items" with no further detail.
// An id this device doesn't have locally yet (e.g. an ingredient only the
// other device knows about) falls back to a short id label rather than
// failing the whole diff.

async function idLabelMap(table: string, column: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter((id): id is string => !!id))];
  if (clean.length === 0) return new Map();
  const placeholders = clean.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await query<{ id: string; label: string }>(
    `SELECT id, ${column} AS label FROM ${table} WHERE id IN (${placeholders})`,
    clean
  );
  return new Map(rows.map((r) => [r.id, r.label]));
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

// Array-of-id fields — anywhere an entity holds a bare list of another
// table's ids — get the same "resolve to a name" treatment `toolIds` needed
// first: a raw UUID list diffs correctly (LCS still matches/mismatches ids
// fine) but reads as noise. `steps`/`ingredients` aren't here because
// they're arrays of ROW OBJECTS, not ids — see formatStepLine()/
// formatIngredientLine() below for those two instead.
const ID_ARRAY_FIELDS: Record<string, Record<string, { table: string; column: string; label: string }>> = {
  recipe: { toolIds: { table: 'tools', column: 'name', label: 'tool' } },
  tag: { exclude_tag_ids: { table: 'tags', column: 'name', label: 'tag' } },
  ingredient: { tag_ids: { table: 'tags', column: 'name', label: 'tag' } },
};

function formatStepLine(row: RawRecipeStepRow): string {
  const num = row.step_number != null ? `${row.step_number}. ` : '';
  const title = row.title ? `${row.title}: ` : '';
  const duration = row.duration_min ? ` (${row.duration_min} min)` : '';
  return `${num}${title}${row.description ?? ''}${duration}`.trim();
}

function formatIngredientLine(
  row: RawRecipeIngredientRow,
  names: { ingredient: Map<string, string>; subtype: Map<string, string>; recipe: Map<string, string>; unit: Map<string, string> }
): string {
  const unitSymbol = (row.unit_id ? names.unit.get(row.unit_id) : undefined) ?? row.unit_symbol ?? undefined;
  const qty = row.quantity_text || (row.quantity != null ? `${row.quantity}${unitSymbol ? ` ${unitSymbol}` : ''}` : '');

  let label: string;
  if (row.ingredient_id) {
    const base = names.ingredient.get(row.ingredient_id) ?? `ingredient ${shortId(row.ingredient_id)}`;
    const subtype = row.subtype_id ? names.subtype.get(row.subtype_id) : undefined;
    label = subtype ? `${base} (${subtype})` : base;
  } else if (row.sub_recipe_id) {
    label = `${names.recipe.get(row.sub_recipe_id) ?? `recipe ${shortId(row.sub_recipe_id)}`} (sub-recipe)`;
  } else {
    label = 'ingredient';
  }

  const parts = [qty, label].filter(Boolean);
  if (row.notes) parts.push(`— ${row.notes}`);
  if (row.is_optional) parts.push('(optional)');
  return parts.join(' ');
}

/** Renders one array-valued conflict field as short human-readable lines,
 *  for lineDiff.ts to diff against the other side. Covers three shapes:
 *  recipe.steps/ingredients (whole-array row objects, ADR 0002 — bespoke
 *  formatting below), any registered id-array field (ID_ARRAY_FIELDS —
 *  resolved to names), and any other plain array of primitives (tags,
 *  regions, image_urls, seasonal_months, ...), which needs no resolution
 *  and diffs fine as its own string form. Throws only for an array of
 *  objects this hasn't been taught to format (e.g. recipe.sources) —
 *  callers fall back to the count-only view for those. */
export async function formatArrayFieldLines(entityType: string, fieldName: string, value: unknown): Promise<string[]> {
  const arr = (value as unknown[] | null) ?? [];

  if (entityType === 'recipe' && fieldName === 'steps') {
    return (arr as RawRecipeStepRow[]).map(formatStepLine);
  }

  if (entityType === 'recipe' && fieldName === 'ingredients') {
    const rows = arr as RawRecipeIngredientRow[];
    const [ingredientNames, subtypeNames, recipeNames, unitSymbols] = await Promise.all([
      idLabelMap('ingredients', 'name', rows.map((r) => r.ingredient_id)),
      idLabelMap('ingredient_subtypes', 'name', rows.map((r) => r.subtype_id)),
      idLabelMap('recipes', 'title', rows.map((r) => r.sub_recipe_id)),
      idLabelMap('units', 'symbol', rows.map((r) => r.unit_id)),
    ]);
    return rows.map((row) => formatIngredientLine(row, { ingredient: ingredientNames, subtype: subtypeNames, recipe: recipeNames, unit: unitSymbols }));
  }

  const idField = ID_ARRAY_FIELDS[entityType]?.[fieldName];
  if (idField) {
    const ids = arr.filter((id): id is string => typeof id === 'string');
    const names = await idLabelMap(idField.table, idField.column, ids);
    return ids.map((id) => names.get(id) ?? `${idField.label} ${shortId(id)}`);
  }

  if (arr.every((v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
    return arr.map((v) => String(v));
  }

  throw new Error(`formatArrayFieldLines: don't know how to format '${entityType}.${fieldName}' as diffable lines`);
}

/** Re-commits one entity into the Hidden Clone after a local write —
 *  applyResolvedConflict() needs this because writeScalarField()/
 *  writeArrayField() only update Local Storage's own row; without an
 *  explicit re-sync, a resolved conflict would never reach the Sync
 *  Folder or any other device (the exact gap mergeBridge.ts's own
 *  writeEntityFile() call after a merge — see gitSync.ts's
 *  applyMergeIfNeeded() — doesn't have, since that path already commits).
 *  Each syncX() function is itself fire-and-forget (catches and logs its
 *  own errors, per its own docstring), so this never throws. */
async function resyncEntityToGit(entityType: string, entityId: string): Promise<void> {
  switch (entityType) {
    case 'recipe': {
      const { syncRecipe } = await import('./recipes.local');
      return syncRecipe(entityId);
    }
    case 'ingredient': {
      const { syncIngredient } = await import('./ingredients.local');
      return syncIngredient(entityId);
    }
    case 'tool': {
      const { syncTool } = await import('./ingredients.local');
      return syncTool(entityId);
    }
    case 'tag': {
      const { syncTag } = await import('./tags.local');
      return syncTag(entityId);
    }
    case 'technique': {
      const { syncTechnique } = await import('./techniques.local');
      return syncTechnique(entityId);
    }
    case 'profile': {
      const { syncProfile } = await import('./profiles.local');
      return syncProfile(entityId);
    }
    case 'category': {
      const { syncCategory } = await import('./ingredients.local');
      return syncCategory(entityId);
    }
    case 'unit': {
      const { syncUnit } = await import('./ingredients.local');
      return syncUnit(entityId);
    }
  }
}

/** Writes a resolved conflict's chosen value onto the entity's own row,
 *  then re-commits that entity into the Hidden Clone so the resolution
 *  actually propagates on the next sync — writing the row alone (what
 *  this function used to do) left the fix stranded on this device only. */
export async function applyResolvedConflict(resolved: ResolvedConflict): Promise<void> {
  const config = ENTITY_CONFIG[resolved.entityType];
  if (!config) {
    throw new Error(`applyResolvedConflict: unknown entity type '${resolved.entityType}'`);
  }
  if (ARRAY_FIELDS.has(resolved.fieldName)) {
    await writeArrayField(resolved.entityType, resolved.entityId, resolved.fieldName, resolved.chosenValue);
  } else {
    await writeScalarField(config, resolved.entityType, resolved.entityId, resolved.fieldName, resolved.chosenValue);
  }
  await resyncEntityToGit(resolved.entityType, resolved.entityId);
}

export interface ApplyMergeOutcome {
  /** Fields actually written — scalar columns via writeScalarField(), the
   *  three whole-array recipe fields via writeArrayField(). */
  appliedFields: string[];
  /** Always empty today (every field getMergeableFieldNames() can produce
   *  is now writable) — kept so a caller can't mistake "not applied" for
   *  "nothing changed" if a future field type isn't wired up here yet. */
  unsupportedFields: string[];
  conflictsRecorded: number;
}

/** The other half of structuredMerge.ts's mergeEntity() — takes its result
 *  for one entity and makes it real: each conflict becomes a sync_conflicts
 *  row via upsertConflict() first (recorded regardless of what happens
 *  next, so a later field write failure can never lose an already-detected
 *  conflict — the two halves are independent, same as mergeEntity() itself
 *  treats fields independently), then fast-forwarded fields get written.
 *  Called from the Sync Engine's pull step (mergeBridge.ts) once it's
 *  fetched base/local/remote values out of git objects — this function
 *  doesn't care where those values came from. */
export interface ApplyMergeOptions {
  /** Each side's entity updated_at, stored with any conflict recorded. */
  localUpdatedAt?: string | null;
  remoteUpdatedAt?: string | null;
}

/** The later of two updated_at values, in its original spelling. */
export function laterTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = parseTimestamp(a);
  const tb = parseTimestamp(b);
  if (ta === null) return tb === null ? null : b ?? null;
  if (tb === null) return a ?? null;
  return tb > ta ? b ?? null : a ?? null;
}

export async function applyEntityMergeResult(
  entityType: string,
  entityId: string,
  result: EntityMergeResult,
  options: ApplyMergeOptions = {}
): Promise<ApplyMergeOutcome> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    throw new Error(`applyEntityMergeResult: unknown entity type '${entityType}'`);
  }

  for (const conflict of result.conflicts) {
    await upsertConflict({
      entityType,
      entityId,
      fieldName: conflict.fieldName,
      baseValue: conflict.baseValue,
      localValue: conflict.localValue,
      remoteValue: conflict.remoteValue,
      localUpdatedAt: options.localUpdatedAt ?? null,
      remoteUpdatedAt: options.remoteUpdatedAt ?? null,
    });
  }

  const appliedFields: string[] = [];
  const unsupportedFields: string[] = [];

  for (const [fieldName, value] of Object.entries(result.applied)) {
    if (ARRAY_FIELDS.has(fieldName)) {
      await writeArrayField(entityType, entityId, fieldName, value);
    } else {
      await writeScalarField(config, entityType, entityId, fieldName, value);
    }
    appliedFields.push(fieldName);
  }

  // writeScalarField() stamps updated_at with now(), which made a merge look
  // like a fresh edit made at sync time — and the 'newest' policy compares
  // exactly this column. A merge takes the later of the two real edit times.
  const mergedUpdatedAt = laterTimestamp(options.localUpdatedAt, options.remoteUpdatedAt);
  if (appliedFields.length > 0 && mergedUpdatedAt && config.hasUpdatedAt !== false) {
    await query(`UPDATE ${config.table} SET updated_at = $1 WHERE id = $2`, [mergedUpdatedAt, entityId]);
  }

  return { appliedFields, unsupportedFields, conflictsRecorded: result.conflicts.length };
}

// ── Keeping pending conflicts git-correct ───────────────────────────────
// A merge commit makes the remote commit an ancestor (ADR 0006), so
// whatever this device's tree holds for a field is, to every other device,
// "this device's edit". For a field still waiting on the user that must be
// the REMOTE value — otherwise the other device fast-forwards to this
// device's side before anyone chose it. So a pending conflict's field is
// always serialized with its remote value until it is resolved; picking
// "mine" then rewrites the file with the local value, which travels as a
// normal edit.

/** Pending conflicts for the whole library, keyed `${entityType}:${entityId}`
 *  — one query per sync rather than one per entity. */
export async function loadPendingConflictIndex(): Promise<Map<string, SyncConflict[]>> {
  const index = new Map<string, SyncConflict[]>();
  for (const conflict of await listPendingConflicts()) {
    const key = `${conflict.entityType}:${conflict.entityId}`;
    const list = index.get(key);
    if (list) list.push(conflict);
    else index.set(key, [conflict]);
  }
  return index;
}

/** Returns `data` with each pending-conflict field replaced by its remote
 *  value, for writing into the Hidden Clone. Also refreshes the row's
 *  local side when this device's value has moved on since it was recorded,
 *  so the Conflicts card never offers a stale "mine". */
export async function overlayPendingConflicts(
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
  pending?: SyncConflict[]
): Promise<Record<string, unknown>> {
  const conflicts = pending ?? (await listPendingConflictsForEntity(entityType, entityId));
  if (conflicts.length === 0) return data;
  const out = { ...data };
  for (const conflict of conflicts) {
    if (!(conflict.fieldName in data)) continue;
    const current = data[conflict.fieldName];
    if (!fieldValuesEqual(conflict.fieldName, current, conflict.localValue)) {
      await query(`UPDATE sync_conflicts SET local_value = $1, local_updated_at = $2 WHERE id = $3`, [
        JSON.stringify(current),
        typeof data.updated_at === 'string' ? data.updated_at : conflict.localUpdatedAt,
        conflict.id,
      ]);
    }
    out[conflict.fieldName] = conflict.remoteValue;
  }
  return out;
}

/** True if this entity type is recognized AND a row with this id already
 *  exists in Local Storage — the Sync Engine's pull step needs this to
 *  decide between creating a brand-new entity introduced by another
 *  device (INSERT) and merging into one that already exists here
 *  (applyEntityMergeResult()'s UPDATE-per-field path). */
export async function entityExists(entityType: string, entityId: string): Promise<boolean> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) return false;
  const row = await queryOne(`SELECT id FROM ${config.table} WHERE id = $1`, [entityId]);
  return row !== null;
}

/** Creates a brand-new entity row from a complete field set (typically an
 *  entire remote entity JSON, as extracted from a git blob) — used when
 *  the Sync Engine's pull step finds an entity on the remote side that
 *  doesn't exist locally at all yet, so there's nothing to merge into.
 *  Unlike applyEntityMergeResult()'s per-field UPDATE, this is a plain
 *  INSERT of every recognized scalar field present in `fields` (id is
 *  supplied separately, not read off `fields`, so a caller can't
 *  accidentally let the row's own id field silently retarget the insert).
 *  ON CONFLICT DO NOTHING — if the row somehow already exists (a race with
 *  another write), this is a no-op rather than clobbering it; the caller
 *  should have checked entityExists() first for a normal call. For a
 *  recipe, also writes whole-array fields (steps/ingredients/toolIds) via
 *  writeArrayField() — but only when this call is the one actually
 *  creating the row (checked *before* the INSERT, not after: entityExists()
 *  would read back true either way once the row is there, so checking
 *  post-insert couldn't tell "I just created this" from "it was already
 *  here" and would let a losing race overwrite the real row's nested data). */
export async function createEntity(entityType: string, entityId: string, fields: Record<string, unknown>): Promise<void> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) {
    throw new Error(`createEntity: unknown entity type '${entityType}'`);
  }
  const alreadyExists = await entityExists(entityType, entityId);
  if (entityType === 'ingredient' && typeof fields[CATEGORY_NAME_FIELD] === 'string' && (fields[CATEGORY_NAME_FIELD] as string).trim()) {
    // See getMergeableFieldNames(): the category travels by name.
    fields = { ...fields, category_id: await resolveCategoryIdByName((fields[CATEGORY_NAME_FIELD] as string).trim(), fields.category_id) };
  }
  if (entityType === 'ingredient' && typeof fields.parent_ingredient_id === 'string'
      && !(await queryOne(`SELECT id FROM ingredients WHERE id = $1`, [fields.parent_ingredient_id]))) {
    // parent_ingredient_id is a real foreign key; mergeBridge.ts writes
    // parents first, so a missing parent means it isn't coming this cycle.
    fields = { ...fields, parent_ingredient_id: null };
  }
  const recognized = Object.entries(fields).filter(([k]) => config.scalarFields.has(k) && !ARRAY_FIELDS.has(k));
  const columns = ['id', ...recognized.map(([k]) => k)];
  const values: unknown[] = [entityId, ...recognized.map(([, v]) => v)];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  await query(`INSERT INTO ${config.table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`, values);

  if (!alreadyExists && entityType === 'recipe') {
    for (const fieldName of ARRAY_FIELDS) {
      if (fieldName in fields) await writeArrayField(entityType, entityId, fieldName, fields[fieldName]);
    }
  }
  if (!alreadyExists) {
    for (const fieldName of EXTRA_FIELDS[entityType] ?? []) {
      if (fieldName in fields) await writeExtraField(entityType, entityId, fieldName, fields[fieldName]);
    }
  }
}

/** The entity's own display name (title/name column), for the Conflicts
 *  list UI. Null if the entity type is unrecognized or the row is gone. */
export async function getEntityDisplayName(entityType: string, entityId: string): Promise<string | null> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) return null;
  const row = await queryOne<{ name: unknown }>(`SELECT ${config.nameColumn} as name FROM ${config.table} WHERE id = $1`, [entityId]);
  return row ? String(row.name) : null;
}

/** Drops a pending conflict's record without writing anything — for one
 *  a later merge found already settled. */
export async function deleteConflict(id: string): Promise<void> {
  await query(`DELETE FROM sync_conflicts WHERE id = $1`, [id]);
}

/** Resolves a pending conflict by deleting its record and reporting which
 *  value the user picked. Applying that value back onto the entity's own
 *  row — and letting it ride the next normal sync per its bumped
 *  updated_at — is the caller's job; this module only owns the conflict
 *  record's lifecycle. Returns null if `id` isn't a pending conflict. */
export async function resolveConflict(id: string, chosen: 'local' | 'remote'): Promise<ResolvedConflict | null> {
  const row = await queryOne<ConflictRow>(`SELECT * FROM sync_conflicts WHERE id = $1`, [id]);
  if (!row) return null;
  await query(`DELETE FROM sync_conflicts WHERE id = $1`, [id]);
  const conflict = fromRow(row);
  return {
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    fieldName: conflict.fieldName,
    chosenValue: chosen === 'local' ? conflict.localValue : conflict.remoteValue,
  };
}

// ── Settling pending conflicts without asking ───────────────────────────
// ADR 0006: ask only when there is no obvious answer. Covers the backlog
// recorded before these rules existed as well as anything recorded since.

type ConflictDecision = { value: unknown; reason: 'equal' | 'empty-side' | 'set-merge' | 'newest' | 'user' };

async function entityUpdatedAt(entityType: string, entityId: string): Promise<string | null> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) return null;
  const row = await queryOne<{ updated_at: string | null }>(`SELECT updated_at FROM ${config.table} WHERE id = $1`, [entityId]);
  return row?.updated_at ?? null;
}

/** Which side of a conflict is newer, or null when that can't be told. */
export function newerSide(conflict: Pick<SyncConflict, 'localUpdatedAt' | 'remoteUpdatedAt'>): 'local' | 'remote' | null {
  const l = parseTimestamp(conflict.localUpdatedAt);
  const r = parseTimestamp(conflict.remoteUpdatedAt);
  if (l === null || r === null || l === r) return null;
  return l > r ? 'local' : 'remote';
}

/** The rule-based answer for one conflict, or null if it has to be asked. */
function decideConflict(conflict: SyncConflict, policy: ConflictPolicy): ConflictDecision | null {
  const { fieldName, localValue, remoteValue, baseValue } = conflict;
  if (fieldValuesEqual(fieldName, localValue, remoteValue)) return { value: localValue, reason: 'equal' };
  if (isEmptyValue(localValue)) return { value: remoteValue, reason: 'empty-side' };
  if (isEmptyValue(remoteValue)) return { value: localValue, reason: 'empty-side' };
  const hasBase = baseValue !== null && baseValue !== undefined;
  if (SET_FIELDS.has(fieldName)) {
    return { value: mergeSetField(baseValue, localValue, remoteValue, hasBase), reason: 'set-merge' };
  }
  if (fieldName in KEYED_LIST_FIELDS) {
    const merged = mergeKeyedList(fieldName, baseValue, localValue, remoteValue, hasBase);
    if (merged.conflicts.length === 0) return { value: merged.value, reason: 'set-merge' };
    const side = policy === 'newest' ? newerSide(conflict) : null;
    if (side) return { value: mergeKeyedList(fieldName, baseValue, localValue, remoteValue, hasBase, side).value, reason: 'newest' };
    return null;
  }
  if (policy === 'newest') {
    const side = newerSide(conflict);
    if (side) return { value: side === 'local' ? localValue : remoteValue, reason: 'newest' };
  }
  return null;
}

async function writeChosenValue(entityType: string, entityId: string, fieldName: string, value: unknown): Promise<void> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) throw new Error(`writeChosenValue: unknown entity type '${entityType}'`);
  if (ARRAY_FIELDS.has(fieldName)) await writeArrayField(entityType, entityId, fieldName, value);
  else await writeScalarField(config, entityType, entityId, fieldName, value);
}

async function settle(conflicts: Array<{ conflict: SyncConflict; value: unknown }>): Promise<void> {
  const entities = new Map<string, { entityType: string; entityId: string }>();
  for (const { conflict, value } of conflicts) {
    await query(`DELETE FROM sync_conflicts WHERE id = $1`, [conflict.id]);
    await writeChosenValue(conflict.entityType, conflict.entityId, conflict.fieldName, value);
    entities.set(`${conflict.entityType}:${conflict.entityId}`, { entityType: conflict.entityType, entityId: conflict.entityId });
  }
  // Once per entity, after every field is written: each re-serialization
  // is a full row + child-table read on Android's bridge.
  for (const { entityType, entityId } of entities.values()) await resyncEntityToGit(entityType, entityId);
}

export interface AutoResolveOutcome {
  resolved: number;
  remaining: number;
}

/** Settles every pending conflict a rule can decide: equal after
 *  normalization, one side empty, a set field (merged member by member),
 *  or — under the 'newest' policy — the side edited last. Rows recorded
 *  before timestamps were stored get them filled in first, from this
 *  device's row and from `remoteUpdatedAt` (the synced copy's own
 *  updated_at, read from git by the caller). */
export async function autoResolvePendingConflicts(
  policy: ConflictPolicy,
  remoteUpdatedAt?: (entityType: string, entityId: string) => Promise<string | null>
): Promise<AutoResolveOutcome> {
  const pending = await listPendingConflicts();
  const decided: Array<{ conflict: SyncConflict; value: unknown }> = [];
  let remaining = 0;
  for (const original of pending) {
    let conflict = original;
    if (policy === 'newest' && (!conflict.localUpdatedAt || !conflict.remoteUpdatedAt)) {
      conflict = {
        ...conflict,
        localUpdatedAt: conflict.localUpdatedAt ?? (await entityUpdatedAt(conflict.entityType, conflict.entityId)),
        remoteUpdatedAt: conflict.remoteUpdatedAt ?? (remoteUpdatedAt ? await remoteUpdatedAt(conflict.entityType, conflict.entityId) : null),
      };
    }
    const decision = decideConflict(conflict, policy);
    if (decision) decided.push({ conflict, value: decision.value });
    else remaining++;
  }
  await settle(decided);
  return { resolved: decided.length, remaining };
}

/** The Conflicts card's per-entity bulk actions: keep every field from one
 *  side, or from whichever side is newer (fields where that can't be told
 *  are left pending). Returns how many fields were settled. */
export async function resolveEntityConflicts(
  entityType: string,
  entityId: string,
  choice: 'local' | 'remote' | 'newest'
): Promise<number> {
  const pending = await listPendingConflictsForEntity(entityType, entityId);
  const decided: Array<{ conflict: SyncConflict; value: unknown }> = [];
  for (const conflict of pending) {
    const side = choice === 'newest' ? newerSide(conflict) : choice;
    if (!side) continue;
    decided.push({ conflict, value: side === 'local' ? conflict.localValue : conflict.remoteValue });
  }
  await settle(decided);
  return decided.length;
}

// ── Replacing this device's library with the synced one ─────────────────
// "Sostituisci con i dati sincronizzati" (gitSync.ts replaceLocalWithRemote).
// Rows are overwritten in place rather than the tables being wiped:
// cook_log cascades from recipes, and collections/menus point at recipe ids,
// so a wipe-and-recreate would throw away this device's cooking history for
// recipes that still exist on the other side.

/** Ids of every row of a synced entity type held on this device. */
export async function listLocalEntityIds(entityType: string): Promise<string[]> {
  const config = ENTITY_CONFIG[entityType];
  if (!config) return [];
  const rows = await query<{ id: string }>(`SELECT id FROM ${config.table}`);
  return rows.map((r) => r.id);
}

/** Makes one local row exactly the synced copy: every mergeable field the
 *  copy carries is written, created if the row doesn't exist yet. */
export async function forceApplyEntity(entityType: string, entityId: string, remote: Record<string, unknown>): Promise<void> {
  if (!(await entityExists(entityType, entityId))) {
    await createEntity(entityType, entityId, remote);
    return;
  }
  const fieldNames = getMergeableFieldNames(entityType) ?? [];
  const applied: Record<string, unknown> = {};
  for (const fieldName of fieldNames) {
    if (fieldName in remote) applied[fieldName] = remote[fieldName];
  }
  const updatedAt = typeof remote.updated_at === 'string' ? remote.updated_at : null;
  await applyEntityMergeResult(entityType, entityId, { applied, conflicts: [] }, { localUpdatedAt: updatedAt, remoteUpdatedAt: updatedAt });
}

/** Removes a row this device holds and the synced library doesn't.
 *  Profiles are never removed — the active one is this device's identity. */
export async function discardLocalEntity(entityType: string, entityId: string): Promise<void> {
  const config = ENTITY_CONFIG[entityType];
  if (!config || entityType === 'profile') return;
  if (entityType === 'recipe') {
    // No FK from these two, so nothing else would clear them.
    await query(`DELETE FROM collection_recipes WHERE recipe_id = $1`, [entityId]);
    await query(`DELETE FROM menu_items WHERE recipe_id = $1`, [entityId]);
  }
  if (entityType === 'ingredient') {
    await query(`UPDATE ingredients SET parent_ingredient_id = NULL WHERE parent_ingredient_id = $1`, [entityId]);
  }
  await query(`DELETE FROM ${config.table} WHERE id = $1`, [entityId]);
}

export async function clearAllConflicts(): Promise<void> {
  await query(`DELETE FROM sync_conflicts`);
}
