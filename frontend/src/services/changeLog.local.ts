// ════════════════════════════════════════════════════════════════════════
// SmartChef — sync v2 change log, phase 1
// (docs/plans/2026-11-01-sync-v2-change-log.md §2–§3)
//
// Two halves, no transport yet (phase 2 moves segments between devices):
//
//   recordEntityChange()  every save of an entity is diffed, path by path
//                         (lib/changeLog/fieldPaths.ts), against what the
//                         log last recorded for it; each changed path gets
//                         an HLC stamp, a change_log row and its new
//                         field_state.
//   applySegment()        another device's changes: per path the newest
//                         stamp wins (lib/changeLog/resolve.ts), the winners
//                         are written into the real tables through the
//                         same createEntity()/applyEntityMergeResult() the
//                         git merge uses, and concurrent edits under the
//                         "ask" policy land in sync_conflicts as today.
//
// Recording is derived from the saved entity rather than threaded through
// every service's SQL: the hook is writeEntityFile(), which every service
// already calls with the whole entity after each save. The plugin cannot
// hold a transaction across calls (see withTransaction() in db/local.ts),
// so "same transaction" is replaced by idempotence: the diff is against the
// log's own record, so any save it missed is caught, whole, by the next
// write of that entity.
//
// Off by default (setChangeLogEnabled): until the migration phase, git sync
// is still what moves data, and recording only costs bridge calls.
//
// Scopes: every function takes the log it works on — '' (the default) for
// this library's own store, or a shared cookbook's id. Each scope is a
// separate log, with its own sequence numbers, cursors and winners, synced
// with its own store (services/sharedCookbooks.local.ts).
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { query, queryOne } from '../db/local';
import { HlcClock, parseHlc } from '../lib/changeLog/hlc';
import { assembleFields, diffEntity, pathInfo } from '../lib/changeLog/fieldPaths';
import { decide, type IncomingChange, type PathState } from '../lib/changeLog/resolve';
import type { ConflictPolicy } from '../lib/structuredMerge';
import { applyEntityMergeResult, createEntity, entityExists, getMergeableFieldNames, listPendingConflictsForEntity, resolveAlias } from './conflicts.local';

const ENABLED_KEY = 'smartchef.syncV2.changeLog';

/** Applied parents first, as the git merge does (mergeBridge.ts ENTITY_DIRS). */
const ENTITY_ORDER = ['setting', 'category', 'unit', 'tag', 'tool', 'technique', 'ingredient', 'profile', 'recipe'];

let enabled: boolean | null = null;

export async function isChangeLogEnabled(): Promise<boolean> {
  if (enabled === null) enabled = (await Preferences.get({ key: ENABLED_KEY })).value === 'on';
  return enabled;
}

export async function setChangeLogEnabled(on: boolean): Promise<void> {
  await Preferences.set({ key: ENABLED_KEY, value: on ? 'on' : 'off' });
  enabled = on;
}

// ── The clock ───────────────────────────────────────────────────────────

let clock: HlcClock | null = null;

/** This device's clock, resumed from the newest stamp it has recorded or
 *  applied — a restart must never issue a stamp older than one it gave out. */
async function clockFor(device: string): Promise<HlcClock> {
  if (clock && clock.device === device) return clock;
  const row = await queryOne<{ hlc: string | null }>(`SELECT MAX(hlc) AS hlc FROM field_state`);
  clock = new HlcClock(device, row?.hlc ?? null);
  return clock;
}

/** Drops in-memory state — for tests that switch devices. */
export function resetChangeLogState(): void {
  clock = null;
  enabled = null;
}

// ── Reading field_state ────────────────────────────────────────────────

interface FieldStateRow { path: string; value: string | null; hlc: string; device: string; seq: number }

const decode = (text: string | null): unknown => (text === null ? null : JSON.parse(text));
const encode = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

async function loadState(entityType: string, entityId: string, scope: string): Promise<Map<string, PathState>> {
  const rows = await query<FieldStateRow>(
    `SELECT path, value, hlc, device, seq FROM field_state WHERE scope = $1 AND entity_type = $2 AND entity_id = $3`,
    [scope, entityType, entityId],
  );
  return new Map(rows.map((r) => [r.path, { value: decode(r.value), hlc: r.hlc, device: r.device, seq: Number(r.seq) }]));
}

async function writeState(entityType: string, entityId: string, path: string, s: PathState, scope: string): Promise<void> {
  await query(
    `INSERT INTO field_state (scope, entity_type, entity_id, path, value, hlc, device, seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(scope, entity_type, entity_id, path) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, device = excluded.device, seq = excluded.seq`,
    [scope, entityType, entityId, path, encode(s.value), s.hlc, s.device, s.seq],
  );
}

// ── Recording this device's changes ────────────────────────────────────

/** Records what a save changed. Returns how many paths changed (0 when the
 *  save was a no-op re-write, which most re-serializations are). */
export async function recordEntityChange(entityType: string, entityId: string, entity: Record<string, unknown>, device: string, scope = ''): Promise<number> {
  const state = await loadState(entityType, entityId, scope);
  const recorded = new Map([...state].map(([path, s]) => [path, s.value]));
  // A field waiting on the user still shows this device's value while the
  // log already holds the other device's: recording it now would publish
  // "mine" as a fresh edit and settle the conflict without asking.
  const pending = new Set((await listPendingConflictsForEntity(entityType, entityId)).map((x) => x.fieldName));
  const changes = diffEntity(recorded, entity).filter((ch) => !pending.has(pathInfo(ch.path).field));
  if (changes.length === 0) return 0;
  const c = await clockFor(device);
  const last = await queryOne<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM change_log WHERE scope = $1`, [scope]);
  let seq = Number(last?.seq ?? 0);
  for (const change of changes) {
    seq += 1;
    const hlc = c.tick();
    await query(
      `INSERT INTO change_log (scope, seq, hlc, entity_type, entity_id, path, value) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [scope, seq, hlc, entityType, entityId, change.path, encode(change.value)],
    );
    await writeState(entityType, entityId, change.path, { value: change.value, hlc, device, seq }, scope);
  }
  return changes.length;
}

// ── Segments: what one device hands another ────────────────────────────

export interface SegmentChange {
  seq: number;
  hlc: string;
  entityType: string;
  entityId: string;
  path: string;
  value: unknown;
}

export interface Segment {
  device: string;
  /** How far the author had read every other device when it wrote this —
   *  what tells a concurrent edit from one made with the other in view. */
  seen: Record<string, number>;
  changes: SegmentChange[];
}

/** How far this device has applied each other device's log. */
export async function readCursors(scope = ''): Promise<Record<string, number>> {
  const rows = await query<{ device: string; seq: number }>(`SELECT device, seq FROM sync_cursor WHERE scope = $1`, [scope]);
  return Object.fromEntries(rows.map((r) => [r.device, Number(r.seq)]));
}

/** This device's changes after `afterSeq`, ready to hand to another device. */
export async function buildSegment(device: string, afterSeq = 0, scope = ''): Promise<Segment> {
  const rows = await query<{ seq: number; hlc: string; entity_type: string; entity_id: string; path: string; value: string | null }>(
    `SELECT seq, hlc, entity_type, entity_id, path, value FROM change_log WHERE scope = $1 AND seq > $2 ORDER BY seq`,
    [scope, afterSeq],
  );
  return {
    device,
    seen: await readCursors(scope),
    changes: rows.map((r) => ({
      seq: Number(r.seq), hlc: r.hlc, entityType: r.entity_type, entityId: r.entity_id, path: r.path, value: decode(r.value),
    })),
  };
}

// ── Applying another device's changes ──────────────────────────────────

/** What applying one entity's incoming changes writes into the real tables. */
export interface EntityWrite {
  entityType: string;
  entityId: string;
  /** The winning values to write onto an existing entity (fields waiting
   *  on the user left out). */
  applied: Record<string, unknown>;
  /** Everything known about the entity — what a new one is created from. */
  everything: Record<string, unknown>;
  /** Fields the user has to settle (the "ask" policy). */
  conflicts: Array<{ fieldName: string; baseValue: null; localValue: unknown; remoteValue: unknown }>;
  remoteUpdatedAt: string | null;
}

/** Writes an EntityWrite. A shared cookbook supplies its own, which
 *  translates the cookbook's ids into this library's first. */
export type EntityWriter = (write: EntityWrite) => Promise<void>;

export interface ApplyOptions {
  device: string;
  policy: ConflictPolicy;
  /** The log being applied to: '' (this library) or a cookbook id. */
  scope?: string;
  writer?: EntityWriter;
}

/** The library's own write: the same createEntity()/applyEntityMergeResult()
 *  the git merge uses. */
export async function writeEntity(w: EntityWrite): Promise<void> {
  const { entityType, entityId, remoteUpdatedAt } = w;
  if (Object.keys(w.applied).length > 0 || w.conflicts.length === 0) {
    if (await entityExists(entityType, entityId)) {
      if (Object.keys(w.applied).length > 0) await applyEntityMergeResult(entityType, entityId, { applied: w.applied, conflicts: [] }, { remoteUpdatedAt });
    } else if (entityType === 'recipe' && typeof w.everything.cookbook_id === 'string' && w.everything.title === undefined) {
      // A recipe in a shared cookbook: the library's own log carries only
      // its personal fields, and the cookbook creates it
      // (sharedCookbooks.local.ts), taking those from field_state.
    } else if (Object.keys(w.everything).length > 0) {
      await createEntity(entityType, entityId, remoteUpdatedAt ? { ...w.everything, created_at: remoteUpdatedAt, updated_at: remoteUpdatedAt } : w.everything);
    }
  }
  if (w.conflicts.length > 0) await applyEntityMergeResult(entityType, entityId, { applied: {}, conflicts: w.conflicts }, { remoteUpdatedAt });
}

export interface ApplyReport {
  applied: number;
  ignored: number;
  conflicts: number;
  failed: Array<{ entityType: string; entityId: string; error: string }>;
}

/** Applies another device's segment. Safe to repeat: changes at or below
 *  the cursor for that device are skipped, and an already-applied change
 *  carries the same stamp as what is stored, which decide() ignores. */
export async function applySegment(segment: Segment, opts: ApplyOptions): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, ignored: 0, conflicts: 0, failed: [] };
  if (segment.device === opts.device) return report;
  const scope = opts.scope ?? '';
  const cursors = await readCursors(scope);
  const from = cursors[segment.device] ?? 0;
  const fresh = segment.changes.filter((c) => c.seq > from).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return report;

  await applyRows(fresh.map((ch) => ({ ...ch, device: segment.device })), segment.seen, opts, report);

  // The cursor moves past the whole segment, failures included: a failed
  // write is a schema or constraint problem a retry of the same change will
  // not fix, and holding the cursor would re-apply every other change too.
  // field_state already holds the winning values, so the next local save
  // or a repair pass can still write them.
  const top = fresh[fresh.length - 1].seq;
  await moveCursor(scope, segment.device, top);
  return report;
}

async function moveCursor(scope: string, device: string, seq: number): Promise<void> {
  await query(
    `INSERT INTO sync_cursor (scope, device, seq) VALUES ($1, $2, $3) ON CONFLICT(scope, device) DO UPDATE SET seq = MAX(sync_cursor.seq, excluded.seq)`,
    [scope, device, seq],
  );
}

/** A change together with the device that wrote it — a segment's changes
 *  all have one author, a snapshot's rows have many. */
type AuthoredChange = SegmentChange & { device: string };

/** Applies changes entity by entity, parents first. `seen` is how far the
 *  writer of these rows had read every device — what decides whether a
 *  change was made with the local value in view. */
async function applyRows(rows: AuthoredChange[], seen: Record<string, number>, opts: ApplyOptions, report: ApplyReport): Promise<void> {
  const c = await clockFor(opts.device);
  const byEntity = new Map<string, AuthoredChange[]>();
  for (const row of rows) {
    if (row.device === opts.device) continue; // our own change, coming back
    const key = `${row.entityType}::${row.entityId}`;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(row);
  }
  const order = (type: string) => { const i = ENTITY_ORDER.indexOf(type); return i < 0 ? ENTITY_ORDER.length : i; };
  const entities = [...byEntity.values()].sort((a, b) => order(a[0].entityType) - order(b[0].entityType));

  for (const changes of entities) {
    const { entityType } = changes[0];
    try {
      // Every write lands on the row this id resolves to here — the same
      // aliasing the git merge applies (resolveAlias in conflicts.local.ts).
      // A cookbook's ids are the cookbook's own; its writer maps them.
      const entityId = opts.writer ? changes[0].entityId : await resolveAlias(entityType, changes[0].entityId);
      const outcome = await applyEntityChanges(entityType, entityId, changes, seen, opts, c);
      report.applied += outcome.applied;
      report.ignored += outcome.ignored;
      report.conflicts += outcome.conflicts;
    } catch (err) {
      report.failed.push({ entityType, entityId: changes[0].entityId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function applyEntityChanges(
  entityType: string, entityId: string, changes: AuthoredChange[], seen: Record<string, number>, opts: ApplyOptions, c: HlcClock,
): Promise<{ applied: number; ignored: number; conflicts: number }> {
  const { policy } = opts;
  const scope = opts.scope ?? '';
  const state = await loadState(entityType, entityId, scope);
  const before = new Map([...state].map(([p, s]) => [p, s.value]));
  const touched = new Set<string>();
  /** Paths whose incoming value disagrees with a local one it never saw. */
  const disputed = new Map<string, unknown>();
  let applied = 0;
  let ignored = 0;

  for (const change of changes) {
    c.receive(change.hlc);
    const incoming: IncomingChange = { device: change.device, seq: change.seq, hlc: change.hlc, entityType, entityId, path: change.path, value: change.value };
    const local = state.get(change.path);
    const decision = decide(local, incoming, seen);
    const field = pathInfo(change.path).field;
    if (decision.action !== 'ignore' && decision.concurrent && policy === 'ask') disputed.set(change.path, change.value);
    if (decision.action !== 'apply') { ignored += 1; continue; }
    const next: PathState = { value: change.value, hlc: change.hlc, device: change.device, seq: change.seq };
    state.set(change.path, next);
    await writeState(entityType, entityId, change.path, next, scope);
    touched.add(field);
    applied += 1;
  }

  const conflictedFields = new Set([...disputed.keys()].map((p) => pathInfo(p).field));
  const allowed = new Set(getMergeableFieldNames(entityType) ?? []);
  // The real edit time, not the time of this sync: the "newest" policy and
  // the Conflicts card both read updated_at.
  const newestMs = Math.max(...changes.map((ch) => parseHlc(ch.hlc)?.ms ?? 0));
  const remoteUpdatedAt = newestMs > 0 ? new Date(newestMs).toISOString() : null;
  const fields = new Set([...touched].filter((f) => allowed.has(f)));
  const after = new Map([...state].map(([p, s]) => [p, s.value]));
  if (fields.size === 0 && disputed.size === 0) return { applied, ignored, conflicts: 0 };
  // Under "ask" the local value stays on screen until the user picks: the
  // field is recorded as a conflict and not overwritten, the same as a
  // three-way merge conflict today. field_state already holds the winner,
  // so the pick (a new local change) is compared against it. A new entity
  // is made from everything known about it, not only this segment's paths.
  const write: EntityWrite = {
    entityType, entityId, remoteUpdatedAt, conflicts: [],
    applied: fields.size > 0 ? assembleFields(after, new Set([...fields].filter((f) => !conflictedFields.has(f)))) : {},
    everything: fields.size > 0 ? Object.fromEntries(Object.entries(assembleFields(after)).filter(([k]) => allowed.has(k))) : {},
  };
  if (disputed.size > 0) {
    // Shown as whole fields: this device's value, and the field as the
    // other device's changes would make it.
    const theirs = new Map(before);
    for (const [path, value] of disputed) theirs.set(path, value);
    write.conflicts = [...conflictedFields].map((fieldName) => {
      const only = new Set([fieldName]);
      return { fieldName, baseValue: null, localValue: assembleFields(before, only)[fieldName] ?? null, remoteValue: assembleFields(theirs, only)[fieldName] ?? null };
    });
  }
  await (opts.writer ?? writeEntity)(write);
  return { applied, ignored, conflicts: conflictedFields.size };
}

// ── Snapshots ───────────────────────────────────────────────────────────
// The whole library as this device holds it — every path's winning value
// with the change that wrote it — and how far it had read every device.
// A device catching up from nothing, or from behind segments that have
// been compacted away, starts from one of these instead of the full log.

export interface Snapshot {
  device: string;
  createdAt: string;
  /** Every device's seq this snapshot includes (its own included). */
  covers: Record<string, number>;
  rows: Array<[entityType: string, entityId: string, path: string, value: unknown, hlc: string, device: string, seq: number]>;
}

export async function buildSnapshot(device: string, scope = ''): Promise<Snapshot> {
  const covers = await readCursors(scope);
  const own = await queryOne<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM change_log WHERE scope = $1`, [scope]);
  covers[device] = Number(own?.seq ?? 0);
  const rows = await query<{ entity_type: string; entity_id: string; path: string; value: string | null; hlc: string; device: string; seq: number }>(
    `SELECT entity_type, entity_id, path, value, hlc, device, seq FROM field_state WHERE scope = $1 ORDER BY entity_type, entity_id, path`,
    [scope],
  );
  return {
    device, createdAt: new Date().toISOString(), covers,
    rows: rows.map((r) => [r.entity_type, r.entity_id, r.path, decode(r.value), r.hlc, r.device, Number(r.seq)]),
  };
}

/** Applies a snapshot like a very large segment, then moves every cursor up
 *  to what it covers — the changes before that are in it. */
export async function applySnapshot(snapshot: Snapshot, opts: ApplyOptions): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, ignored: 0, conflicts: 0, failed: [] };
  const rows: AuthoredChange[] = snapshot.rows.map(([entityType, entityId, path, value, hlc, device, seq]) => ({ entityType, entityId, path, value, hlc, device, seq }));
  await applyRows(rows, snapshot.covers, opts, report);
  for (const [device, seq] of Object.entries(snapshot.covers)) {
    if (device === opts.device) continue;
    await moveCursor(opts.scope ?? '', device, seq);
  }
  return report;
}

/** Paths the log knows for an entity — for tests and the future history view. */
export async function listFieldState(entityType: string, entityId: string, scope = ''): Promise<Map<string, PathState>> {
  return loadState(entityType, entityId, scope);
}

/** Forgets a scope entirely — leaving a cookbook. */
export async function dropScope(scope: string): Promise<void> {
  if (!scope) throw new Error('dropScope: the library\'s own log cannot be dropped');
  for (const table of ['change_log', 'field_state', 'sync_cursor']) await query(`DELETE FROM ${table} WHERE scope = $1`, [scope]);
}
