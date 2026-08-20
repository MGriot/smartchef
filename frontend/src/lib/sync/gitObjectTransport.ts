// ════════════════════════════════════════════════════════════════════════
// SmartChef — Object/ref transport to the Sync Folder (wayfinder ticket 01,
// ADR 0001 — standalone-storage-sync map)
//
// isomorphic-git's fetch()/push() only speak http(s) — confirmed by ticket
// 01's research against the installed version's source (GitRemoteManager
// only registers http/https remote helpers; anything else throws
// UnknownTransportError). Reaching the Sync Folder — a plain folder,
// treated as a bare-style git remote — needs the same hand-rolled object/
// ref copy the superseded androidMirror.ts already proved out for the old
// design: objects first (content-addressed and immutable, so an existing
// name never needs re-checking), then the ref/HEAD, so a partial failure
// never leaves the remote pointing at objects that didn't fully arrive.
//
// Deliberately platform-agnostic and decoupled from persistence, same
// philosophy as structuredMerge.ts: this only moves bytes between a local
// git dir and a RemoteTransport — it has no idea whether that transport is
// Electron's direct filesystem or a future SafMirror-backed one, and it
// keeps no state of its own between calls. Unlike androidMirror.ts's
// pushToTarget() (which skips re-checking an object via a persisted
// knownPushedObjects cache, specifically because a SAF round-trip per
// object was too costly to do unconditionally), pushObjectsAndRefs() below
// always calls remote.exists() per object — correct everywhere, but a real
// cost on a transport where existence checks are expensive. A future
// SafMirror-backed RemoteTransport MUST recreate that caching itself (e.g.
// wrapping exists() with a persisted "known to exist" set, same shape as
// androidMirror.ts's) — Electron's direct-fs transport, by contrast, can
// likely get away with the unconditional check, since a local stat() is cheap.
//
// Does NOT touch the working tree — checking out files from the objects
// this pulls in is a separate, purely local step (isomorphic-git's own
// checkout(), which needs no network) left to the caller. This module only
// gets bytes from one place to the other.
// ════════════════════════════════════════════════════════════════════════

export interface RemoteTransport {
  exists(relativePath: string): Promise<boolean>;
  readFile(relativePath: string): Promise<Uint8Array>;
  writeFile(relativePath: string, data: Uint8Array): Promise<void>;
  /** Names of entries directly under this directory — empty array if the
   *  directory doesn't exist. Not an error: a fresh remote with no history
   *  yet is the normal case a Sync Folder starts in, not a failure. */
  listDir(relativePath: string): Promise<string[]>;
}

/** The subset of gitfs.promises (and testUtils/fakes.ts's FakeLocalFs) this
 *  module needs — structurally compatible with both, so callers pass the
 *  real gitfs.promises in production and createFakeLocalFs().promises in
 *  tests without either side needing to import the other. */
export interface LocalFs {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<unknown>;
}

/** The canonical ref name both sides agree on — read from this path in the
 *  local Hidden Clone on push, written to this same path on the remote. */
const REF_PATH = '.git/refs/heads/main';
const HEAD_PATH = '.git/HEAD';

/** Where pullObjectsAndRefs() writes the Sync Folder's ref locally, by
 *  default — a remote-tracking ref, NOT refs/heads/main. Overwriting the
 *  local branch directly (what the superseded androidMirror.ts did, and
 *  what an earlier version of this module also did) is fine under a
 *  file-level-reconcile design where the ref is just for SyncHistory.tsx's
 *  display, but it would be actively wrong here: Structured Merge needs
 *  local HEAD to keep pointing at this device's own last commit so it can
 *  compute a real merge-base against the fetched remote history. Clobber
 *  it and the "local" side of every 3-way merge silently becomes "remote",
 *  turning every merge into a no-op fast-forward. */
export const DEFAULT_REMOTE_TRACKING_REF_PATH = '.git/refs/remotes/sync-folder/main';

/** The same ref, in the form isomorphic-git's own ref-name-taking calls
 *  (resolveRef, findMergeBase's callers, etc.) expect — relative to
 *  gitdir, no leading `.git/`. Exported alongside the file-path form so a
 *  caller resolving this ref never has to hand-derive one from the other
 *  and risk the two drifting apart. */
export const DEFAULT_REMOTE_TRACKING_REF_NAME = 'refs/remotes/sync-folder/main';

async function existsLocally(fs: LocalFs, dir: string, relativePath: string): Promise<boolean> {
  try {
    await fs.stat(`${dir}/${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

async function readLocalBytes(fs: LocalFs, dir: string, relativePath: string): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(`${dir}/${relativePath}`);
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  } catch {
    return null; // not there locally — caller-tolerable no-op, not an error
  }
}

/** .git/objects/<prefix>/<rest> — the two-level structure isomorphic-git
 *  itself uses for loose objects. Filtering to 2-hex-char prefix names
 *  skips "info"/"pack" (packed/alternates bookkeeping git also creates
 *  directly under objects/) — standalone mode's commit/add only ever
 *  produces loose objects, so there's nothing to pack here anyway.
 *  Exported so androidMirror.ts's own (otherwise identical) copy could be
 *  replaced by this one rather than the two drifting independently. */
export async function listLocalObjectPaths(fs: LocalFs, dir: string): Promise<string[]> {
  let prefixes: string[];
  try {
    prefixes = await fs.readdir(`${dir}/.git/objects`);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const prefix of prefixes) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    let names: string[];
    try {
      names = await fs.readdir(`${dir}/.git/objects/${prefix}`);
    } catch {
      continue;
    }
    for (const name of names) paths.push(`.git/objects/${prefix}/${name}`);
  }
  return paths;
}

export interface PushResult {
  /** false when there was no local ref to push yet (Hidden Clone has no
   *  commits) — not an error. */
  pushed: boolean;
  objectsUploaded: number;
  uploadedObjectPaths: string[];
}

/** Uploads this device's Hidden Clone up to the Sync Folder — objects
 *  first, then the ref/HEAD. A failure partway through the objects loop
 *  (a real transport failure, not "nothing to upload") is deliberately NOT
 *  caught here — it must propagate so refs never get written after a
 *  partial object upload, leaving the remote exactly as consistent as
 *  before this call for a puller to see. */
export async function pushObjectsAndRefs(fs: LocalFs, localDir: string, remote: RemoteTransport): Promise<PushResult> {
  const localObjectPaths = await listLocalObjectPaths(fs, localDir);
  const uploadedObjectPaths: string[] = [];

  for (const relativePath of localObjectPaths) {
    if (await remote.exists(relativePath)) continue; // immutable, content-addressed — already there is already done
    const bytes = await readLocalBytes(fs, localDir, relativePath);
    if (!bytes) continue; // listed a moment ago but gone now — tolerate the race, nothing to upload
    await remote.writeFile(relativePath, bytes);
    uploadedObjectPaths.push(relativePath);
  }

  const refBytes = await readLocalBytes(fs, localDir, REF_PATH);
  if (!refBytes) {
    return { pushed: false, objectsUploaded: uploadedObjectPaths.length, uploadedObjectPaths };
  }
  await remote.writeFile(REF_PATH, refBytes);
  const headBytes = await readLocalBytes(fs, localDir, HEAD_PATH);
  if (headBytes) await remote.writeFile(HEAD_PATH, headBytes);

  return { pushed: true, objectsUploaded: uploadedObjectPaths.length, uploadedObjectPaths };
}

export interface PullResult {
  /** false when the Sync Folder has no history yet — not an error. */
  pulled: boolean;
  objectsFetched: number;
  fetchedObjectPaths: string[];
}

/** Fetches objects and the ref from the Sync Folder into this device's
 *  Hidden Clone — objects first, matching pushObjectsAndRefs()'s ordering
 *  for the same reason (a ref must never point at an object set that
 *  didn't fully arrive).
 *
 *  Writes the fetched ref to `trackingRefPath` (default
 *  DEFAULT_REMOTE_TRACKING_REF_PATH), NOT to refs/heads/main — local HEAD
 *  keeps pointing at this device's own last commit throughout, exactly
 *  like a real `git fetch` (as opposed to `git pull`, which fetches *and*
 *  merges/fast-forwards). Merging the tracking ref into local history —
 *  fast-forwarding when there's nothing to reconcile, running Structured
 *  Merge when there is — is the caller's job. Does not touch the working
 *  tree either way; the caller runs an actual checkout (a local-only
 *  isomorphic-git operation) afterward if it wants any of this reflected
 *  in checked-out files. */
export async function pullObjectsAndRefs(
  fs: LocalFs,
  localDir: string,
  remote: RemoteTransport,
  trackingRefPath: string = DEFAULT_REMOTE_TRACKING_REF_PATH
): Promise<PullResult> {
  if (!(await remote.exists(REF_PATH))) {
    return { pulled: false, objectsFetched: 0, fetchedObjectPaths: [] };
  }

  const fetchedObjectPaths: string[] = [];
  const prefixes = await remote.listDir('.git/objects');
  for (const prefix of prefixes) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const names = await remote.listDir(`.git/objects/${prefix}`);
    for (const name of names) {
      const relativePath = `.git/objects/${prefix}/${name}`;
      if (await existsLocally(fs, localDir, relativePath)) continue;
      const bytes = await remote.readFile(relativePath);
      await fs.writeFile(`${localDir}/${relativePath}`, bytes);
      fetchedObjectPaths.push(relativePath);
    }
  }

  const refBytes = await remote.readFile(REF_PATH);
  await fs.writeFile(`${localDir}/${trackingRefPath}`, refBytes);

  return { pulled: true, objectsFetched: fetchedObjectPaths.length, fetchedObjectPaths };
}
