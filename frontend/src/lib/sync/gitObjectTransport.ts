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

const REF_PATH = '.git/refs/heads/main';
const HEAD_PATH = '.git/HEAD';

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
 *  for the same reason (a local ref must never point at an object set that
 *  didn't fully arrive). Does not touch the working tree — the caller runs
 *  an actual checkout (a local-only isomorphic-git operation) afterward if
 *  it wants the fetched history reflected in checked-out files. */
export async function pullObjectsAndRefs(fs: LocalFs, localDir: string, remote: RemoteTransport): Promise<PullResult> {
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
  await fs.writeFile(`${localDir}/${REF_PATH}`, refBytes);
  try {
    const headBytes = await remote.readFile(HEAD_PATH);
    await fs.writeFile(`${localDir}/${HEAD_PATH}`, headBytes);
  } catch {
    // HEAD is a nice-to-have mirror of refs/heads/main — its absence on
    // the remote isn't fatal, refs/heads/main is what actually matters.
  }

  return { pulled: true, objectsFetched: fetchedObjectPaths.length, fetchedObjectPaths };
}
