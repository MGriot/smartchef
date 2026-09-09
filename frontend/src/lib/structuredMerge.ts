// ════════════════════════════════════════════════════════════════════════
// SmartChef — Structured Merge (wayfinder ticket 02, ADR 0001/0002)
// The field-level 3-way merge decided across the standalone-storage-sync
// map: compare parsed values (not git's raw text merge) against a common
// ancestor, per field, independently — a conflict on one field never
// blocks another field's fast-forward. Whole-array fields (recipes.steps/
// ingredients/tools) are compared as one opaque value per ADR 0002, not
// decomposed per-row — any divergence on both sides is a conflict on the
// whole array, exactly like a scalar field.
//
// Deliberately pure and git-agnostic: it takes plain base/local/remote
// values in, decides what changed, and returns the answer — it has no
// idea where those values came from (a git blob, a test fixture, whatever)
// and no side effects. The future Sync Engine's git-plumbing layer (ticket
// 01's hand-rolled object/ref access) is what will eventually feed this;
// this module doesn't need that layer to exist to be correct or useful.
// ════════════════════════════════════════════════════════════════════════

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export type FieldMergeResult =
  | { type: 'unchanged' }
  | { type: 'fast-forward'; value: unknown }
  | { type: 'keep-local' }
  | { type: 'conflict'; base: unknown; local: unknown; remote: unknown };

/** Merges one field's three versions. Applies uniformly to scalars and
 *  whole-array fields alike — the caller decides what "a field" means
 *  (a column, or one of the three whole-array pseudo-fields on a recipe). */
export function mergeField(base: unknown, local: unknown, remote: unknown): FieldMergeResult {
  const localChanged = !deepEqual(local, base);
  const remoteChanged = !deepEqual(remote, base);

  if (!localChanged && !remoteChanged) return { type: 'unchanged' };
  if (localChanged && !remoteChanged) return { type: 'keep-local' };
  if (!localChanged && remoteChanged) return { type: 'fast-forward', value: remote };
  // Both sides changed. If they landed on the same value independently,
  // that's not a real conflict — nothing to reconcile.
  if (deepEqual(local, remote)) return { type: 'unchanged' };
  return { type: 'conflict', base, local, remote };
}

export interface EntityConflict {
  fieldName: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
}

export interface EntityMergeResult {
  /** Fields that fast-forwarded to the remote value — the caller writes
   *  these onto the entity's own row. Fields left untouched (unchanged or
   *  keep-local) are deliberately absent, not present with a same value. */
  applied: Record<string, unknown>;
  /** Fields where both sides changed to genuinely different values. */
  conflicts: EntityConflict[];
}

/** Merges every named field of an entity independently. `fieldNames` is
 *  the full set to consider — scalar columns and, for recipes, the three
 *  whole-array pseudo-fields ('steps'/'ingredients'/'tools') alongside
 *  them; any other keys present on the objects are ignored. */
export function mergeEntity(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fieldNames: string[]
): EntityMergeResult {
  const applied: Record<string, unknown> = {};
  const conflicts: EntityConflict[] = [];

  for (const fieldName of fieldNames) {
    const result = mergeField(base[fieldName], local[fieldName], remote[fieldName]);
    if (result.type === 'fast-forward') {
      applied[fieldName] = result.value;
    } else if (result.type === 'conflict') {
      conflicts.push({ fieldName, baseValue: result.base, localValue: result.local, remoteValue: result.remote });
    }
  }

  return { applied, conflicts };
}
