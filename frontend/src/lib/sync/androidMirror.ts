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
import { gitfs, getSyncBasePath, base64ToBytes } from '../gitfs';

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

async function rememberSyncedObjects(names: string[]): Promise<void> {
  if (!names.length) return;
  const state = await getMirrorState();
  if (!state) return;
  const merged = new Set(state.knownPushedObjects);
  for (const name of names) merged.add(name);
  await setMirrorState({ ...state, knownPushedObjects: [...merged] });
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

/** Pulls every JSON file under a target directory unconditionally — these
 *  are few and small, so a content-hash-based skip isn't worth the
 *  complexity; reconcileEntity() in gitSync.ts already no-ops on rows
 *  whose updated_at isn't newer, so an unchanged file being re-fetched and
 *  re-written costs a little I/O, not correctness. Tolerates the target
 *  directory not existing yet (e.g. no devices/ written by anyone so far). */
async function pullJsonDirectory(plugin: SafMirrorPlugin, treeUri: string, dir: string, relativeDir: string): Promise<void> {
  let entries;
  try {
    ({ entries } = await plugin.list({ uri: treeUri, path: relativeDir }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    await fetchAndWrite(plugin, treeUri, dir, `${relativeDir}/${entry.name}`);
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
    }
  }
  await rememberSyncedObjects(fetchedObjectNames);

  await gitfs.promises.writeFile(`${dir}/.git/refs/heads/main`, base64ToBytes(remoteRefData));
  await fetchAndWrite(plugin, state.treeUri, dir, '.git/HEAD').catch(() => {});

  await pullJsonDirectory(plugin, state.treeUri, dir, 'recipes');
  await pullJsonDirectory(plugin, state.treeUri, dir, 'ingredients');
  await pullJsonDirectory(plugin, state.treeUri, dir, 'devices');

  await setMirrorState({ ...(await getMirrorState())!, lastSeenRemoteRef: remoteRefData });

  return { pulled: true, objectsFetched: fetchedObjectNames.length };
}
