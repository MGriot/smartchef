// ════════════════════════════════════════════════════════════════════════
// SmartChef — where sync v2 devices meet (docs/plans/2026-11-01-sync-v2-
// change-log.md §4)
//
// Three operations are all a store has to offer. There is no compare-and-
// swap and no delete in the hot path: every file is either immutable
// (segments, snapshots, blobs — content or range in the name, so two
// writers of the same name write the same bytes) or written by one device
// only (its own head). A listing that comes back incomplete is harmless:
// what it missed is read on the next cycle.
//
// The layout, under one root folder so v2 can share a Sync Folder with the
// git era's files during migration:
//
//   smartchef-v2/format.json                       library id + version
//   smartchef-v2/devices/<id>/head.json            that device's last seq + what it has read
//   smartchef-v2/devices/<id>/log/<from>-<to>.json.gz   its changes, immutable
//   smartchef-v2/blobs/<sha256>.<ext>              images, immutable
// ════════════════════════════════════════════════════════════════════════

import type { RemoteTransport } from '../sync/gitObjectTransport';

export interface SyncStore {
  /** Names of the entries directly under `prefix` (a folder), [] when it
   *  doesn't exist. */
  list(prefix: string): Promise<string[]>;
  /** The file's bytes, or null when there is no such file. */
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, data: Uint8Array): Promise<void>;
}

export const STORE_ROOT = 'smartchef-v2';

/** A store over a folder transport — the Electron folder and the Android
 *  Storage Access Framework tree the git era already uses (the same
 *  physical folder, under STORE_ROOT). */
export function storeFromTransport(transport: RemoteTransport, root = STORE_ROOT): SyncStore {
  const at = (path: string) => (root ? `${root}/${path}` : path);
  return {
    list: (prefix) => transport.listDir(at(prefix)),
    async get(path) {
      try {
        if (!(await transport.exists(at(path)))) return null;
        return await transport.readFile(at(path));
      } catch {
        return null;
      }
    },
    put: (path, data) => transport.writeFile(at(path), data),
  };
}

/** In memory — for tests, and to try the protocol without a backend. */
export function createMemoryStore(): SyncStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async list(prefix) {
      const dir = prefix.replace(/\/+$/, '') + '/';
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(dir)) names.add(path.slice(dir.length).split('/')[0]);
      }
      return [...names].sort();
    },
    async get(path) {
      const data = files.get(path);
      return data ? new Uint8Array(data) : null;
    },
    async put(path, data) {
      files.set(path, new Uint8Array(data));
    },
  };
}
