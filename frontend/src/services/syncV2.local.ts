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
import { applySegment, buildSegment, readCursors, type Segment } from './changeLog.local';

/** Changes per segment file: large enough that a busy day is one file,
 *  small enough that a first push of a big library is several readable ones. */
export const SEGMENT_MAX_CHANGES = 2000;

export interface SyncV2Options {
  device: string;
  deviceName?: string;
  policy: ConflictPolicy;
  /** The local image store; images are skipped when omitted. */
  images?: ImageFs;
  /** Overrides SEGMENT_MAX_CHANGES (tests). */
  segmentMaxChanges?: number;
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
}

let running: Promise<SyncV2Report> | null = null;

/** One cycle. Concurrent calls share the cycle already running. */
export function syncOnceV2(store: SyncStore, opts: SyncV2Options): Promise<SyncV2Report> {
  if (!running) running = runCycle(store, opts).finally(() => { running = null; });
  return running;
}

async function runCycle(store: SyncStore, opts: SyncV2Options): Promise<SyncV2Report> {
  const format = await ensureFormat(store);
  const report: SyncV2Report = {
    libraryId: format.libraryId, pulledChanges: 0, pushedChanges: 0, conflicts: 0, failed: [],
    incompleteDevices: [], imagesUploaded: 0, imagesDownloaded: 0,
  };

  // Images first on the way in: a recipe that arrives below can then show
  // its photo straight away.
  if (opts.images) report.imagesDownloaded = await downloadImages(store, opts.images);
  await pull(store, opts, report);
  await push(store, opts, report);
  if (opts.images) report.imagesUploaded = await uploadImages(store, opts.images);
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

async function push(store: SyncStore, opts: SyncV2Options, report: SyncV2Report): Promise<void> {
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
}

const imageName = (relPath: string) => relPath.slice(IMAGES_SUBDIR.length + 1);
const isImageName = (name: string) => /^[0-9a-f]{64}\.[a-z0-9]+$/.test(name);

async function uploadImages(store: SyncStore, images: ImageFs): Promise<number> {
  const remote = new Set(await store.list(paths.blobs));
  let n = 0;
  for (const relPath of await images.list()) {
    const name = imageName(relPath);
    if (!isImageName(name) || remote.has(name)) continue;
    await store.put(paths.blob(name), await images.readFile(relPath));
    n += 1;
  }
  return n;
}

async function downloadImages(store: SyncStore, images: ImageFs): Promise<number> {
  const local = new Set((await images.list()).map(imageName));
  let n = 0;
  for (const name of await store.list(paths.blobs)) {
    if (!isImageName(name) || local.has(name)) continue;
    const bytes = await store.get(paths.blob(name));
    // The name is the content's hash: a file that doesn't match it is
    // truncated or not ours, and is left for the next cycle.
    if (!bytes || (await hashBytes(bytes)) !== name.slice(0, 64)) continue;
    await images.writeFile(`${IMAGES_SUBDIR}/${name}`, bytes);
    n += 1;
  }
  return n;
}
