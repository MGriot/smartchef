// ════════════════════════════════════════════════════════════════════════
// SmartChef — the files sync v2 writes into a store (lib/changeLog/store.ts)
//
// Every file is gzip-compressed JSON (CompressionStream: Chromium 80+,
// Node 18+), so a segment of a few hundred changes is a few KB. Segment
// names carry their sequence range, zero-padded so a plain name sort is
// sequence order and a reader can tell from a listing alone which segments
// it still needs — and whether one is missing in between.
// ════════════════════════════════════════════════════════════════════════

import type { Segment } from '../../services/changeLog.local';

export const FORMAT_VERSION = 1;

/** format.json: which library this store holds. */
export interface StoreFormat {
  format: 'smartchef-sync';
  version: number;
  libraryId: string;
  createdAt: string;
}

/** devices/<id>/head.json: rewritten by its device after every push. */
export interface DeviceHead {
  device: string;
  /** Highest seq this device has published. */
  seq: number;
  /** How far it has applied every other device — the basis for deciding
   *  what the whole library has read (compaction) and for conflict checks. */
  seen: Record<string, number>;
  /** Display name, for the Known Devices list. */
  name?: string;
  updatedAt: string;
}

const SEQ_WIDTH = 12;

export function segmentName(from: number, to: number): string {
  return `${String(from).padStart(SEQ_WIDTH, '0')}-${String(to).padStart(SEQ_WIDTH, '0')}.json.gz`;
}

export function parseSegmentName(name: string): { from: number; to: number } | null {
  const m = /^(\d+)-(\d+)\.json\.gz$/.exec(name);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from >= 1 && to >= from ? { from, to } : null;
}

export const paths = {
  format: 'format.json',
  devices: 'devices',
  head: (device: string) => `devices/${device}/head.json`,
  log: (device: string) => `devices/${device}/log`,
  segment: (device: string, from: number, to: number) => `devices/${device}/log/${segmentName(from, to)}`,
  blobs: 'blobs',
  blob: (name: string) => `blobs/${name}`,
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeJson(value: unknown): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream('gzip'));
}

export async function decodeJson<T>(bytes: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')))) as T;
}

/** format.json and head.json stay plain JSON: tiny, and readable by a
 *  person looking into the folder. */
export const plainJson = {
  encode: (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2)),
  decode: <T>(bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as T,
};

/** A segment file's content, checked enough that a stray or truncated file
 *  is refused instead of half-applied. */
export function isSegment(value: unknown): value is Segment {
  const v = value as Segment;
  return !!v && typeof v.device === 'string' && !!v.seen && typeof v.seen === 'object' && Array.isArray(v.changes)
    && v.changes.every((c) => Number.isInteger(c.seq) && typeof c.hlc === 'string' && typeof c.entityType === 'string'
      && typeof c.entityId === 'string' && typeof c.path === 'string');
}
