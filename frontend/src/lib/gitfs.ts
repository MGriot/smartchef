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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

class NotFoundError extends Error {
  code = 'ENOENT';
  constructor(path: string) {
    super(`ENOENT: no such file or directory, '${path}'`);
  }
}

// ── Electron folder selection ───────────────────────────────────────────

let cachedElectronFolder: string | null | undefined; // undefined = not loaded yet

async function getElectronFolder(): Promise<string | null> {
  if (cachedElectronFolder !== undefined) return cachedElectronFolder;
  const { value } = await Preferences.get({ key: ELECTRON_FOLDER_KEY });
  cachedElectronFolder = value ?? null;
  return cachedElectronFolder;
}

/** Opens the native folder picker and persists the choice. Electron only —
 *  called from the "Use offline on this device" first-run flow and from
 *  the Folder Sync card's "Change Folder" button. Stores and returns the
 *  raw picked folder (not SmartChef-suffixed) since that's what's shown to
 *  the user — getSyncBasePath() is what appends the SmartChef subfolder
 *  for the actual sync root. Creates that subfolder immediately (rather
 *  than waiting for the first sync tick to create it as a side effect of
 *  mkdir's recursive parent creation) purely so it's visible to the user
 *  right away. */
export async function chooseElectronSyncFolder(): Promise<string | null> {
  const chosen = await pickSyncFolder();
  if (!chosen) return null;
  cachedElectronFolder = chosen;
  await Preferences.set({ key: ELECTRON_FOLDER_KEY, value: chosen });
  await electronFs().mkdir(`${chosen}/SmartChef`);
  return chosen;
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

async function writeFile(path: string, data: string | Uint8Array, _options?: unknown): Promise<void> {
  if (isElectron()) {
    await electronFs().writeFile(path, data);
    return;
  }
  const p = normalize(path);
  if (typeof data === 'string') {
    await Filesystem.writeFile({ path: p, directory: BASE_DIR, data, encoding: Encoding.UTF8, recursive: true });
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
  promises: { readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat: stat, rename },
};
