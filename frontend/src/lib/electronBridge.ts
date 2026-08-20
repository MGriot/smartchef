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

/** The IPC-backed fs primitives gitfs.ts uses on Electron — throws if
 *  accessed outside the Electron app, same guard as pickSyncFolder(). */
export function electronFs() {
  if (!window.smartchefElectron) {
    throw new Error('electronFs() is only available in the Electron app');
  }
  return window.smartchefElectron.fs;
}
