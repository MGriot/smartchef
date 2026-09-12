// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the Electron main process
// The `smartchefElectron` global only exists when this app is running
// inside the Electron shell (exposed via contextBridge in
// frontend/electron/src/preload.ts) — presence of that global is what
// isElectron() checks, no separate platform flag needed.
// ════════════════════════════════════════════════════════════════════════

export interface ElectronFsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

declare global {
  interface Window {
    smartchefElectron?: {
      pickSyncFolder: () => Promise<string | null>;
      getLocalStorageDir: () => Promise<string>;
      getHiddenCloneDir: () => Promise<string>;
      geocode: (q: string) => Promise<{ lat: number; lng: number; displayName: string } | null>;
      httpRequest: (req: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array; timeoutMs?: number }) => Promise<{
        url: string;
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
        body: Uint8Array;
      }>;
      fs: {
        readFile: (path: string, encoding?: string) => Promise<string | Uint8Array>;
        writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
        unlink: (path: string) => Promise<void>;
        readdir: (path: string) => Promise<string[]>;
        mkdir: (path: string) => Promise<void>;
        rmdir: (path: string) => Promise<void>;
        stat: (path: string) => Promise<ElectronFsStat>;
        rename: (oldPath: string, newPath: string) => Promise<void>;
      };
    };
  }
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.smartchefElectron;
}

/** Opens the native "choose a folder" dialog. Resolves to the chosen
 *  absolute path, or null if the user cancelled. Electron-only — desktop
 *  has no Storage Access Framework restriction, unlike Android, which
 *  picks via a SAF tree instead (see lib/safMirrorBridge.ts, lib/gitfs.ts). */
export async function pickSyncFolder(): Promise<string | null> {
  if (!window.smartchefElectron) {
    throw new Error('pickSyncFolder() is only available in the Electron app');
  }
  return window.smartchefElectron.pickSyncFolder();
}

/** Local Storage's absolute base directory on this device — where the live
 *  SQLite db and content-addressed images live, distinct from the sync
 *  folder pickSyncFolder() targets. Electron-only, same guard as
 *  pickSyncFolder(); Android's equivalent is a fixed Directory.Data
 *  subfolder resolved directly in lib/localImages.ts (no IPC needed). */
export async function getLocalStorageDir(): Promise<string> {
  if (!window.smartchefElectron) {
    throw new Error('getLocalStorageDir() is only available in the Electron app');
  }
  return window.smartchefElectron.getLocalStorageDir();
}

/** Hidden Clone's absolute base directory on this device — each device's
 *  own private git working copy, distinct from both getLocalStorageDir()
 *  and the sync folder pickSyncFolder() targets. Electron-only, same guard
 *  as pickSyncFolder(); Android's equivalent is a fixed Directory.Data
 *  subfolder resolved directly in lib/sync/hiddenClone.ts (no IPC needed). */
export async function getHiddenCloneDir(): Promise<string> {
  if (!window.smartchefElectron) {
    throw new Error('getHiddenCloneDir() is only available in the Electron app');
  }
  return window.smartchefElectron.getHiddenCloneDir();
}

/** Resolves a free-typed place name to lat/lng via Nominatim, proxied
 *  through the main process (see electron/src/index.ts's `smartchef-geocode`
 *  handler for why — Chromium's fetch can't set the User-Agent header
 *  Nominatim's usage policy requires). Electron-only; null on no match or
 *  any failure — callers already treat a missing pin as a non-error. */
export async function electronGeocode(q: string): Promise<{ lat: number; lng: number; displayName: string } | null> {
  if (!window.smartchefElectron) return null;
  return window.smartchefElectron.geocode(q);
}

/** Makes a single HTTP request from the main process (Node's fetch, not
 *  the renderer's) — see electron/src/index.ts's `smartchef-http-request`
 *  handler for why: Node's fetch isn't subject to CORS at all, so a git
 *  server's HTTP endpoint is reachable directly, no CORS proxy needed.
 *  gitRemoteTransport.ts's HttpClient adapter uses this on Electron; its
 *  Android counterpart is gitHttpBridge.ts's GitHttp plugin. Electron-only,
 *  same guard as pickSyncFolder(). */
export async function electronHttpRequest(req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Optional abort ceiling, applied in the main process — see the
   *  `smartchef-http-request` handler. Unset (git transport) means no
   *  ceiling, which is the behaviour that predates this parameter. */
  timeoutMs?: number;
}): Promise<{ url: string; statusCode: number; statusMessage: string; headers: Record<string, string>; body: Uint8Array }> {
  if (!window.smartchefElectron) {
    throw new Error('electronHttpRequest() is only available in the Electron app');
  }
  return window.smartchefElectron.httpRequest(req);
}

/** The IPC-backed fs primitives gitfs.ts uses on Electron — throws if
 *  accessed outside the Electron app, same guard as pickSyncFolder(). */
export function electronFs() {
  if (!window.smartchefElectron) {
    throw new Error('electronFs() is only available in the Electron app');
  }
  return window.smartchefElectron.fs;
}
