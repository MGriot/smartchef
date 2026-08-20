// ════════════════════════════════════════════════════════════════════════
// SmartChef — Content-addressed image storage (standalone mode)
// wayfinder ticket 05 (standalone-storage-sync map): images are stored
// under Local Storage at a content-addressed path (images/<sha256>.<ext>),
// full-resolution/unmodified (ADR 0003 — resolution policy already decided,
// this module only owns naming/dedup/movement). Local Storage previously
// had no image-serving path at all in standalone mode.
//
// Distinct from gitfs.ts: that module's fs adapter is isomorphic-git's own
// working-copy filesystem (currently the sync working copy, soon to become
// the Hidden Clone). This one is Local Storage's own image folder — a
// different location on both platforms, never touched by sync directly.
// ════════════════════════════════════════════════════════════════════════

import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { isElectron, electronFs, getLocalStorageDir } from './electronBridge';
import { bytesToBase64 } from './gitfs';

const ANDROID_BASE_DIR = Directory.Data;
const ANDROID_LOCAL_STORAGE_SUBDIR = 'SmartChef-local';

/** Minimal fs surface storeImage()/readImage() need — small enough to fake
 *  in tests without touching @capacitor/filesystem or electronBridge at all. */
export interface ImageFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // TS's DOM lib types SubtleCrypto.digest()/BlobPart as wanting a
  // Uint8Array<ArrayBuffer> specifically, not the more general
  // Uint8Array<ArrayBufferLike> a plain `Uint8Array` parameter carries —
  // Uint8Array.from() normalizes that.
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sanitizeExtension(hint: string): string {
  const match = hint.match(/[a-zA-Z0-9]+/);
  return match ? match[0].toLowerCase() : 'bin';
}

/** Writes `bytes` under a content-addressed filename, skipping the actual
 *  write if that exact file already exists (dedup — identical images share
 *  one file). Returns the relative path to store in an entity's image
 *  column, e.g. `images/<hash>.jpg`. */
export async function storeImage(bytes: Uint8Array, extHint: string, fs: ImageFs = defaultImageFs()): Promise<string> {
  const hash = await hashBytes(bytes);
  const ext = sanitizeExtension(extHint);
  const relPath = `images/${hash}.${ext}`;
  if (!(await fs.exists(relPath))) {
    await fs.writeFile(relPath, bytes);
  }
  return relPath;
}

export async function readImage(relPath: string, fs: ImageFs = defaultImageFs()): Promise<Uint8Array> {
  return fs.readFile(relPath);
}

// ── Real per-platform ImageFs ───────────────────────────────────────────

function androidImageFs(): ImageFs {
  const path = (rel: string) => `${ANDROID_LOCAL_STORAGE_SUBDIR}/${rel}`;
  return {
    async exists(rel) {
      try {
        await Filesystem.stat({ path: path(rel), directory: ANDROID_BASE_DIR });
        return true;
      } catch {
        return false;
      }
    },
    async readFile(rel) {
      const { data } = await Filesystem.readFile({ path: path(rel), directory: ANDROID_BASE_DIR });
      const binary = atob(data as string);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },
    async writeFile(rel, data) {
      await Filesystem.writeFile({ path: path(rel), directory: ANDROID_BASE_DIR, data: bytesToBase64(data), recursive: true });
    },
  };
}

function electronImageFs(): ImageFs {
  const path = async (rel: string) => `${await getLocalStorageDir()}/${rel}`;
  return {
    async exists(rel) {
      const info = await electronFs().stat(await path(rel)).catch(() => null);
      return info !== null;
    },
    async readFile(rel) {
      const data = await electronFs().readFile(await path(rel));
      return data as Uint8Array;
    },
    async writeFile(rel, data) {
      await electronFs().writeFile(await path(rel), data);
    },
  };
}

function defaultImageFs(): ImageFs {
  return isElectron() ? electronImageFs() : androidImageFs();
}

// ── Display ───────────────────────────────────────────────────────────
// Capacitor.convertFileSrc() only does real work on native platforms (iOS/
// Android) — its web/Electron fallback is an identity passthrough (verified
// against @capacitor/core's source), which is not a loadable <img src> for
// an arbitrary absolute filesystem path. Electron gets its own path: read
// the bytes over the same IPC bridge gitfs.ts already uses and hand back an
// object URL instead.

/** Resolves a stored relative path (as returned by storeImage()) to a URL
 *  usable directly in an <img src>. Caller owns the returned Electron blob
 *  URL's lifecycle (URL.revokeObjectURL when done) — native's convertFileSrc
 *  URL needs no such cleanup. */
export async function resolveImageSrc(relPath: string): Promise<string> {
  if (isElectron()) {
    const bytes = await electronImageFs().readFile(relPath);
    return URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
  }
  const { uri } = await Filesystem.getUri({ path: `${ANDROID_LOCAL_STORAGE_SUBDIR}/${relPath}`, directory: ANDROID_BASE_DIR });
  return Capacitor.convertFileSrc(uri);
}
