// ════════════════════════════════════════════════════════════════════════
// SmartChef — fs adapter for isomorphic-git (standalone mode, all platforms)
//
// isomorphic-git needs a `PromiseFsClient`: { promises: { readFile,
// writeFile, unlink, readdir, mkdir, rmdir, stat, lstat } }, shaped like
// Node's fs.promises. Two backends, chosen at runtime via isElectron():
//   - Mobile (Android): @capacitor/filesystem, scoped under
//     Directory.Data/SmartChef — the app's PRIVATE storage, not the
//     Documents folder. Android's git working copy lives here and is never
//     directly reachable by an OS-level cloud client; getting a device's
//     commits to another device is the SafMirror plugin's job (see
//     docs/plans/2026-08-15-android-folder-sync-parity-design.md) — it
//     mirrors this private working copy to/from a SAF tree the user picks
//     (which can be a Drive/OneDrive folder), rather than isomorphic-git
//     touching that tree directly. This file only ever deals with the
//     private copy; the mirror step is a separate layer above it
//     (frontend/src/lib/sync/androidMirror.ts).
//   - Electron (Windows/Linux desktop): no SAF restriction, so the user
//     picks any real folder (lib/electronBridge.ts's pickSyncFolder()) and
//     isomorphic-git runs directly against it — no mirror layer needed,
//     unlike Android. Every call here goes through IPC to the main
//     process, which has real Node fs access (frontend/electron/src/
//     index.ts's smartchef-fs-* handlers) — the renderer can't
//     `require('fs')` directly under contextIsolation.
//
// Both platforms scope to a SmartChef/ subfolder of their respective base
// (private storage for Android, the picked folder for Electron) rather
// than using that base's root directly — on Electron this avoids treating
// an arbitrary user-picked folder (which might hold unrelated files) as
// entirely ours; on Android it's mostly for symmetry with Electron, since
// private storage has nothing else in it to collide with.
//
// gitSync.ts calls getSyncBasePath() once to get isomorphic-git's `dir`
// and never touches paths itself beyond that — every primitive below
// treats an incoming path as already being in the right shape for whichever
// backend is active.
// ════════════════════════════════════════════════════════════════════════

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { isElectron, electronFs, pickSyncFolder } from './electronBridge';

const BASE_DIR = Directory.Data;
const MOBILE_SYNC_DIR = '/SmartChef';
const ELECTRON_FOLDER_KEY = 'smartchef.sync.electronFolder';

function normalize(path: string): string {
  return path.replace(/^\/+/, '');
}

function isUtf8Request(options: unknown): boolean {
  if (typeof options === 'string') return /utf-?8/i.test(options);
  if (options && typeof options === 'object' && 'encoding' in options) {
    return /utf-?8/i.test(String((options as { encoding?: string }).encoding ?? ''));
  }
  return false;
}

// ── base64 <-> Uint8Array (mobile path only — Electron's IPC structured-
// clones Uint8Array directly, no encoding needed) ─────────────────────────

// Exported too — androidMirror.ts needs the same conversion for SafMirror
// plugin calls, which also speak base64 (see SafMirrorPlugin.java).
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Built in fixed-size pieces rather than one character at a time. The
 *  per-character `binary += String.fromCharCode(bytes[i])` this replaces
 *  reallocates a progressively longer string on every byte, which is fine
 *  for the few-KB entity JSON this mostly handles and catastrophic for the
 *  one case that is neither small nor optional: the packfile a first sync
 *  fetches, which isomorphic-git then writes straight back through here.
 *  8 KB per apply() stays inside the argument-count limit that makes the
 *  obvious `String.fromCharCode(...bytes)` throw on a large array. */
const BASE64_CHUNK_BYTES = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES)));
  }
  return btoa(pieces.join(''));
}

class NotFoundError extends Error {
  code = 'ENOENT';
  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`);
  }
}

// ── Electron folder selection ───────────────────────────────────────────

let cachedElectronFolder: string | null | undefined; // undefined = not loaded yet

/** The raw folder the user picked via chooseElectronSyncFolder() — no
 *  subfolder appended. This is the Sync Folder's actual root: Android's
 *  RemoteTransport (androidRemoteTransport.ts) writes `.git/**`/`devices/**`
 *  directly under the picked SAF tree with no subfolder either, so
 *  electronRemoteTransport.ts must resolve against this, not
 *  getSyncBasePath() below (see its own history: getSyncBasePath()'s
 *  `/SmartChef` suffix is a leftover from the pre-rewrite design where
 *  Electron used the picked folder directly as its own git working tree —
 *  using it here silently pointed Electron's push/pull at a different
 *  physical location than Android's, so the two devices never saw each
 *  other's data despite Syncthing successfully replicating the folder). */
export async function getElectronFolder(): Promise<string | null> {
  if (cachedElectronFolder !== undefined) return cachedElectronFolder;
  const { value } = await Preferences.get({ key: ELECTRON_FOLDER_KEY });
  cachedElectronFolder = value ?? null;
  return cachedElectronFolder;
}

/** Opens the native folder picker and persists the choice. Electron only —
 *  called from the "Use offline on this device" first-run flow and from
 *  the Folder Sync card's "Change Folder" button. */
export async function chooseElectronSyncFolder(): Promise<string | null> {
  const chosen = await pickSyncFolder();
  if (!chosen) return null;
  cachedElectronFolder = chosen;
  await Preferences.set({ key: ELECTRON_FOLDER_KEY, value: chosen });
  return chosen;
}

/** Un-persists the chosen sync folder entirely — for a "Remove"/"undo" step
 *  in a picker UI (e.g. ServerConnect.tsx's onboarding flow) where the user
 *  picked a folder via chooseElectronSyncFolder() but then backed out
 *  before it should ever take effect. Distinct from simply not calling
 *  chooseElectronSyncFolder() in the first place, since that call already
 *  persisted the choice. */
export async function clearElectronSyncFolder(): Promise<void> {
  cachedElectronFolder = null;
  await Preferences.remove({ key: ELECTRON_FOLDER_KEY });
}

/** isomorphic-git's `dir` — private storage on Android, or the user-chosen
 *  Electron path. Throws on Electron if no folder has been chosen yet
 *  (callers must run chooseElectronSyncFolder() first, during onboarding). */
export async function getSyncBasePath(): Promise<string> {
  if (!isElectron()) return MOBILE_SYNC_DIR;
  const folder = await getElectronFolder();
  if (!folder) throw new Error('No sync folder chosen yet — call chooseElectronSyncFolder() first.');
  return `${folder}/SmartChef`;
}

// ── fs primitives ────────────────────────────────────────────────────────

async function readFile(path: string, options?: unknown): Promise<string | Uint8Array> {
  if (isElectron()) {
    const result = await electronFs().readFile(path, isUtf8Request(options) ? 'utf8' : undefined);
    if (result === undefined) throw new NotFoundError(path);
    return result;
  }
  const p = normalize(path);
  try {
    if (isUtf8Request(options)) {
      const { data } = await Filesystem.readFile({ path: p, directory: BASE_DIR, encoding: Encoding.UTF8 });
      return data as string;
    }
    const { data } = await Filesystem.readFile({ path: p, directory: BASE_DIR });
    return base64ToBytes(data as string);
  } catch {
    throw new NotFoundError(path);
  }
}

/** Above this, a binary write goes across in slices instead of one piece.
 *
 *  MUST stay a multiple of 3. Base64 encodes in 3-byte groups, so slicing
 *  anywhere else makes every piece but the last end in `=` padding, and
 *  appending those produces a file that is silently longer and wrong
 *  rather than one that fails loudly. 786,432 = 3 × 262,144. */
const BINARY_CHUNK_BYTES = 768 * 1024;

/** Writes a large binary file in bounded pieces.
 *
 *  Same reasoning as nativeHttpClient.ts's read path, in the other
 *  direction: a fetched packfile is ~16 MB on a real library, and handing
 *  that to Filesystem.writeFile() in one call means a ~22 MB base64 string,
 *  Capacitor's JSON serialization of it, and the native side's decode, all
 *  live at once — on top of whatever the fetch that produced it is still
 *  holding.
 *
 *  Assembled under a `.part` name and renamed at the end so a failure
 *  partway through cannot leave a truncated object or pack sitting at the
 *  real path, where git would later read it as corrupt rather than absent. */
async function writeBinaryInChunks(p: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${p}.part`;
  try {
    for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_BYTES) {
      const slice = bytes.subarray(offset, offset + BINARY_CHUNK_BYTES);
      const data = bytesToBase64(slice);
      if (offset === 0) {
        await Filesystem.writeFile({ path: tmp, directory: BASE_DIR, data, recursive: true });
      } else {
        await Filesystem.appendFile({ path: tmp, directory: BASE_DIR, data });
      }
    }
    // Filesystem.rename() does not promise to replace an existing
    // destination, and git does rewrite some paths (a ref, a re-fetched
    // pack) — so clear it first. Best-effort: not existing is the norm.
    await Filesystem.deleteFile({ path: p, directory: BASE_DIR }).catch(() => {});
    await Filesystem.rename({ from: tmp, to: p, directory: BASE_DIR });
  } catch (err) {
    await Filesystem.deleteFile({ path: tmp, directory: BASE_DIR }).catch(() => {});
    throw err;
  }
}

async function writeFile(path: string, data: string | Uint8Array, _options?: unknown): Promise<void> {
  if (isElectron()) {
    await electronFs().writeFile(path, data);
    return;
  }
  const p = normalize(path);
  if (typeof data === 'string') {
    await Filesystem.writeFile({ path: p, directory: BASE_DIR, data, encoding: Encoding.UTF8, recursive: true });
  } else if (data.length > BINARY_CHUNK_BYTES) {
    await writeBinaryInChunks(p, data);
  } else {
    await Filesystem.writeFile({ path: p, directory: BASE_DIR, data: bytesToBase64(data), recursive: true });
  }
}

async function unlink(path: string): Promise<void> {
  if (isElectron()) {
    await electronFs().unlink(path);
    return;
  }
  try {
    await Filesystem.deleteFile({ path: normalize(path), directory: BASE_DIR });
  } catch {
    // Already gone — Node's fs.promises.unlink throws on a missing file,
    // but isomorphic-git's own cleanup paths tolerate a no-op here fine.
  }
}

async function readdir(path: string): Promise<string[]> {
  if (isElectron()) {
    return electronFs().readdir(path);
  }
  try {
    const { files } = await Filesystem.readdir({ path: normalize(path), directory: BASE_DIR });
    return files.map((f) => f.name);
  } catch {
    throw new NotFoundError(path);
  }
}

async function mkdir(path: string, _options?: unknown): Promise<void> {
  if (isElectron()) {
    await electronFs().mkdir(path);
    return;
  }
  try {
    await Filesystem.mkdir({ path: normalize(path), directory: BASE_DIR, recursive: true });
  } catch {
    // Directory already exists — treated as success, matching how
    // isomorphic-git's own callers tolerate EEXIST from concurrent mkdirs
    // of a shared parent directory during commit/checkout.
  }
}

async function rmdir(path: string): Promise<void> {
  if (isElectron()) {
    await electronFs().rmdir(path);
    return;
  }
  try {
    await Filesystem.rmdir({ path: normalize(path), directory: BASE_DIR });
  } catch {
    // Non-empty or already gone — best-effort, matches unlink()'s stance.
  }
}

interface FsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
}

async function stat(path: string): Promise<FsStat> {
  if (isElectron()) {
    const info = await electronFs().stat(path).catch(() => null);
    if (!info) throw new NotFoundError(path);
    return {
      isFile: () => info.isFile,
      isDirectory: () => info.isDirectory,
      isSymbolicLink: () => false,
      mode: info.isDirectory ? 0o40755 : 0o100644,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: 0,
      dev: 0,
    };
  }
  const p = normalize(path);
  let info;
  try {
    info = await Filesystem.stat({ path: p, directory: BASE_DIR });
  } catch {
    throw new NotFoundError(path);
  }
  const isDir = info.type === 'directory';
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    mode: isDir ? 0o40755 : 0o100644,
    size: info.size,
    mtimeMs: info.mtime,
    ctimeMs: info.ctime ?? info.mtime,
    ino: 0,
    dev: 0,
  };
}

async function rename(oldPath: string, newPath: string): Promise<void> {
  if (isElectron()) {
    await electronFs().rename(oldPath, newPath);
    return;
  }
  await Filesystem.rename({ from: normalize(oldPath), to: normalize(newPath), directory: BASE_DIR });
}

// isomorphic-git's FileSystem wrapper eagerly does `fs[command].bind(fs)`
// for every command in its required list — including readlink/symlink —
// at construction time, before any git operation runs, regardless of
// whether that particular operation would ever touch a symlink. Without
// these two, every single isomorphic-git call (git.init, commit,
// resolveRef, statusMatrix, ...) crashes immediately with "Cannot read
// properties of undefined (reading 'bind')", since `fs.readlink` is
// `undefined` and `undefined.bind` throws. This app's git working copies
// never contain symlinks (only recipes/ingredients JSON plus git's own
// plain objects/refs) and stat() above never reports isSymbolicLink() as
// true, so isomorphic-git never actually invokes these beyond the initial
// bind — they only need to exist, not do anything useful.
async function readlink(path: string): Promise<string> {
  throw new NotFoundError(path);
}

async function symlink(_target: string, path: string): Promise<void> {
  throw new NotFoundError(path);
}

/** Call once before any git operation. Mobile: just ensures /SmartChef
 *  exists under private storage — no permission prompt needed, unlike the
 *  old Directory.Documents-based path this replaced; Directory.Data is
 *  always accessible to the app without a runtime grant. Electron: a
 *  no-op here — the folder must already have been chosen via
 *  chooseElectronSyncFolder(); getSyncBasePath() throws otherwise. */
export async function ensureSyncFolderPermission(): Promise<void> {
  if (isElectron()) {
    await getSyncBasePath(); // throws with a clear message if not chosen yet
    return;
  }
  await mkdir(MOBILE_SYNC_DIR);
}

export const gitfs = {
  promises: { readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat: stat, rename, readlink, symlink },
};
