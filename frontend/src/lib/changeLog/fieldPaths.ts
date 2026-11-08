// ════════════════════════════════════════════════════════════════════════
// SmartChef — an entity as a set of independently versioned "paths"
// (sync v2, docs/plans/2026-11-01-sync-v2-change-log.md §3)
//
// The change log versions every path on its own, and the newest stamp per
// path wins. A path is usually just a field ("title", "steps"), but the
// merge rules of lib/structuredMerge.ts are kept by choosing paths well:
//
//   - a SET field (tags, regions, synonyms…) is one path per MEMBER,
//     "tags[]<member>", whose value is true (in the set) or false (removed).
//     Two devices adding different tags both win; a removal is just a newer
//     false. That is the add/remove set the old three-way set merge built
//     out of a merge base, without needing one.
//   - a KEYED list (translations) is one path per key, "translations{}it",
//     whose value is that language's entry, or null once removed.
//   - everything else, including a recipe's whole steps / ingredients
//     arrays (ADR 0002), is one path holding the raw value.
//
// Values are stored raw (as the entity carries them) and compared
// normalized (lib/mergeNormalize.ts), so a re-save that only reorders rows
// or rewrites "" as null is not a change. Pure: no database here.
// ════════════════════════════════════════════════════════════════════════

import {
  JSON_TEXT_FIELDS, KEYED_LIST_FIELDS, SET_FIELDS, fieldValuesEqual, isEmptyValue, keyedEntries, setMemberKey, setMembers,
} from '../mergeNormalize';

/** Row bookkeeping that is not content: ids are the path's owner, the two
 *  timestamps are replaced by the change's own stamp. */
const NOT_CONTENT = new Set(['id', 'created_at', 'updated_at']);

const SET_SEP = '[]';
const KEY_SEP = '{}';

export type PathKind = 'field' | 'member' | 'keyed';

export interface PathInfo {
  kind: PathKind;
  /** The entity field the path belongs to. */
  field: string;
}

export function pathInfo(path: string): PathInfo {
  const set = path.indexOf(SET_SEP);
  if (set > 0 && SET_FIELDS.has(path.slice(0, set))) return { kind: 'member', field: path.slice(0, set) };
  const keyed = path.indexOf(KEY_SEP);
  if (keyed > 0 && path.slice(0, keyed) in KEYED_LIST_FIELDS) return { kind: 'keyed', field: path.slice(0, keyed) };
  return { kind: 'field', field: path };
}

/** Whether two values of one path are the same content. A keyed entry is
 *  compared as a one-entry list, the shape its field's normalizer reads. */
export function pathValuesEqual(path: string, a: unknown, b: unknown): boolean {
  const info = pathInfo(path);
  if (info.kind === 'member') return a === b;
  if (info.kind === 'keyed') return fieldValuesEqual(info.field, a == null ? [] : [a], b == null ? [] : [b]);
  return fieldValuesEqual(info.field, a, b);
}

/** One entity's content as path → raw value. Set members map to their raw
 *  member; absent members are not listed (absence is what removal looks
 *  like when diffing against what was recorded). */
export function flattenEntity(entity: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [field, value] of Object.entries(entity)) {
    if (NOT_CONTENT.has(field) || value === undefined) continue;
    if (SET_FIELDS.has(field)) {
      for (const member of setMembers(value)) out.set(`${field}${SET_SEP}${setMemberKey(member)}`, member);
    } else if (field in KEYED_LIST_FIELDS) {
      for (const [key, entry] of keyedEntries(value, KEYED_LIST_FIELDS[field])) out.set(`${field}${KEY_SEP}${key}`, entry);
    } else {
      out.set(field, value);
    }
  }
  return out;
}

export interface PathChange {
  path: string;
  /** For a set member: true when added, false when removed. Otherwise the
   *  raw value, or null when cleared. */
  value: unknown;
}

/** What a save changed, compared with what the change log last recorded for
 *  the entity (`recorded`: path → value, as stored for members: true/false).
 *  A field missing from `next` is left alone, never read as "cleared": the
 *  entity files of some types carry only part of the row, and the merge
 *  has always treated a missing field the same way. */
export function diffEntity(recorded: Map<string, unknown>, next: Record<string, unknown>): PathChange[] {
  const flat = flattenEntity(next);
  const changes: PathChange[] = [];

  for (const [path, value] of flat) {
    const info = pathInfo(path);
    if (info.kind === 'member') {
      if (recorded.get(path) !== true) changes.push({ path, value: true });
      continue;
    }
    const empty = info.kind === 'field' && isEmptyValue(value);
    if (!recorded.has(path)) {
      if (!empty) changes.push({ path, value });
    } else if (!pathValuesEqual(path, recorded.get(path), value)) {
      changes.push({ path, value: empty ? null : value });
    }
  }

  // Members and keyed entries that were there and are gone. Only for fields
  // the new save carries at all — see above.
  for (const [path, value] of recorded) {
    if (flat.has(path)) continue;
    const info = pathInfo(path);
    if (info.kind === 'field' || !(info.field in next)) continue;
    if (info.kind === 'member' && value === true) changes.push({ path, value: false });
    if (info.kind === 'keyed' && value !== null) changes.push({ path, value: null });
  }
  return changes;
}

/** Rebuilds field values from paths, for the fields named in `fields`
 *  (every field when omitted). A set comes back in the representation its
 *  column uses: JSON text for the columns stored as text, an array for the
 *  pseudo-fields (toolIds, tag_ids…) the services write row by row. */
export function assembleFields(paths: Map<string, unknown>, fields?: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sets = new Map<string, unknown[]>();
  const lists = new Map<string, unknown[]>();
  for (const [path, value] of paths) {
    const info = pathInfo(path);
    if (fields && !fields.has(info.field)) continue;
    if (info.kind === 'member') {
      if (!sets.has(info.field)) sets.set(info.field, []);
      if (value === true) sets.get(info.field)!.push(JSON.parse(path.slice(info.field.length + SET_SEP.length)));
    } else if (info.kind === 'keyed') {
      if (!lists.has(info.field)) lists.set(info.field, []);
      if (value !== null && value !== undefined) lists.get(info.field)!.push(value);
    } else {
      out[path] = value;
    }
  }
  for (const [field, members] of sets) out[field] = JSON_TEXT_FIELDS.has(field) ? JSON.stringify(members) : members;
  for (const [field, entries] of lists) out[field] = entries;
  return out;
}
