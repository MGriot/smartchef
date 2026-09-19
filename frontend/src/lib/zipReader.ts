// ════════════════════════════════════════════════════════════════════════
// SmartChef — Minimal ZIP reader
//
// Several recipe apps export a zip of per-recipe files: Paprika
// (.paprikarecipes — a zip of individually gzipped JSON), Mela
// (.melarecipes), and Mealie's bulk export. Reading them needs a zip
// reader; this is one, in about a hundred lines, with no dependency.
//
// It uses the platform's own DecompressionStream for the actual inflating
// (Chromium 103+, so fine in the Electron 114 build and the Android
// WebView) and only implements the container format itself: find the End
// Of Central Directory record, walk the central directory, then read each
// entry's local header to know where its data starts.
//
// Deliberately partial: STORED and DEFLATE only, no encryption, no
// multi-disk, no ZIP64. That covers every recipe-app export in the wild;
// anything else throws with a message the import screen can show rather
// than producing half a library.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';

export interface ZipEntry {
  name: string;
  /** Uncompressed bytes. */
  bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The EOCD sits at the very end, after a comment of unknown length, so it
 *  has to be found by scanning backwards for its signature. 64 KB + 22 is
 *  the furthest it can legally be from the end. */
function findEndOfCentralDirectory(view: DataView): number {
  const maxComment = 0xffff;
  const start = Math.max(0, view.byteLength - maxComment - 22);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error(i18n.t('errors.notZip'));
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) throw new Error(i18n.t('errors.cannotUnzip'));
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Standalone gzip member — Paprika gzips each recipe *inside* the zip. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) throw new Error(i18n.t('errors.cannotGunzip'));
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function looksZipped(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Every file in the archive, decompressed. Directory entries are skipped. */
export async function readZip(input: ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const buffer = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
    : input;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  if (view.getUint32(eocd + 12, true) === 0xffffffff || offset === 0xffffffff) {
    throw new Error(i18n.t('errors.zip64'));
  }

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(i18n.t('errors.zipDamaged'));
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    offset += 46 + nameLength + extraLength + commentLength;

    // Directories are zero-length entries whose name ends in "/".
    if (name.endsWith('/')) continue;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(i18n.t('errors.zipDamaged'));
    }
    // The local header's name/extra lengths can differ from the central
    // directory's, so they must be read again here rather than reused.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.push({ name, bytes: raw.slice() });
    } else if (method === 8) {
      entries.push({ name, bytes: await inflateRaw(raw) });
    } else {
      throw new Error(i18n.t('errors.zipUnsupportedMethod', { method }));
    }
  }

  return entries;
}
