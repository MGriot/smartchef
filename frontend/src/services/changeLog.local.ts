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

async function loadState(entityType: string, entityId: string): Promise<Map<string, PathState>> {
  const rows = await query<FieldStateRow>(
    `SELECT path, value, hlc, device, seq FROM field_state WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId],
  );
  return new Map(rows.map((r) => [r.path, { value: decode(r.value), hlc: r.hlc, device: r.device, seq: Number(r.seq) }]));
}

async function writeState(entityType: string, entityId: string, path: string, s: PathState): Promise<void> {
  await query(
    `INSERT INTO field_state (entity_type, entity_id, path, value, hlc, device, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(entity_type, entity_id, path) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, device = excluded.device, seq = excluded.seq`,
    [entityType, entityId, path, encode(s.value), s.hlc, s.device, s.seq],
  );
}

// ── Recording this device's changes ────────────────────────────────────

/** Records what a save changed. Returns how many paths changed (0 when the
 *  save was a no-op re-write, which most re-serializations are). */
export async function recordEntityChange(entityType: string, entityId: string, entity: Record<string, unknown>, device: string): Promise<number> {
  const state = await loadState(entityType, entityId);
  const recorded = new Map([...state].map(([path, s]) => [path, s.value]));
  // A field waiting on the user still shows this device's value while the
  // log already holds the other device's: recording it now would publish
  // "mine" as a fresh edit and settle the conflict without asking.
  const pending = new Set((await listPendingConflictsForEntity(entityType, entityId)).map((x) => x.fieldName));
  const changes = diffEntity(recorded, entity).filter((ch) => !pending.has(pathInfo(ch.path).field));
  if (changes.length === 0) return 0;
  const c = await clockFor(device);
  const last = await queryOne<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM change_log`);
  let seq = Number(last?.seq ?? 0);
  for (const change of changes) {
    seq += 1;
    const hlc = c.tick();
    await query(
      `INSERT INTO change_log (seq, hlc, entity_type, entity_id, path, value) VALUES ($1, $2, $3, $4, $5, $6)`,
      [seq, hlc, entityType, entityId, change.path, encode(change.value)],
    );
    await writeState(entityType, entityId, change.path, { value: change.value, hlc, device, seq });
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
export async function readCursors(): Promise<Record<string, number>> {
  const rows = await query<{ device: string; seq: number }>(`SELECT device, seq FROM sync_cursor`);
  return Object.fromEntries(rows.map((r) => [r.device, Number(r.seq)]));
}

/** This device's changes after `afterSeq`, ready to hand to another device. */
export async function buildSegment(device: string, afterSeq = 0): Promise<Segment> {
  const rows = await query<{ seq: number; hlc: string; entity_type: string; entity_id: string; path: string; value: string | null }>(
    `SELECT seq, hlc, entity_type, entity_id, path, value FROM change_log WHERE seq > $1 ORDER BY seq`,
    [afterSeq],
  );
  return {
    device,
    seen: await readCursors(),
    changes: rows.map((r) => ({
      seq: Number(r.seq), hlc: r.hlc, entityType: r.entity_type, entityId: r.entity_id, path: r.path, value: decode(r.value),
    })),
  };
}

// ── Applying another device's changes ──────────────────────────────────

export interface ApplyReport {
  applied: number;
  ignored: number;
  conflicts: number;
  failed: Array<{ entityType: string; entityId: string; error: string }>;
}

/** Applies another device's segment. Safe to repeat: changes at or below
 *  the cursor for that device are skipped, and an already-applied change
 *  carries the same stamp as what is stored, which decide() ignores. */
export async function applySegment(segment: Segment, opts: { device: string; policy: ConflictPolicy }): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, ignored: 0, conflicts: 0, failed: [] };
  if (segment.device === opts.device) return report;
  const cursors = await readCursors();
  const from = cursors[segment.device] ?? 0;
  const fresh = segment.changes.filter((c) => c.seq > from).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return report;

  const c = await clockFor(opts.device);
  const byEntity = new Map<string, SegmentChange[]>();
  for (const change of fresh) {
    const key = `${change.entityType}\u0000${change.entityId}`;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(change);
  }
  const order = (type: string) => { const i = ENTITY_ORDER.indexOf(type); return i < 0 ? ENTITY_ORDER.length : i; };
  const entities = [...byEntity.values()].sort((a, b) => order(a[0].entityType) - order(b[0].entityType));

  for (const changes of entities) {
    const { entityType } = changes[0];
    try {
      // Every write lands on the row this id resolves to here — the same
      // aliasing the git merge applies (resolveAlias in conflicts.local.ts).
      const entityId = await resolveAlias(entityType, changes[0].entityId);
      const outcome = await applyEntityChanges(entityType, entityId, changes, segment, opts.policy, c);
      report.applied += outcome.applied;
      report.ignored += outcome.ignored;
      report.conflicts += outcome.conflicts;
    } catch (err) {
      report.failed.push({ entityType, entityId: changes[0].entityId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The cursor moves past the whole segment, failures included: a failed
  // write is a schema or constraint problem a retry of the same change will
  // not fix, and holding the cursor would re-apply every other change too.
  // field_state already holds the winning values, so the next local save
  // or a repair pass can still write them.
  const top = fresh[fresh.length - 1].seq;
  await query(
    `INSERT INTO sync_cursor (device, seq) VALUES ($1, $2) ON CONFLICT(device) DO UPDATE SET seq = MAX(sync_cursor.seq, excluded.seq)`,
    [segment.device, top],
  );
  return report;
}

async function applyEntityChanges(
  entityType: string, entityId: string, changes: SegmentChange[], segment: Segment, policy: ConflictPolicy, c: HlcClock,
): Promise<{ applied: number; ignored: number; conflicts: number }> {
  const state = await loadState(entityType, entityId);
  const before = new Map([...state].map(([p, s]) => [p, s.value]));
  const touched = new Set<string>();
  /** Paths whose incoming value disagrees with a local one it never saw. */
  const disputed = new Map<string, unknown>();
  let applied = 0;
  let ignored = 0;

  for (const change of changes) {
    c.receive(change.hlc);
    const incoming: IncomingChange = { device: segment.device, seq: change.seq, hlc: change.hlc, entityType, entityId, path: change.path, value: change.value };
    const local = state.get(change.path);
    const decision = decide(local, incoming, segment.seen);
    const field = pathInfo(change.path).field;
    if (decision.action !== 'ignore' && decision.concurrent && policy === 'ask') disputed.set(change.path, change.value);
    if (decision.action !== 'apply') { ignored += 1; continue; }
    const next: PathState = { value: change.value, hlc: change.hlc, device: segment.device, seq: change.seq };
    state.set(change.path, next);
    await writeState(entityType, entityId, change.path, next);
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
  if (fields.size > 0) {
    if (await entityExists(entityType, entityId)) {
      // Under "ask" the local value stays on screen until the user picks:
      // the field is recorded as a conflict and not overwritten here, the
      // same as a three-way merge conflict today. field_state already holds
      // the winner, so the pick (a new local change) is compared against it.
      const values = assembleFields(after, new Set([...fields].filter((f) => !conflictedFields.has(f))));
      if (Object.keys(values).length > 0) await applyEntityMergeResult(entityType, entityId, { applied: values, conflicts: [] }, { remoteUpdatedAt });
    } else {
      // A new entity: everything known about it, not only this segment's paths.
      const everything = assembleFields(after);
      const fieldsToCreate = Object.fromEntries(Object.entries(everything).filter(([k]) => allowed.has(k)));
      await createEntity(entityType, entityId, remoteUpdatedAt ? { ...fieldsToCreate, created_at: remoteUpdatedAt, updated_at: remoteUpdatedAt } : fieldsToCreate);
    }
  }
  if (disputed.size > 0) {
    // Shown as whole fields: this device's value, and the field as the
    // other device's changes would make it.
    const theirs = new Map(before);
    for (const [path, value] of disputed) theirs.set(path, value);
    const conflicts = [...conflictedFields].map((fieldName) => {
      const only = new Set([fieldName]);
      return { fieldName, baseValue: null, localValue: assembleFields(before, only)[fieldName] ?? null, remoteValue: assembleFields(theirs, only)[fieldName] ?? null };
    });
    await applyEntityMergeResult(entityType, entityId, { applied: {}, conflicts }, { remoteUpdatedAt });
  }
  return { applied, ignored, conflicts: conflictedFields.size };
}

/** Paths the log knows for an entity — for tests and the future history view. */
export async function listFieldState(entityType: string, entityId: string): Promise<Map<string, PathState>> {
  return loadState(entityType, entityId);
}
