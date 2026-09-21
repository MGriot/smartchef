// ════════════════════════════════════════════════════════════════════════
// SmartChef — Hidden Clone lifecycle (wayfinder ticket 03 remainder,
// standalone-storage-sync map)
//
// Each device's own private git working copy — where the Sync Engine
// actually runs commits and (eventually) merges — distinct from both Local
// Storage (the live SQLite db + images every screen reads/writes) and the
// Sync Folder (a separate, Syncthing-replicated location holding only
// objects/refs — see gitObjectTransport.ts). Created lazily: this module
// is only ever called once a Sync Folder has been configured, never
// eagerly at profile creation.
//
// Reuses gitfs.ts's PromiseFsClient as-is — it already resolves an
// arbitrary path against Electron's IPC-backed fs or Android's
// Directory.Data-relative Filesystem calls, so pointing it at a different
// base directory (sync-clone instead of the old getSyncBasePath()) needs
// no new fs adapter, just a different `dir`.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { isElectron, getHiddenCloneDir as getElectronHiddenCloneDir } from '../electronBridge';

const ANDROID_HIDDEN_CLONE_DIR = '/sync-clone';

/** Hidden Clone's base directory — Electron: userData/sync-clone (IPC,
 *  electronBridge.ts); Android: a fixed Directory.Data-relative subfolder,
 *  distinct from Local Storage's own path and from the old design's
 *  getSyncBasePath() (gitfs.ts's `/SmartChef`). */
export async function getHiddenCloneDir(): Promise<string> {
  if (isElectron()) return getElectronHiddenCloneDir();
  return ANDROID_HIDDEN_CLONE_DIR;
}

export interface HiddenCloneDirs {
  dir: string;
  gitdir: string;
}

let initDone = false;

/** Idempotent within a session (the initDone guard) — safe to call before
 *  every operation that touches the Hidden Clone, same pattern as the old
 *  design's gitSync.ts initSyncRepo(). Unlike that function, this never
 *  pulls from anywhere first: the Hidden Clone always starts as its own
 *  fresh, disconnected repo regardless of what the Sync Folder holds —
 *  reconciling with remote history is a separate, later merge step
 *  (adopting a populated remote's history at init time only made sense
 *  under the old "the folder IS the git dir" model; here the Sync Folder
 *  is a distinct bare-style remote reached by explicit fetch, not init-time
 *  adoption). */
export async function ensureHiddenCloneInitialized(): Promise<HiddenCloneDirs> {
  const dir = await getHiddenCloneDir();
  const gitdir = `${dir}/.git`;
  if (initDone) return { dir, gitdir };

  let hasGit = true;
  try {
    await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    await git.init({ fs: gitfs, dir, gitdir, defaultBranch: 'main' });
  }
  // Idempotent either way (mkdir tolerates "already exists" on both
  // platforms' gitfs.ts backends) — cheap enough to run every call rather
  // than gating it behind the hasGit check above. Kept in sync by hand with
  // gitSync.ts's ALL_ENTITY_DIRS (importing it here would be circular,
  // since gitSync.ts is what imports this module) — every synced entity
  // type needs its directory pre-created here too.
  // `images` is not an entity directory — it is the content-addressed image
  // store gitSync.ts's COMMITTED_DIRS also stages, so that a recipe's cover
  // travels with the recipe (ADR 0003). Created here for the same reason as
  // the rest: git.add() on a path that does not exist is an error, and this
  // is the one place that guarantees the layout.
  for (const entityDir of ['recipes', 'ingredients', 'tools', 'tags', 'techniques', 'profiles', 'categories', 'units', 'settings', 'images']) {
    await gitfs.promises.mkdir(`${dir}/${entityDir}`);
  }
  initDone = true;
  return { dir, gitdir };
}

/** Call after anything that could invalidate the initDone guard's premise
 *  — currently nothing in this module does that itself (Electron's
 *  Hidden Clone location never changes at runtime, unlike the old design's
 *  user-chosen sync folder), but exported for the same reason gitSync.ts's
 *  resetSyncRepoInit() is: a future "Reset Sync" recovery action needs to
 *  force a fresh resolveRef check after wiping the directory. */
export function resetHiddenCloneInitFlag(): void {
  initDone = false;
}
