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
import { bytesToBase64, base64ToBytes } from './gitfs';

const ANDROID_BASE_DIR = Directory.Data;
const ANDROID_LOCAL_STORAGE_SUBDIR = 'SmartChef-local';
/** The one folder name every stored image lives under, on both platforms
 *  and inside the Hidden Clone. Shared with lib/sync/imageSync.ts so the
 *  two locations can never drift apart. */
export const IMAGES_SUBDIR = 'images';

/** Minimal fs surface storeImage()/readImage() need — small enough to fake
 *  in tests without touching @capacitor/filesystem or electronBridge at all. */
export interface ImageFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Every stored image's relative path (`images/<hash>.<ext>`). Returns an
   *  empty list when the folder doesn't exist yet — "nothing stored" and
   *  "never created" are the same answer to every caller. Added for
   *  lib/sync/imageSync.ts, which has to enumerate the store to replicate
   *  it; storeImage()/readImage() never need it. */
  list(): Promise<string[]>;
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

/** True for an inline **base64** `data:image/...;base64,...` URI — a whole
 *  encoded photo sitting in the database column that is supposed to hold a
 *  *reference* to one. Nothing in the app writes these any more
 *  (pageFetcher.ts's absoluteImageUrl() turns them away on import), but
 *  restoring a with-images backup used to put them there, and a device that
 *  ever did that still carries them: see lib/inlineImageMigration.ts, which
 *  moves them into the content-addressed store this module owns.
 *
 *  Deliberately narrower than "any data: URI". A percent-encoded
 *  `data:image/svg+xml,%3csvg…` is how the generated profile avatars are
 *  stored — a few hundred bytes of markup, not a photo, with nothing to gain
 *  from being moved to a file and no base64 payload to decode. Matching it
 *  here would mean failing to convert it on every single launch, forever. */
export function isInlineDataUri(value: string | null | undefined): boolean {
  return !!value && /^data:image\/[a-z0-9.+-]*;base64,/i.test(value);
}

/** Splits an inline `data:` URI into the bytes it encodes plus an extension
 *  hint taken from its declared media type (`image/webp` -> `webp`), ready
 *  for storeImage(). Throws on anything that is not base64-encoded image
 *  data, so a malformed value fails loudly at the one call site that
 *  handles it rather than silently storing garbage. */
export function decodeDataUri(uri: string): { bytes: Uint8Array; extHint: string } {
  const match = /^data:(image\/[a-z0-9.+-]+)?;base64,(.*)$/is.exec(uri);
  if (!match) throw new Error('not a base64 image data: URI');
  const mime = match[1] ?? 'image/bin';
  // jpeg/webp/png already read as their own extension; `image/svg+xml`
  // sanitizes down to "svg" in storeImage()'s own sanitizeExtension().
  const extHint = mime.slice('image/'.length);
  return { bytes: base64ToBytes(match[2]), extHint };
}

/** True for a value storeImage() itself produced (`images/<hash>.<ext>`) —
 *  the only shape that needs resolveImageSrc() before it's loadable in an
 *  `<img src>`. Everything else an image field can legitimately hold
 *  (an absolute http(s) URL from server-mode uploads or a pasted link, a
 *  root-relative bundled asset path like a preset avatar) is already
 *  directly loadable as-is — used by useResolvedImageSrc() to decide
 *  whether a value needs resolving at all. */
export function isLocalImagePath(value: string | null | undefined): boolean {
  return !!value && /^images\//.test(value);
}

/** Writes `bytes` under a content-addressed filename, skipping the actual
 *  write if that exact file already exists (dedup — identical images share
 *  one file). Returns the relative path to store in an entity's image
 *  column, e.g. `images/<hash>.jpg`. */
export async function storeImage(bytes: Uint8Array, extHint: string, fs: ImageFs = defaultImageFs()): Promise<string> {
  const hash = await hashBytes(bytes);
  const ext = sanitizeExtension(extHint);
  const relPath = `${IMAGES_SUBDIR}/${hash}.${ext}`;
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
      return base64ToBytes(data as string);
    },
    async writeFile(rel, data) {
      await Filesystem.writeFile({ path: path(rel), directory: ANDROID_BASE_DIR, data: bytesToBase64(data), recursive: true });
    },
    async list() {
      try {
        const { files } = await Filesystem.readdir({ path: path(IMAGES_SUBDIR), directory: ANDROID_BASE_DIR });
        return files.filter((f) => f.type !== 'directory').map((f) => `${IMAGES_SUBDIR}/${f.name}`);
      } catch {
        return [];
      }
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
    async list() {
      try {
        const names = await electronFs().readdir(await path(IMAGES_SUBDIR));
        return (names as string[]).map((name) => `${IMAGES_SUBDIR}/${name}`);
      } catch {
        return [];
      }
    },
  };
}

/** The real per-platform store. Exported for lib/sync/imageSync.ts, which
 *  needs the same store every screen reads from; everything else should go
 *  through storeImage()/readImage()/resolveImageSrc() instead. */
export function defaultImageFs(): ImageFs {
  return isElectron() ? electronImageFs() : androidImageFs();
}

// ── Display ───────────────────────────────────────────────────────────
// Capacitor.convertFileSrc() only does real work on native platforms (iOS/
// Android) — its web/Electron fallback is an identity passthrough (verified
// against @capacitor/core's source), which is not a loadable <img src> for
// an arbitrary absolute filesystem path. Electron gets its own path: read
// the bytes over the same IPC bridge gitfs.ts already uses and hand back an
// object URL instead.

// Resolving is not free on either platform — Electron reads the whole file
// over the IPC bridge and allocates a Blob, Android crosses the Capacitor
// bridge for Filesystem.getUri() — and the same handful of paths get
// resolved over and over: every gallery mount re-resolves every visible
// cover, and returning to the gallery from a recipe does it all again. A
// content-addressed path is immutable by construction (the hash IS the
// content), so a resolved URL for one can be cached for the life of the
// session without any staleness risk.
//
// Consequence for callers: the returned URL is now owned by this cache, NOT
// by the caller. Revoking it would break every other component still
// showing the same image. Eviction below is the only thing that revokes.
const MAX_CACHED_SRCS = 150;
const srcCache = new Map<string, string>();
// Separate from the cache: two components mounting in the same frame for
// the same cover would otherwise each start their own resolve. They share
// one.
const inFlight = new Map<string, Promise<string>>();

function rememberSrc(relPath: string, src: string): void {
  // Map iterates in insertion order, so the first key is the oldest —
  // enough of an LRU for a bounded set of images, without a second
  // structure to keep in step.
  if (srcCache.size >= MAX_CACHED_SRCS) {
    const oldest = srcCache.keys().next();
    if (!oldest.done) {
      const evicted = srcCache.get(oldest.value);
      srcCache.delete(oldest.value);
      // Only Electron's branch allocates one; convertFileSrc URLs are plain
      // strings with nothing to release.
      if (evicted?.startsWith('blob:')) URL.revokeObjectURL(evicted);
    }
  }
  srcCache.set(relPath, src);
}

/** Resolves a stored relative path (as returned by storeImage()) to a URL
 *  usable directly in an <img src>, memoized per session.
 *
 *  The returned URL belongs to this module's cache — do NOT revoke it.
 *  (It used to be the caller's to release, which is why useResolvedImageSrc()
 *  no longer does.) */
export async function resolveImageSrc(relPath: string): Promise<string> {
  const cached = srcCache.get(relPath);
  if (cached) return cached;

  const pending = inFlight.get(relPath);
  if (pending) return pending;

  const work = (async () => {
    if (isElectron()) {
      const bytes = await electronImageFs().readFile(relPath);
      return URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
    }
    const { uri } = await Filesystem.getUri({ path: `${ANDROID_LOCAL_STORAGE_SUBDIR}/${relPath}`, directory: ANDROID_BASE_DIR });
    return Capacitor.convertFileSrc(uri);
  })();

  inFlight.set(relPath, work);
  try {
    const src = await work;
    rememberSrc(relPath, src);
    return src;
  } finally {
    inFlight.delete(relPath);
  }
}

/** The cached URL for a path, or null if it hasn't been resolved yet.
 *  Synchronous by design: it lets a component render an already-resolved
 *  image on its very first frame instead of returning null once and
 *  repainting, which is what made re-entering the gallery flash every
 *  placeholder. */
export function peekResolvedImageSrc(relPath: string): string | null {
  return srcCache.get(relPath) ?? null;
}

/** Drops a path from the resolve cache — needed only when the bytes behind
 *  a path could have changed, which for a content-addressed path means
 *  "the file was deleted or rewritten", not "the image was edited" (an
 *  edited image gets a different hash and therefore a different path). */
export function forgetResolvedImageSrc(relPath: string): void {
  const cached = srcCache.get(relPath);
  if (cached?.startsWith('blob:')) URL.revokeObjectURL(cached);
  srcCache.delete(relPath);
}
