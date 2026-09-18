// ════════════════════════════════════════════════════════════════════════
// SmartChef — what "the same value" means to Structured Merge (ADR 0006)
//
// structuredMerge.ts used to compare raw serialized values with a strict
// deepEqual, and almost every difference it found was noise rather than an
// edit anyone made:
//   - child rows (recipe_steps/recipe_ingredients) carry their own row id,
//     recipe_id and created_at. updateRecipe() regenerates the ids on every
//     save, and a synced-in row gets this device's insert time, so the same
//     steps never compared equal across two devices;
//   - rows came out of SELECT * with no ORDER BY, so identical arrays could
//     differ only in order;
//   - JSON columns (tags, regions, ...) arrive as JSON *strings*, so
//     '["a","b"]' and '["b","a"]' — or the same list with a space — differed;
//   - null, "" and a key that an older schema never wrote were three
//     different values.
//   - units and ingredient categories are per-device rows with random ids
//     (see db/local.ts), so the same "g" or "Frutta" has a different id on
//     every device. The serializers now write the symbol/name alongside,
//     and that is what gets compared.
//
// normalizeForCompare() folds all of that away. It is used for EQUALITY
// ONLY — the value that is written to the database is always one of the
// raw sides, never the normalized form.
// ════════════════════════════════════════════════════════════════════════

/** Fields whose value is a set: order and duplicates carry no meaning, so
 *  two devices adding different members can be merged member by member
 *  instead of one list winning outright (see mergeSetField). */
export const SET_FIELDS = new Set([
  'tags', 'regions', 'image_urls', 'seasonal_months', 'toolIds', 'exclude_tag_ids', 'synonyms', 'tag_ids',
]);

/** Columns stored as JSON text in SQLite — parsed before comparing. */
const JSON_TEXT_FIELDS = new Set([
  'tags', 'regions', 'region_coords', 'sources', 'image_urls', 'seasonal_months',
  'exclude_tag_ids', 'synonyms', 'tool_ids', 'technique_ids', 'step_ingredients',
]);

// Row-level bookkeeping that differs per device for the same content.
const STEP_IGNORED_KEYS = new Set(['id', 'recipe_id', 'created_at', 'updated_at', 'step_number']);
const INGREDIENT_IGNORED_KEYS = new Set(['id', 'recipe_id', 'created_at', 'updated_at', 'sort_order', 'unit_id']);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** True for every spelling of "nothing here". */
export function isEmptyValue(value: unknown): boolean {
  const v = parseMaybeJson(value);
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function normalizeScalar(value: unknown): unknown {
  if (isEmptyValue(value)) return null;
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').trim();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeDeep(value: unknown): unknown {
  const v = parseMaybeJson(value);
  if (isEmptyValue(v)) return null;
  if (Array.isArray(v)) return v.map(normalizeDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as object).sort()) {
      const inner = normalizeDeep((v as Record<string, unknown>)[key]);
      if (inner !== null) out[key] = inner;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return normalizeScalar(v);
}

function normalizeSet(value: unknown): unknown {
  const v = parseMaybeJson(value);
  if (isEmptyValue(v)) return null;
  const list = Array.isArray(v) ? v : [v];
  const members = [...new Set(list.map((m) => JSON.stringify(normalizeDeep(m))))].sort();
  return members.length === 0 ? null : members;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRows(value: unknown, orderKey: string, ignored: Set<string>): unknown {
  const v = parseMaybeJson(value);
  if (isEmptyValue(v) || !Array.isArray(v)) return isEmptyValue(v) ? null : normalizeDeep(v);
  const rows = (v as Record<string, unknown>[])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => numberOr(a.row?.[orderKey], a.index) - numberOr(b.row?.[orderKey], b.index) || a.index - b.index)
    .map(({ row }) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(row ?? {}).sort()) {
        if (ignored.has(key)) continue;
        const inner = SET_FIELDS.has(key) || key === 'tool_ids' || key === 'technique_ids'
          ? normalizeSet(row[key])
          : normalizeDeep(row[key]);
        if (inner !== null) out[key] = inner;
      }
      return out;
    });
  return rows;
}

/** Recipe ingredient rows: the unit is compared by symbol when the row
 *  carries one (unit_id is a per-device random id), falling back to the
 *  id for files written before the symbol was serialized. */
function normalizeIngredientRows(value: unknown): unknown {
  const v = parseMaybeJson(value);
  if (!Array.isArray(v)) return normalizeRows(v, 'sort_order', INGREDIENT_IGNORED_KEYS);
  const withUnitKey = (v as Record<string, unknown>[]).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const unitKey = row.unit_symbol ?? row.unit_id ?? null;
    const { unit_symbol: _unitSymbol, ...rest } = row;
    return { ...rest, unit: unitKey };
  });
  return normalizeRows(withUnitKey, 'sort_order', INGREDIENT_IGNORED_KEYS);
}

/** The comparable form of one field's value. Stable across devices for
 *  the same content, and the same shape for every way of writing "empty". */
export function normalizeForCompare(fieldName: string, value: unknown): unknown {
  if (fieldName in KEYED_LIST_FIELDS) {
    const entries = keyedEntries(value, KEYED_LIST_FIELDS[fieldName]);
    if (entries.size === 0) return null;
    return [...entries.keys()].sort().map((k) => normalizeDeep(entries.get(k)));
  }
  if (fieldName === 'steps') return normalizeRows(value, 'step_number', STEP_IGNORED_KEYS);
  if (fieldName === 'ingredients') return normalizeIngredientRows(value);
  if (SET_FIELDS.has(fieldName)) return normalizeSet(value);
  if (JSON_TEXT_FIELDS.has(fieldName)) return normalizeDeep(value);
  if (value !== null && typeof value === 'object') return normalizeDeep(value);
  return normalizeScalar(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Whether two raw values of one field are the same content. */
export function fieldValuesEqual(fieldName: string, a: unknown, b: unknown): boolean {
  return deepEqual(normalizeForCompare(fieldName, a), normalizeForCompare(fieldName, b));
}

/** A set field's members, parsed, deduplicated, in first-seen order. */
export function setMembers(value: unknown): unknown[] {
  const v = parseMaybeJson(value);
  if (isEmptyValue(v)) return [];
  const list = Array.isArray(v) ? v : [v];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const member of list) {
    const key = JSON.stringify(normalizeDeep(member));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
}

/** Three-way merge of a set field, member by member — what git would do if
 *  each member were its own line in a file where order doesn't matter:
 *  keep what either side added, drop what either side removed. Without a
 *  base, nothing can have been removed, so it is the union. The result is
 *  written back in the representation the local side used (a JSON string
 *  column stays a JSON string). */
export function mergeSetField(base: unknown, local: unknown, remote: unknown, hasBase: boolean): unknown {
  const key = (m: unknown) => JSON.stringify(normalizeDeep(m));
  const baseKeys = new Set(hasBase ? setMembers(base).map(key) : []);
  const localMembers = setMembers(local);
  const remoteMembers = setMembers(remote);
  const localKeys = new Set(localMembers.map(key));
  const remoteKeys = new Set(remoteMembers.map(key));

  const result: unknown[] = [];
  const seen = new Set<string>();
  for (const member of [...localMembers, ...remoteMembers]) {
    const k = key(member);
    if (seen.has(k)) continue;
    const removedLocally = hasBase && baseKeys.has(k) && !localKeys.has(k);
    const removedRemotely = hasBase && baseKeys.has(k) && !remoteKeys.has(k);
    if (removedLocally || removedRemotely) continue;
    seen.add(k);
    result.push(member);
  }

  const representative = typeof local === 'string' || (local == null && typeof remote === 'string');
  return representative ? JSON.stringify(result) : result;
}

/** Entity `updated_at` as epoch ms, or null when missing/unparseable.
 *  SQLite's CURRENT_TIMESTAMP ("2026-09-18 10:00:00") is UTC with no zone
 *  marker, which Date.parse would otherwise read as local time. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let s = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// ── Keyed lists: translations ───────────────────────────────────────────
// A list of entries each owned by a key (`lang`): what changed is decided
// per entry, so an Italian translation added on one device and a French one
// edited on the other both survive — only the same language edited two
// different ways on both sides is a real disagreement.

export const KEYED_LIST_FIELDS: Record<string, string> = {
  translations: 'lang',
  group_translations: 'lang',
};

function keyedEntries(value: unknown, keyName: string): Map<string, Record<string, unknown>> {
  const v = parseMaybeJson(value);
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(v)) return out;
  for (const entry of v as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry[keyName];
    if (typeof key === 'string' && key) out.set(key.toLowerCase(), entry);
  }
  return out;
}

function sameEntry(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  return deepEqual(normalizeDeep(a ?? null), normalizeDeep(b ?? null));
}

export interface KeyedMergeResult {
  value: unknown;
  /** Keys both sides changed to different entries. */
  conflicts: string[];
}

/** Three-way merge of a keyed list, entry by entry. With `pick`, entries
 *  both sides changed take that side instead of being reported. */
export function mergeKeyedList(
  fieldName: string,
  base: unknown,
  local: unknown,
  remote: unknown,
  hasBase: boolean,
  pick?: 'local' | 'remote'
): KeyedMergeResult {
  const keyName = KEYED_LIST_FIELDS[fieldName] ?? 'lang';
  const b = hasBase ? keyedEntries(base, keyName) : new Map<string, Record<string, unknown>>();
  const l = keyedEntries(local, keyName);
  const r = keyedEntries(remote, keyName);
  const keys = [...new Set([...b.keys(), ...l.keys(), ...r.keys()])].sort();
  const merged: Record<string, unknown>[] = [];
  const conflicts: string[] = [];
  for (const key of keys) {
    const be = b.get(key);
    const le = l.get(key);
    const re = r.get(key);
    let chosen: Record<string, unknown> | undefined;
    if (sameEntry(le, re)) chosen = le ?? re;
    else if (hasBase && sameEntry(le, be)) chosen = re;          // only remote changed (or removed) it
    else if (hasBase && sameEntry(re, be)) chosen = le;          // only local changed (or removed) it
    else if (!hasBase && !le) chosen = re;                       // no ancestor: one side just lacks it
    else if (!hasBase && !re) chosen = le;
    else if (pick) chosen = pick === 'local' ? le : re;
    else {
      conflicts.push(key);
      chosen = le;
    }
    if (chosen) merged.push(chosen);
  }
  const asString = typeof local === 'string' || (local == null && typeof remote === 'string');
  return { value: asString ? JSON.stringify(merged) : merged, conflicts };
}
