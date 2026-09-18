// ════════════════════════════════════════════════════════════════════════
// SmartChef — Structured Merge (wayfinder ticket 02, ADR 0001/0002/0006)
// The field-level 3-way merge decided across the standalone-storage-sync
// map: compare parsed values (not git's raw text merge) against a common
// ancestor, per field, independently — a conflict on one field never
// blocks another field's fast-forward. Whole-array fields (recipes.steps/
// ingredients/tools) are compared as one value per ADR 0002, not
// decomposed per-row.
//
// ADR 0006 made it behave the way git does for the cases a person would
// never want to be asked about:
//   - values are compared after normalization (mergeNormalize.ts), so row
//     ids, row order, JSON-string spelling and null-vs-"" stop counting as
//     edits;
//   - with no common ancestor (two devices that have never merged before),
//     a field empty on one side simply takes the other side's value;
//   - set-like fields (tags, regions, ...) merge member by member;
//   - when both sides really did change a field differently, the policy
//     decides: 'newest' (the default) keeps the side whose entity was
//     edited last, 'ask' records a conflict for the user. Missing or equal
//     timestamps are the one case 'newest' can't decide, so they are asked.
//
// Deliberately pure and git-agnostic: plain values in, a decision out.
// ════════════════════════════════════════════════════════════════════════

import { fieldValuesEqual, isEmptyValue, mergeKeyedList, mergeSetField, parseTimestamp, KEYED_LIST_FIELDS, SET_FIELDS } from './mergeNormalize';

export type ConflictPolicy = 'newest' | 'ask';

export interface FieldMergeContext {
  /** Name of the field — selects its normalization and set semantics. */
  fieldName?: string;
  /** False when the two sides share no common ancestor at all. */
  hasBase?: boolean;
  policy?: ConflictPolicy;
  /** Each side's entity updated_at, epoch ms. */
  localUpdatedAt?: number | null;
  remoteUpdatedAt?: number | null;
}

export type FieldMergeResult =
  | { type: 'unchanged' }
  | { type: 'fast-forward'; value: unknown }
  | { type: 'keep-local' }
  /** Both sides changed; the result combines them (set fields). */
  | { type: 'merged'; value: unknown }
  /** Both sides changed; the policy picked one without asking. */
  | { type: 'auto-resolved'; winner: 'local' | 'remote'; value: unknown; reason: 'newest' | 'empty-side' }
  | { type: 'conflict'; base: unknown; local: unknown; remote: unknown };

/** Merges one field's three versions. Applies uniformly to scalars and
 *  whole-array fields alike — the caller decides what "a field" means
 *  (a column, or one of the three whole-array pseudo-fields on a recipe). */
export function mergeField(base: unknown, local: unknown, remote: unknown, ctx: FieldMergeContext = {}): FieldMergeResult {
  const fieldName = ctx.fieldName ?? '';
  const hasBase = ctx.hasBase ?? true;
  const same = (a: unknown, b: unknown) => fieldValuesEqual(fieldName, a, b);

  if (same(local, remote)) return { type: 'unchanged' };

  if (hasBase) {
    const localChanged = !same(local, base);
    const remoteChanged = !same(remote, base);
    if (!localChanged && !remoteChanged) return { type: 'unchanged' };
    if (localChanged && !remoteChanged) return { type: 'keep-local' };
    if (!localChanged && remoteChanged) return { type: 'fast-forward', value: remote };
  } else {
    // No ancestor to tell an edit from an omission: a side that has
    // nothing simply hasn't got this yet, so the other side's value is
    // the merge — never a question worth asking.
    if (isEmptyValue(remote)) return { type: 'keep-local' };
    if (isEmptyValue(local)) return { type: 'auto-resolved', winner: 'remote', value: remote, reason: 'empty-side' };
  }

  if (fieldName in KEYED_LIST_FIELDS) {
    let result = mergeKeyedList(fieldName, base, local, remote, hasBase);
    if (result.conflicts.length > 0) {
      // Same language edited differently on both sides: the policy picks,
      // for those entries only — every other entry is already merged.
      const winner = newerSide(ctx);
      if (!winner) return { type: 'conflict', base, local, remote };
      result = mergeKeyedList(fieldName, base, local, remote, hasBase, winner);
    }
    if (same(result.value, local)) return { type: 'keep-local' };
    if (same(result.value, remote)) return { type: 'fast-forward', value: remote };
    return { type: 'merged', value: result.value };
  }

  if (SET_FIELDS.has(fieldName)) {
    const merged = mergeSetField(base, local, remote, hasBase);
    if (same(merged, local)) return { type: 'keep-local' };
    if (same(merged, remote)) return { type: 'fast-forward', value: remote };
    return { type: 'merged', value: merged };
  }

  const winner = newerSide(ctx);
  if (winner) {
    return winner === 'local'
      ? { type: 'auto-resolved', winner: 'local', value: local, reason: 'newest' }
      : { type: 'auto-resolved', winner: 'remote', value: remote, reason: 'newest' };
  }

  return { type: 'conflict', base, local, remote };
}

/** Under the 'newest' policy, the side edited last — null when the policy
 *  is 'ask' or the timestamps can't tell. */
function newerSide(ctx: FieldMergeContext): 'local' | 'remote' | null {
  if ((ctx.policy ?? 'ask') !== 'newest') return null;
  const l = ctx.localUpdatedAt ?? null;
  const r = ctx.remoteUpdatedAt ?? null;
  if (l === null || r === null || l === r) return null;
  return l > r ? 'local' : 'remote';
}

export interface EntityConflict {
  fieldName: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
}

export interface AutoResolvedField {
  fieldName: string;
  winner: 'local' | 'remote' | 'both';
  reason: 'newest' | 'empty-side' | 'set-merge';
}

export interface EntityMergeResult {
  /** Fields whose local value must change — fast-forwards, auto-resolved
   *  remote wins and set merges. The caller writes these onto the entity's
   *  own row. Fields left as local's value are deliberately absent. */
  applied: Record<string, unknown>;
  /** Fields where both sides changed and nothing could decide for the user. */
  conflicts: EntityConflict[];
  /** Fields where both sides changed and a rule picked the result — kept
   *  for the sync log, so a silent decision is still a visible one. */
  autoResolved?: AutoResolvedField[];
}

export interface EntityMergeOptions {
  hasBase?: boolean;
  policy?: ConflictPolicy;
}

/** Merges every named field of an entity independently. `fieldNames` is
 *  the full set to consider — scalar columns and, for recipes, the three
 *  whole-array pseudo-fields alongside them; any other keys present on the
 *  objects are ignored, except `updated_at`, read for the 'newest' policy. */
export function mergeEntity(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fieldNames: string[],
  options: EntityMergeOptions = {}
): EntityMergeResult {
  const applied: Record<string, unknown> = {};
  const conflicts: EntityConflict[] = [];
  const autoResolved: AutoResolvedField[] = [];
  const ctxBase: FieldMergeContext = {
    hasBase: options.hasBase ?? true,
    policy: options.policy ?? 'ask',
    localUpdatedAt: parseTimestamp(local.updated_at),
    remoteUpdatedAt: parseTimestamp(remote.updated_at),
  };

  for (const fieldName of fieldNames) {
    const result = mergeField(base[fieldName], local[fieldName], remote[fieldName], { ...ctxBase, fieldName });
    switch (result.type) {
      case 'fast-forward':
        applied[fieldName] = result.value;
        break;
      case 'merged':
        applied[fieldName] = result.value;
        autoResolved.push({ fieldName, winner: 'both', reason: 'set-merge' });
        break;
      case 'auto-resolved':
        if (result.winner === 'remote') applied[fieldName] = result.value;
        autoResolved.push({ fieldName, winner: result.winner, reason: result.reason });
        break;
      case 'conflict':
        conflicts.push({ fieldName, baseValue: result.base, localValue: result.local, remoteValue: result.remote });
        break;
    }
  }

  return { applied, conflicts, autoResolved };
}
