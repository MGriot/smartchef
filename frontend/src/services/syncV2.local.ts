// ════════════════════════════════════════════════════════════════════════
// SmartChef — sync v2 cycle (docs/plans/2026-11-01-sync-v2-change-log.md
// §2, phase 2)
//
// One cycle against a store (lib/changeLog/store.ts):
//
//   1. format.json — create it on an empty store; refuse a store written by
//      a newer format than this build understands.
//   2. Pull — for every other device whose head is ahead of this device's
//      cursor for it, read its log segments in order and apply them
//      (changeLog.local.ts applySegment). A segment missing from the
//      listing stops that device's catch-up for this cycle rather than
//      skipping over it: the cursor only ever moves over changes that were
//      really applied.
//   3. Push — this device's changes after what its own head says it
//      published, as one or more segments, then the head. Pulling first
//      means the head's `seen` already counts what was just applied, so the
//      other devices read this device's edits as made with theirs in view.
//   4. Images — content-addressed, so both directions are "copy what the
//      other side lacks".
//
// Nothing here needs a lock or a retry: a cycle that stops halfway leaves
// immutable files and cursors that the next cycle simply continues from.
// ════════════════════════════════════════════════════════════════════════

import type { ConflictPolicy } from '../lib/structuredMerge';
import type { SyncStore } from '../lib/changeLog/store';
import {
  FORMAT_VERSION, decodeJson, encodeJson, isSegment, parseSegmentName, paths, plainJson,
  type DeviceHead, type StoreFormat,
} from '../lib/changeLog/files';
import type { ImageFs } from '../lib/localImages';
import { IMAGES_SUBDIR, hashBytes } from '../lib/localImages';
import { applySegment, applySnapshot, buildSegment, buildSnapshot, readCursors, type Segment, type Snapshot } from './changeLog.local';
import { snapshotId, type SnapshotMeta } from '../lib/changeLog/files';

/** Changes per segment file: large enough that a busy day is one file,
 *  small enough that a first push of a big library is several readable ones. */
export const SEGMENT_MAX_CHANGES = 2000;
/** A new snapshot once the library has moved this many changes past the
 *  newest one — what a new device would otherwise replay one by one. */
export const SNAPSHOT_EVERY_CHANGES = 5000;
/** Segments are kept this long after a snapshot covers them (decision:
 *  "fold old history into snapshots"), and only once every device has read them. */
export const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/** Snapshots a device keeps of its own; older ones it deletes. */
const SNAPSHOTS_KEPT = 2;

export interface SyncV2Options {
  device: string;
  deviceName?: string;
  policy: ConflictPolicy;
  /** The local image store; images are skipped when omitted. */
  images?: ImageFs;
  /** Overrides SEGMENT_MAX_CHANGES (tests). */
  segmentMaxChanges?: number;
  /** Overrides SNAPSHOT_EVERY_CHANGES and RETENTION_MS (tests). */
  snapshotEveryChanges?: number;
  retentionMs?: number;
  now?: () => number;
}

export interface SyncV2Report {
  libraryId: string;
  pulledChanges: number;
  pushedChanges: number;
  conflicts: number;
  failed: Array<{ entityType: string; entityId: string; error: string }>;
  /** Devices whose log has a gap this cycle could not read past. */
  incompleteDevices: string[];
  imagesUploaded: number;
  imagesDownloaded: number;
  /** A snapshot was applied to catch up (a new or long-absent device). */
  caughtUpFromSnapshot: boolean;
  snapshotWritten: boolean;
  segmentsCompacted: number;
}

let running: Promise<SyncV2Report> | null = null;

/** One cycle. Concurrent calls share the cycle already running. */
export function syncOnceV2(store: SyncStore, opts: SyncV2Options): Promise<SyncV2Report> {
  if (!running) running = runCycle(store, opts).finally(() => { running = null; });
  return running;
}

async function runCycle(store: SyncStore, opts: SyncV2Options): Promise<SyncV2Report> {
  await store.begin?.();
  const format = await ensureFormat(store);
  const report: SyncV2Report = {
    libraryId: format.libraryId, pulledChanges: 0, pushedChanges: 0, conflicts: 0, failed: [],
    incompleteDevices: [], imagesUploaded: 0, imagesDownloaded: 0,
    caughtUpFromSnapshot: false, snapshotWritten: false, segmentsCompacted: 0,
  };

  // Images first on the way in: a recipe that arrives below can then show
  // its photo straight away.
  if (opts.images) report.imagesDownloaded = await downloadImages(store, opts.images);
  const snapshots = await readSnapshotMetas(store);
  await catchUpFromSnapshot(store, opts, report, snapshots);
  await pull(store, opts, report);
  const heads = await push(store, opts, report);
  await maybeWriteSnapshot(store, opts, report, snapshots, heads);
  await compact(store, opts, report, snapshots, heads);
  if (opts.images) report.imagesUploaded = await uploadImages(store, opts.images);
  await store.finish?.();
  return report;
}

async function ensureFormat(store: SyncStore): Promise<StoreFormat> {
  const bytes = await store.get(paths.format);
  if (bytes) {
    const format = plainJson.decode<StoreFormat>(bytes);
    if (format.format !== 'smartchef-sync' || typeof format.libraryId !== 'string') {
      throw new Error('This folder holds something that is not a SmartChef library.');
    }
    if (format.version > FORMAT_VERSION) {
      throw new Error('This library was synced by a newer version of SmartChef. Update the app on this device to keep syncing.');
    }
    return format;
  }
  const format: StoreFormat = { format: 'smartchef-sync', version: FORMAT_VERSION, libraryId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await store.put(paths.format, plainJson.encode(format));
  return format;
}

async function readHead(store: SyncStore, device: string): Promise<DeviceHead | null> {
  const bytes = await store.get(paths.head(device));
  if (!bytes) return null;
  try {
    const head = plainJson.decode<DeviceHead>(bytes);
    return Number.isInteger(head.seq) ? head : null;
  } catch {
    return null;
  }
}

async function pull(store: SyncStore, opts: SyncV2Options, report: SyncV2Report): Promise<void> {
  const devices = (await store.list(paths.devices)).filter((d) => d !== opts.device);
  const cursors = await readCursors();
  for (const device of devices) {
    const head = await readHead(store, device);
    let cursor = cursors[device] ?? 0;
    if (!head || head.seq <= cursor) continue;
    const segments = (await store.list(paths.log(device)))
      .map((name) => ({ name, range: parseSegmentName(name) }))
      .filter((s): s is { name: string; range: { from: number; to: number } } => !!s.range && s.range.to > cursor)
      .sort((a, b) => a.range.from - b.range.from);
    for (const { range } of segments) {
      if (range.from > cursor + 1) break; // a gap: never skip changes
      const bytes = await store.get(paths.segment(device, range.from, range.to));
      if (!bytes) break;
      let segment: Segment;
      try {
        const decoded = await decodeJson<unknown>(bytes);
        if (!isSegment(decoded) || decoded.device !== device) break;
        segment = decoded;
      } catch {
        break; // a half-written file: read it next cycle
      }
      const applied = await applySegment(segment, { device: opts.device, policy: opts.policy });
      report.pulledChanges += applied.applied;
      report.conflicts += applied.conflicts;
      report.failed.push(...applied.failed);
      cursor = Math.max(cursor, range.to);
    }
    if (cursor < head.seq) report.incompleteDevices.push(device);
  }
}

/** Every device's head, this one's as just written — what snapshots and
 *  compaction decide from. */
type Heads = Map<string, DeviceHead>;

async function push(store: SyncStore, opts: SyncV2Options, report: SyncV2Report): Promise<Heads> {
  const head = await readHead(store, opts.device);
  const published = head?.seq ?? 0;
  const segment = await buildSegment(opts.device, published);
  let seq = published;
  const max = opts.segmentMaxChanges ?? SEGMENT_MAX_CHANGES;
  for (let i = 0; i < segment.changes.length; i += max) {
    const changes = segment.changes.slice(i, i + max);
    const from = changes[0].seq;
    const to = changes[changes.length - 1].seq;
    await store.put(paths.segment(opts.device, from, to), await encodeJson({ ...segment, changes }));
    seq = to;
    report.pushedChanges += changes.length;
  }
  // The head is rewritten even with nothing new to publish: its `seen` is
  // what tells the others how far this device has read them.
  const next: DeviceHead = {
    device: opts.device, seq, seen: segment.seen, ...(opts.deviceName ? { name: opts.deviceName } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (!head || head.seq !== next.seq || JSON.stringify(head.seen) !== JSON.stringify(next.seen) || head.name !== next.name) {
    await store.put(paths.head(opts.device), plainJson.encode(next));
  }
  const heads: Heads = new Map([[opts.device, next]]);
  for (const device of await store.list(paths.devices)) {
    if (device === opts.device) continue;
    const other = await readHead(store, device);
    if (other) heads.set(device, other);
  }
  return heads;
}

// ── Snapshots and compaction ────────────────────────────────────────────

async function readSnapshotMetas(store: SyncStore): Promise<SnapshotMeta[]> {
  const metas: SnapshotMeta[] = [];
  for (const name of await store.list(paths.snapshots)) {
    if (!name.endsWith('.meta.json')) continue;
    const bytes = await store.get(`${paths.snapshots}/${name}`).catch(() => null);
    if (!bytes) continue;
    try {
      const meta = plainJson.decode<SnapshotMeta>(bytes);
      if (meta && typeof meta.id === 'string' && meta.covers && typeof meta.createdAt === 'string') metas.push(meta);
    } catch {
      // a half-written meta: ignored until it is whole
    }
  }
  return metas.sort((a, b) => a.id.localeCompare(b.id));
}

/** The earliest seq still published by `device`, or null with no segments. */
async function earliestSegment(store: SyncStore, device: string): Promise<number | null> {
  const ranges = (await store.list(paths.log(device))).map(parseSegmentName).filter((r): r is { from: number; to: number } => !!r);
  return ranges.length ? Math.min(...ranges.map((r) => r.from)) : null;
}

/** A device with nothing applied yet, or one whose next change has been
 *  compacted away, starts from the newest snapshot instead of segment 1. */
async function catchUpFromSnapshot(store: SyncStore, opts: SyncV2Options, report: SyncV2Report, metas: SnapshotMeta[]): Promise<void> {
  const newest = metas[metas.length - 1];
  if (!newest) return;
  const cursors = await readCursors();
  const others = Object.entries(newest.covers).filter(([d]) => d !== opts.device);
  const isNew = others.every(([d]) => !cursors[d]);
  let behind = false;
  for (const [device, seq] of others) {
    const cursor = cursors[device] ?? 0;
    if (cursor >= seq) continue;
    const earliest = await earliestSegment(store, device);
    if (earliest === null || earliest > cursor + 1) behind = true;
  }
  if (!(isNew && others.some(([, seq]) => seq > 0)) && !behind) return;
  const bytes = await store.get(paths.snapshotBody(newest.id));
  if (!bytes) return;
  let snapshot: Snapshot;
  try {
    snapshot = await decodeJson<Snapshot>(bytes);
  } catch {
    return; // a half-written body: the segments, or the next cycle
  }
  const applied = await applySnapshot(snapshot, { device: opts.device, policy: opts.policy });
  report.pulledChanges += applied.applied;
  report.conflicts += applied.conflicts;
  report.failed.push(...applied.failed);
  report.caughtUpFromSnapshot = true;
}

async function maybeWriteSnapshot(store: SyncStore, opts: SyncV2Options, report: SyncV2Report, metas: SnapshotMeta[], heads: Heads): Promise<void> {
  const newest = metas[metas.length - 1];
  let since = 0;
  for (const [device, head] of heads) since += Math.max(0, head.seq - (newest?.covers[device] ?? 0));
  if (since < (opts.snapshotEveryChanges ?? SNAPSHOT_EVERY_CHANGES)) return;
  // Only from a device that has read everyone: a snapshot is a promise that
  // it includes what it says it covers.
  const cursors = await readCursors();
  for (const [device, head] of heads) {
    if (device !== opts.device && (cursors[device] ?? 0) < head.seq) return;
  }
  const snapshot = await buildSnapshot(opts.device);
  const createdAt = new Date((opts.now ?? Date.now)()).toISOString();
  const meta: SnapshotMeta = { id: snapshotId(createdAt, opts.device), device: opts.device, createdAt, covers: snapshot.covers };
  // Body first: a meta is only ever visible once its body is there.
  await store.put(paths.snapshotBody(meta.id), await encodeJson({ ...snapshot, createdAt }));
  await store.put(paths.snapshotMeta(meta.id), plainJson.encode(meta));
  report.snapshotWritten = true;
  metas.push(meta);

  // Older snapshots of this device's own go; the newest few stay.
  const own = metas.filter((m) => m.device === opts.device);
  if (store.remove) {
    for (const old of own.slice(0, Math.max(0, own.length - SNAPSHOTS_KEPT))) {
      await store.remove(paths.snapshotMeta(old.id));
      await store.remove(paths.snapshotBody(old.id));
    }
  }
}

/** Deletes this device's own segments once a snapshot older than the
 *  retention window covers them and every device has read past them. */
async function compact(store: SyncStore, opts: SyncV2Options, report: SyncV2Report, metas: SnapshotMeta[], heads: Heads): Promise<void> {
  if (!store.remove) return;
  const now = (opts.now ?? Date.now)();
  const retention = opts.retentionMs ?? RETENTION_MS;
  const old = metas.filter((m) => now - Date.parse(m.createdAt) >= retention);
  if (old.length === 0) return;
  const coveredUpTo = Math.max(...old.map((m) => m.covers[opts.device] ?? 0));
  let readByAll = Infinity;
  for (const [device, head] of heads) if (device !== opts.device) readByAll = Math.min(readByAll, head.seen[opts.device] ?? 0);
  const limit = Math.min(coveredUpTo, readByAll);
  for (const name of await store.list(paths.log(opts.device))) {
    const range = parseSegmentName(name);
    if (!range || range.to > limit) continue;
    await store.remove(paths.segment(opts.device, range.from, range.to));
    report.segmentsCompacted += 1;
  }
}

const imageName = (relPath: string) => relPath.slice(IMAGES_SUBDIR.length + 1);
const isImageName = (name: string) => /^[0-9a-f]{64}\.[a-z0-9]+$/.test(name);

/** Local images by the key the store lists them under (their own name, or
 *  a keyed hash of it in an encrypted library). */
async function localImagesByKey(store: SyncStore, images: ImageFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const relPath of await images.list()) {
    const name = imageName(relPath);
    if (isImageName(name)) out.set(store.blobKey ? await store.blobKey(name) : name, relPath);
  }
  return out;
}

async function uploadImages(store: SyncStore, images: ImageFs): Promise<number> {
  const remote = new Set(await store.list(paths.blobs));
  let n = 0;
  for (const [key, relPath] of await localImagesByKey(store, images)) {
    if (remote.has(key)) continue;
    await store.put(paths.blob(imageName(relPath)), await images.readFile(relPath));
    n += 1;
  }
  return n;
}

async function downloadImages(store: SyncStore, images: ImageFs): Promise<number> {
  const local = await localImagesByKey(store, images);
  let n = 0;
  for (const key of await store.list(paths.blobs)) {
    if (local.has(key)) continue;
    const blob = store.getBlobByKey
      ? await store.getBlobByKey(key).catch(() => null)
      : await store.get(paths.blob(key)).then((data) => (data ? { name: key, data } : null));
    // The name is the content's hash: a file that doesn't match it is
    // truncated or not ours, and is left for the next cycle.
    if (!blob || !isImageName(blob.name) || (await hashBytes(blob.data)) !== blob.name.slice(0, 64)) continue;
    await images.writeFile(`${IMAGES_SUBDIR}/${blob.name}`, blob.data);
    n += 1;
  }
  return n;
}
