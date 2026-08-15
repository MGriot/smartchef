// ════════════════════════════════════════════════════════════════════════
// SmartChef — Android SAF mirror (standalone mode)
// The layer between gitSync.ts's private-storage working copy and a
// SAF-picked external target (Drive/OneDrive/local folder) — see
// docs/plans/2026-08-15-android-folder-sync-parity-design.md. Electron
// needs none of this: it points isomorphic-git straight at the chosen
// folder. Android's SAF tree URIs give no direct filesystem path, so this
// module does the mirroring explicitly, in two batched passes per sync
// cycle rather than wiring isomorphic-git to SAF itself (see the design
// doc's Approach comparison for why).
//
// Mirror semantics (design doc's Data Model table):
//   .git/objects/**              content-addressed & immutable — a name
//                                 already known to exist doesn't need
//                                 re-checking, on push OR pull.
//   .git/refs/heads/main, HEAD   tiny, always re-fetched/re-pushed.
//   recipes/*.json, ingredients/*.json, devices/<own-id>.json
//                                 always overwritten if different — the
//                                 real application payload.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { SafMirror, type SafMirrorPlugin } from '../safMirrorBridge';
import { gitfs, getSyncBasePath, base64ToBytes, bytesToBase64 } from '../gitfs';
import { getDeviceId } from './gitSync';

const STATE_KEY = 'smartchef.sync.androidMirrorState';

export interface AndroidMirrorState {
  treeUri: string;
  treeDisplayName: string;
  /** Object filenames (".git/objects/xx/yyyy...") known to exist both
   *  locally and on the target — updated by both push (after a successful
   *  upload) and pull (after a successful fetch), so neither direction
   *  redoes work the other already confirmed. Despite the name, it's not
   *  push-only; renaming would just be more chances for the two write
   *  sites to drift out of sync with the field name. */
  knownPushedObjects: string[];
  lastSeenRemoteRef: string | null;
}

let cachedState: AndroidMirrorState | null | undefined; // undefined = not loaded yet

export async function getMirrorState(): Promise<AndroidMirrorState | null> {
  if (cachedState !== undefined) return cachedState;
  const { value } = await Preferences.get({ key: STATE_KEY });
  cachedState = value ? (JSON.parse(value) as AndroidMirrorState) : null;
  return cachedState;
}

async function setMirrorState(state: AndroidMirrorState): Promise<void> {
  cachedState = state;
  await Preferences.set({ key: STATE_KEY, value: JSON.stringify(state) });
}

/** Called once a SAF tree has been picked (from onboarding, or Account's
 *  "Change Folder"). Resets knownPushedObjects/lastSeenRemoteRef only if
 *  the tree actually changed — picking the same tree again (e.g. after
 *  losing and re-granting permission) shouldn't throw away a cache that's
 *  still valid. */
export async function setMirrorTree(treeUri: string, treeDisplayName: string): Promise<void> {
  const existing = await getMirrorState();
  const samesTree = existing?.treeUri === treeUri;
  await setMirrorState({
    treeUri,
    treeDisplayName,
    knownPushedObjects: samesTree ? existing.knownPushedObjects : [],
    lastSeenRemoteRef: samesTree ? existing.lastSeenRemoteRef : null,
  });
}

/** Called once per object immediately after a successful upload/fetch —
 *  not batched at the end of a push/pull pass — so a partway failure still
 *  remembers whichever objects made it through before the failure, rather
 *  than forgetting all of them and re-transferring objects that already
 *  succeeded on the next retry. */
async function rememberSyncedObject(relativePath: string): Promise<void> {
  const state = await getMirrorState();
  if (!state) return;
  if (state.knownPushedObjects.includes(relativePath)) return;
  await setMirrorState({ ...state, knownPushedObjects: [...state.knownPushedObjects, relativePath] });
}

// ── local existence (source of truth for pull-skip decisions — cheap,
// always correct, unlike trusting a cache that could be stale after a
// reinstall or a cleared app) ───────────────────────────────────────────

async function existsLocally(dir: string, relativePath: string): Promise<boolean> {
  try {
    await gitfs.promises.stat(`${dir}/${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

async function fetchAndWrite(plugin: SafMirrorPlugin, treeUri: string, dir: string, relativePath: string): Promise<void> {
  const { data } = await plugin.readFile({ uri: treeUri, path: relativePath });
  await gitfs.promises.writeFile(`${dir}/${relativePath}`, base64ToBytes(data));
}

function parseUpdatedAt(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { updated_at?: unknown };
    return typeof parsed.updated_at === 'string' ? parsed.updated_at : null;
  } catch {
    return null;
  }
}

async function readLocalBytesOrNull(dir: string, relativePath: string): Promise<Uint8Array | null> {
  try {
    const data = await gitfs.promises.readFile(`${dir}/${relativePath}`);
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  } catch {
    return null;
  }
}

/** Pulls every JSON file under a target directory. `compareUpdatedAt`
 *  controls how "overwrite if different" is actually decided:
 *
 *  - true (recipes/ingredients): a local file this device wrote but
 *    hasn't pushed yet must not be clobbered by an older remote copy —
 *    that would silently discard the local edit from the file (and so
 *    from the shared history), even though reconcileEntity()'s own
 *    updated_at check would still protect SQLite for THIS device. A third
 *    device pulling later would only ever see the older remote content,
 *    with no record the newer edit ever existed. So this compares
 *    updated_at fields and skips the overwrite when the local copy is the
 *    same age or newer, exactly mirroring reconcileEntity()'s own
 *    comparison one layer up.
 *  - false (devices/<id>.json): no comparison needed — each device only
 *    ever writes its own file, so there's no conflict to protect against;
 *    whatever's remote is authoritative for every *other* device's file.
 *
 *  Tolerates the target directory not existing yet (e.g. no devices/
 *  written by anyone so far). */
async function pullJsonDirectory(
  plugin: SafMirrorPlugin,
  treeUri: string,
  dir: string,
  relativeDir: string,
  compareUpdatedAt: boolean
): Promise<void> {
  let entries;
  try {
    ({ entries } = await plugin.list({ uri: treeUri, path: relativeDir }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relativePath = `${relativeDir}/${entry.name}`;

    if (compareUpdatedAt) {
      const { data } = await plugin.readFile({ uri: treeUri, path: relativePath });
      const remoteBytes = base64ToBytes(data);
      const localBytes = await readLocalBytesOrNull(dir, relativePath);
      const remoteUpdatedAt = parseUpdatedAt(remoteBytes);
      const localUpdatedAt = localBytes && parseUpdatedAt(localBytes);
      if (localUpdatedAt && remoteUpdatedAt && remoteUpdatedAt <= localUpdatedAt) {
        continue; // local copy is the same age or newer — ours wins, don't overwrite an unpushed edit
      }
      await gitfs.promises.writeFile(`${dir}/${relativePath}`, remoteBytes);
    } else {
      await fetchAndWrite(plugin, treeUri, dir, relativePath);
    }
  }
}

export interface PullResult {
  /** false when there was nothing to pull yet (no tree configured, or the
   *  target has no history yet) — not an error either way. */
  pulled: boolean;
  objectsFetched: number;
}

/** Reconciles the private working copy with whatever's currently on the
 *  SAF target — objects first (see the design doc's push-ordering
 *  rationale; the same ordering matters on pull too, so a
 *  partway-interrupted pull never leaves refs pointing at objects that
 *  didn't make it down), then refs/HEAD, then the JSON payload. Must run
 *  before gitSync.ts's initSyncRepo() git.init check (task 8) so a device
 *  joining an already-populated target inherits real history instead of
 *  starting a disconnected one — that ordering isn't enforced here, it's
 *  the caller's responsibility. */
export async function pullFromTarget(plugin: SafMirrorPlugin = SafMirror): Promise<PullResult> {
  const state = await getMirrorState();
  if (!state) return { pulled: false, objectsFetched: 0 };

  const dir = await getSyncBasePath();

  let remoteRefData: string;
  try {
    ({ data: remoteRefData } = await plugin.readFile({ uri: state.treeUri, path: '.git/refs/heads/main' }));
  } catch {
    return { pulled: false, objectsFetched: 0 }; // target has no history yet
  }

  const fetchedObjectNames: string[] = [];
  const prefixListing = await plugin.list({ uri: state.treeUri, path: '.git/objects' }).catch(() => ({ entries: [] }));
  for (const prefixDir of prefixListing.entries) {
    if (!prefixDir.isDirectory) continue;
    const objectListing = await plugin
      .list({ uri: state.treeUri, path: `.git/objects/${prefixDir.name}` })
      .catch(() => ({ entries: [] }));
    for (const objectFile of objectListing.entries) {
      const relativePath = `.git/objects/${prefixDir.name}/${objectFile.name}`;
      if (await existsLocally(dir, relativePath)) continue;
      await fetchAndWrite(plugin, state.treeUri, dir, relativePath);
      fetchedObjectNames.push(relativePath);
      await rememberSyncedObject(relativePath);
    }
  }

  await gitfs.promises.writeFile(`${dir}/.git/refs/heads/main`, base64ToBytes(remoteRefData));
  await fetchAndWrite(plugin, state.treeUri, dir, '.git/HEAD').catch(() => {});

  await pullJsonDirectory(plugin, state.treeUri, dir, 'recipes', true);
  await pullJsonDirectory(plugin, state.treeUri, dir, 'ingredients', true);
  await pullJsonDirectory(plugin, state.treeUri, dir, 'devices', false);

  await setMirrorState({ ...(await getMirrorState())!, lastSeenRemoteRef: remoteRefData });

  return { pulled: true, objectsFetched: fetchedObjectNames.length };
}

// ── push ──────────────────────────────────────────────────────────────

async function readLocalBytes(dir: string, relativePath: string): Promise<Uint8Array | null> {
  try {
    const data = await gitfs.promises.readFile(`${dir}/${relativePath}`);
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  } catch {
    return null; // not there locally — a caller-tolerable no-op, not an error
  }
}

/** Uploads one local file if it exists. Deliberately does NOT catch a
 *  failure from plugin.writeFile itself (SAF permission lost, target
 *  unreachable, etc.) — that must propagate all the way out of
 *  pushToTarget() so a failure partway through the objects loop stops
 *  before refs/HEAD ever get pushed (see the design doc's push-ordering
 *  rationale, and the "partial push" test below). */
async function pushFile(plugin: SafMirrorPlugin, treeUri: string, dir: string, relativePath: string): Promise<boolean> {
  const bytes = await readLocalBytes(dir, relativePath);
  if (!bytes) return false;
  await plugin.writeFile({ uri: treeUri, path: relativePath, data: bytesToBase64(bytes) });
  return true;
}

async function pushJsonDirectory(plugin: SafMirrorPlugin, treeUri: string, dir: string, relativeDir: string): Promise<void> {
  let names: string[];
  try {
    names = await gitfs.promises.readdir(`${dir}/${relativeDir}`);
  } catch {
    return; // nothing local under this directory yet
  }
  for (const name of names) {
    await pushFile(plugin, treeUri, dir, `${relativeDir}/${name}`);
  }
}

/** .git/objects/<prefix>/<rest> — the two-level structure isomorphic-git
 *  itself uses for loose objects. "info" and "pack" are the only other
 *  entries git ever creates directly under objects/ (packed/alternates
 *  bookkeeping, not loose objects); filtering to 2-hex-char names is
 *  simpler than special-casing those two by name and correct either way,
 *  since standalone mode never packs — isomorphic-git's commit/add here
 *  only ever produces loose objects. */
async function listLocalObjectPaths(dir: string): Promise<string[]> {
  let prefixes: string[];
  try {
    prefixes = await gitfs.promises.readdir(`${dir}/.git/objects`);
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const prefix of prefixes) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    let names: string[];
    try {
      names = await gitfs.promises.readdir(`${dir}/.git/objects/${prefix}`);
    } catch {
      continue;
    }
    for (const name of names) paths.push(`.git/objects/${prefix}/${name}`);
  }
  return paths;
}

export interface PushResult {
  pushed: boolean;
  objectsUploaded: number;
}

/** Mirrors the private working copy up to the SAF target — objects first,
 *  then refs/HEAD, then the JSON payload (recipes/ingredients/this
 *  device's own registry file), matching pullFromTarget()'s ordering for
 *  the same reason: if this throws partway through the objects loop
 *  (a real SAF failure, not a "file doesn't exist locally" no-op), refs
 *  never get pushed, so the target stays exactly as consistent as it was
 *  before this call — a puller sees "nothing new," never a ref pointing
 *  at objects that didn't fully arrive. */
export async function pushToTarget(plugin: SafMirrorPlugin = SafMirror): Promise<PushResult> {
  const state = await getMirrorState();
  if (!state) return { pushed: false, objectsUploaded: 0 };

  const dir = await getSyncBasePath();
  const known = new Set(state.knownPushedObjects);

  const localObjectPaths = await listLocalObjectPaths(dir);
  let objectsUploaded = 0;
  for (const relativePath of localObjectPaths) {
    if (known.has(relativePath)) continue;
    if (await pushFile(plugin, state.treeUri, dir, relativePath)) {
      objectsUploaded++;
      await rememberSyncedObject(relativePath);
    }
  }

  await pushFile(plugin, state.treeUri, dir, '.git/refs/heads/main');
  await pushFile(plugin, state.treeUri, dir, '.git/HEAD');

  await pushJsonDirectory(plugin, state.treeUri, dir, 'recipes');
  await pushJsonDirectory(plugin, state.treeUri, dir, 'ingredients');

  const deviceId = await getDeviceId();
  await pushFile(plugin, state.treeUri, dir, `devices/${deviceId}.json`);

  return { pushed: true, objectsUploaded };
}
