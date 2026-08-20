// ════════════════════════════════════════════════════════════════════════
// SmartChef — Structured Merge conflict records (standalone mode)
// wayfinder ticket 04 (standalone-storage-sync map, ADR 0001/0002): one row
// per pending conflict on a single (entity, field) pair, surfaced to the
// user instead of auto-resolved. Data-model layer only — writing a chosen
// value back onto the entity's own row, and creating conflicts during an
// actual sync cycle, are the future Sync Engine's job (not built yet); this
// module just owns the conflict record's own lifecycle.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";

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
}

/** Records a genuine Structured Merge conflict — a field that changed on
 *  both sides since the common ancestor. One live row per (entity, field):
 *  a repeated sync before the user resolves the existing conflict refreshes
 *  remote_value/base_value/detected_at in place rather than accumulating
 *  duplicates. `local_value` deliberately is NOT refreshed on an upsert —
 *  it stays pinned to what this device's field held when the conflict was
 *  first detected, matching "the conflicted field keeps showing this
 *  device's own local value, untouched" (ticket 04's Answer); only the
 *  incoming remote side is expected to change across repeated syncs. */
export async function upsertConflict(input: UpsertConflictInput): Promise<void> {
  await query(
    `INSERT INTO sync_conflicts (id, entity_type, entity_id, field_name, base_value, local_value, remote_value, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
       base_value = excluded.base_value,
       remote_value = excluded.remote_value,
       detected_at = now()`,
    [
      newId(),
      input.entityType,
      input.entityId,
      input.fieldName,
      JSON.stringify(input.baseValue),
      JSON.stringify(input.localValue),
      JSON.stringify(input.remoteValue),
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

const TABLE_BY_ENTITY: Record<string, string> = {
  recipe: 'recipes',
  ingredient: 'ingredients',
  tool: 'tools',
  tag: 'tags',
  technique: 'techniques',
};

const NAME_COLUMN_BY_ENTITY: Record<string, string> = {
  recipe: 'title',
  ingredient: 'name',
  tool: 'name',
  tag: 'name',
  technique: 'name',
};

// recipes.steps/ingredients/tools are normalized child tables, not columns
// on recipes — merged as whole-array fields per ADR 0002. Writing a
// resolved value back means the same delete+insert path recipes.local.ts's
// own create/update logic already uses for its nested rows, which isn't
// reachable as a standalone "write just this one field" operation yet.
const ARRAY_FIELDS = new Set(['steps', 'ingredients', 'tools']);

/** Exposed so the Conflicts list UI can tell which fields it can't offer a
 *  resolution button for yet, without duplicating this list. */
export const ARRAY_FIELD_NAMES: ReadonlySet<string> = ARRAY_FIELDS;

const SCALAR_FIELDS_BY_ENTITY: Record<string, Set<string>> = {
  recipe: new Set([
    'title', 'description', 'difficulty', 'servings', 'prep_time_min', 'cook_time_min',
    'rest_time_min', 'rating', 'yield_amount', 'yield_unit_id', 'cover_image_url',
    'source_url', 'is_component', 'language_code',
  ]),
  ingredient: new Set([
    'name', 'description', 'icon', 'calories_kcal', 'protein_g', 'carbs_g',
    'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'category_id',
  ]),
  tool: new Set(['name', 'category', 'description', 'icon']),
  tag: new Set(['name', 'group_name', 'color', 'icon', 'sort_order']),
  technique: new Set(['name', 'description', 'icon']),
};

/** Writes a resolved conflict's chosen value onto the entity's own row and
 *  bumps updated_at, so the change rides the next normal sync/push per
 *  ticket 03's dirty-tracking — same as any other local edit. Scalar
 *  fields only; the three whole-array recipe fields throw (see ARRAY_FIELDS
 *  above) rather than silently doing the wrong thing. */
export async function applyResolvedConflict(resolved: ResolvedConflict): Promise<void> {
  const table = TABLE_BY_ENTITY[resolved.entityType];
  if (!table) {
    throw new Error(`applyResolvedConflict: unknown entity type '${resolved.entityType}'`);
  }
  if (ARRAY_FIELDS.has(resolved.fieldName)) {
    throw new Error(
      `applyResolvedConflict: '${resolved.fieldName}' is a whole-array field — writing it back requires the ` +
      `nested delete+insert path the future Sync Engine will use, not a plain column UPDATE. Not yet implemented.`
    );
  }
  const allowedFields = SCALAR_FIELDS_BY_ENTITY[resolved.entityType];
  if (!allowedFields?.has(resolved.fieldName)) {
    throw new Error(`applyResolvedConflict: '${resolved.fieldName}' is not a recognized scalar field on '${resolved.entityType}'`);
  }
  await query(`UPDATE ${table} SET ${resolved.fieldName} = $1, updated_at = now() WHERE id = $2`, [resolved.chosenValue, resolved.entityId]);
}

/** The entity's own display name (title/name column), for the Conflicts
 *  list UI. Null if the entity type is unrecognized or the row is gone. */
export async function getEntityDisplayName(entityType: string, entityId: string): Promise<string | null> {
  const table = TABLE_BY_ENTITY[entityType];
  const nameColumn = NAME_COLUMN_BY_ENTITY[entityType];
  if (!table || !nameColumn) return null;
  const row = await queryOne<{ name: unknown }>(`SELECT ${nameColumn} as name FROM ${table} WHERE id = $1`, [entityId]);
  return row ? String(row.name) : null;
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
