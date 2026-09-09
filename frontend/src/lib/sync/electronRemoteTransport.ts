// ════════════════════════════════════════════════════════════════════════
// SmartChef — Electron RemoteTransport (wayfinder ticket 01's transport
// interface, implemented for the platform gitObjectTransport.ts itself
// deliberately knows nothing about)
//
// Electron has real, direct filesystem access via electronFs() (IPC to the
// main process) — no SAF round-trip cost to worry about, so unlike
// androidRemoteTransport.ts this needs no caching layer on top of
// exists(): a local stat() is cheap enough to call unconditionally, per
// gitObjectTransport.ts's own docstring.
//
// Resolves against the raw picked Sync Folder (gitfs.ts's
// getElectronFolder()) — the folder root itself, no subfolder appended.
// This must match androidRemoteTransport.ts's own convention (the picked
// SAF tree root, no subfolder either): both platforms' RemoteTransport
// need to agree on the exact same physical location within whatever
// Syncthing folder the user shares between devices, or they silently push/
// pull to two different places and never see each other's data. (Earlier
// version of this file used gitfs.ts's getSyncBasePath(), which appends a
// `/SmartChef` subfolder — a leftover from the pre-rewrite design where
// Electron used the picked folder directly as its own git working tree.
// That's exactly the bug this comment is warning against; see gitfs.ts's
// getElectronFolder() docstring for the full story.)
// ════════════════════════════════════════════════════════════════════════

import { electronFs } from '../electronBridge';
import { getElectronFolder } from '../gitfs';
import type { RemoteTransport } from './gitObjectTransport';

export async function createElectronRemoteTransport(): Promise<RemoteTransport> {
  const base = await getElectronFolder();
  if (!base) throw new Error('No sync folder chosen yet — call chooseElectronSyncFolder() first.');
  const resolve = (relativePath: string) => `${base}/${relativePath}`;

  return {
    async exists(relativePath) {
      try {
        await electronFs().stat(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(relativePath) {
      const data = await electronFs().readFile(resolve(relativePath));
      return data as Uint8Array; // no encoding arg -> IPC handler returns a Uint8Array, never a string
    },
    async writeFile(relativePath, data) {
      await electronFs().writeFile(resolve(relativePath), data);
    },
    async listDir(relativePath) {
      try {
        return await electronFs().readdir(resolve(relativePath));
      } catch {
        return [];
      }
    },
  };
}
