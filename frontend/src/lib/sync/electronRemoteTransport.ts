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
// Resolves against getSyncBasePath() — the same chosen-folder+/SmartChef
// path the old design already used as its git working-tree dir. Reusing
// it here is deliberate: it's the same physical location the user already
// picked (chooseElectronSyncFolder()), just reinterpreted as a bare-style
// remote (objects/refs only) instead of a live working tree.
// ════════════════════════════════════════════════════════════════════════

import { electronFs } from '../electronBridge';
import { getSyncBasePath } from '../gitfs';
import type { RemoteTransport } from './gitObjectTransport';

export async function createElectronRemoteTransport(): Promise<RemoteTransport> {
  const base = await getSyncBasePath();
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
