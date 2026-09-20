// ════════════════════════════════════════════════════════════════════════
// SmartChef — Git-based folder sync (standalone mode)
//
// Rewritten internals for the standalone-storage-sync wayfinder map's
// architecture (ADR 0001/0002, tickets 01-04): each device commits its own
// changes into a private Hidden Clone (hiddenClone.ts), reaches the Sync
// Folder via hand-rolled object/ref transport (gitObjectTransport.ts,
// since isomorphic-git can't fetch/push against a folder-only remote),
// and reconciles genuine divergence via Structured Merge (mergeBridge.ts
// + structuredMerge.ts) instead of last-write-wins-by-updated_at. The
// public API below is unchanged from the superseded design on purpose —
// every existing caller (recipes.local.ts/ingredients.local.ts's
// writeEntityFile() calls, Account.tsx, SyncHistory.tsx, App.tsx's
// watcher) keeps working with no changes of its own; only what happens
// inside changed.
//
// Covers recipes, ingredients, tools, tags, and techniques — every entity
// type standalone mode has local CRUD for. Each gets its own top-level
// directory in the Hidden Clone (see ENTITY_TYPE_TO_DIR below); adding a
// new synced entity type means adding one entry there, one to
// mergeBridge.ts's ENTITY_DIRS, one to hiddenClone.ts's directory list,
// and one to commitNowInternal()'s statusMatrix/add filepaths — all four
// need to agree, or a change lands in the Hidden Clone but silently never
// gets committed, pushed, or merged.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../../i18n';
import * as git from 'isomorphic-git';
import { Preferences } from '@capacitor/preferences';
import { gitfs } from '../gitfs';
import { gitCache, resetGitCache } from './gitCache';
import { isElectron } from '../electronBridge';
import { ensureHiddenCloneInitialized, resetHiddenCloneInitFlag } from './hiddenClone';
import { pushObjectsAndRefs, pullObjectsAndRefs, DEFAULT_REMOTE_TRACKING_REF_NAME, type RemoteTransport, type TransferProgress } from './gitObjectTransport';
import { writeBundleIfStale, tryCatchUpFromBundle } from './gitBundleTransport';
import { packLooseObjectsAfterPush } from './gitPacking';
import { fetchGitRemote, pushGitRemote } from './gitRemoteTransport';
import {
  getSyncMode,
  getGitRemoteConfig,
  getSyncIntervalMinutes,
  getConflictPolicy,
  setGitRemoteAccessProblem,
  type GitRemoteConfig,
} from './syncSettings';
import { createElectronRemoteTransport } from './electronRemoteTransport';
import { createAndroidRemoteTransport } from './androidRemoteTransport';
import { getMirrorState, setSyncPauseReason } from './androidMirror';
import { mergeRemoteIntoLocal, readRemoteSnapshot, applyRemoteSnapshot, type ReplaceOutcome } from './mergeBridge';
import { overlayPendingConflicts, autoResolvePendingConflicts, listLocalEntityIds } from '../../services/conflicts.local';
import { recordSynced, queueRepair, markAllInSync, publishRowsAheadOfRepo, pullRepoIntoDatabase, repairUnknownUnitRefs, repairCategories, type PullOutcome } from '../../services/syncReconcile.local';
import { reportSyncStarted, reportSyncFinished, LAST_SYNC_KEY } from './syncStatus';
import { copyImagesIntoClone, materializeImagesFromCommit } from './imageSync';
import { IMAGES_SUBDIR } from '../localImages';

const DEVICE_ID_KEY = 'smartchef.sync.deviceId';
const DEVICE_NAME_KEY = 'smartchef.sync.deviceName';


// Same reasoning as the superseded design: writeEntityFile() fires once
// per row during a bulk import, each independently touching the Hidden
// Clone, while startFolderSyncWatcher()'s periodic tick (or a user
// clicking "Sync Now" mid-import) can call syncNow() concurrently against
// the same dir/gitdir. Serializing every entry point through one shared
// queue — same promise-chain-mutex pattern db/local.ts uses for the same
// reason — is what actually prevents two callers racing through git
// operations at once.
let gitQueue: Promise<unknown> = Promise.resolve();

/** Slow-path timing, printed only when something actually took a while, so
 *  a normal session stays quiet. Added while chasing "saving a recipe takes
 *  a long time": because everything below shares ONE queue, a save's own
 *  work can be fast while the save still blocks for seconds behind an
 *  unrelated commit or a full sync cycle already in flight. Separating
 *  "waited for the queue" from "did my own work" is the only way to tell
 *  those two apart from the outside. */
const SLOW_MS = 400;
export function logIfSlow(label: string, startedAt: number, extra = ''): void {
  const ms = Math.round(performance.now() - startedAt);
  if (ms >= SLOW_MS) console.info(`[smartchef/perf] ${label}: ${ms}ms${extra ? ' ' + extra : ''}`);
}

function serialize<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  const queuedAt = performance.now();
  const next = gitQueue.then(run, run);
  gitQueue = next.catch(() => {});
  return next;

  function run(): Promise<T> {
    if (label) logIfSlow(`${label} waited for git queue`, queuedAt);
    const startedAt = performance.now();
    return fn().finally(() => label && logIfSlow(`${label} own work`, startedAt));
  }
}

type EntityType = 'recipes' | 'ingredients' | 'tools' | 'tags' | 'techniques' | 'profiles' | 'categories' | 'units';
const ENTITY_TYPE_TO_DIR: Record<string, EntityType> = {
  recipe: 'recipes',
  ingredient: 'ingredients',
  tool: 'tools',
  tag: 'tags',
  technique: 'techniques',
  profile: 'profiles',
  category: 'categories',
  unit: 'units',
};
const DIR_TO_ENTITY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_TYPE_TO_DIR).map(([entityType, dirName]) => [dirName, entityType])
);
const ALL_ENTITY_DIRS: EntityType[] = ['recipes', 'ingredients', 'tools', 'tags', 'techniques', 'profiles', 'categories', 'units'];

// What git actually stages and commits: every entity directory, plus the
// content-addressed image store. `images` is deliberately NOT an
// EntityType and deliberately absent from mergeBridge.ts's ENTITY_DIRS —
// those hold JSON records that can diverge and need Structured Merge, while
// an image path encodes its own content and therefore can never conflict.
// It only needs to be committed and replicated. See lib/sync/imageSync.ts.
const COMMITTED_DIRS: string[] = [...ALL_ENTITY_DIRS, IMAGES_SUBDIR];

let deviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) {
    deviceId = value;
    return value;
  }
  const id = `device-${crypto.randomUUID().slice(0, 8)}`;
  await Preferences.set({ key: DEVICE_ID_KEY, value: id });
  deviceId = id;
  return id;
}

/** Human-friendly name for this device's devices/<id>.json — a user-set
 *  override always wins; otherwise falls back to @capacitor/device's
 *  reported model name; otherwise the anonymous device-xxxxxxxx id
 *  itself. Loaded dynamically rather than imported at module scope so
 *  none of the existing sync tests (none of which mock @capacitor/device)
 *  need to change: the web implementation throws without a real
 *  navigator.userAgent (true in Vitest's node environment, never true in
 *  an actual browser/WebView), and that failure is just another case of
 *  "fall back to the device id," not a bug to route around. */
export async function getDeviceName(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_NAME_KEY });
  if (value) return value;
  try {
    const { Device } = await import('@capacitor/device');
    const { model } = await Device.getInfo();
    if (model) return model;
  } catch {
    // No usable Device API in this environment — fall through to the id.
  }
  return getDeviceId();
}

export async function setDeviceName(name: string): Promise<void> {
  await Preferences.set({ key: DEVICE_NAME_KEY, value: name });
}

/** Kept for API compatibility with existing callers (Account.tsx's
 *  "Change Folder" button) — the original reason this existed
 *  (Electron's git dir *was* the user-chosen folder, so switching folders
 *  invalidated the initDone cache) no longer applies: the Hidden Clone's
 *  location never changes when the user picks a different Sync Folder.
 *  Still harmless to call. */
export function resetSyncRepoInit(): void {
  resetHiddenCloneInitFlag();
}

export async function initSyncRepo(): Promise<void> {
  await ensureHiddenCloneInitialized();
}

function author() {
  return { name: 'SmartChef', email: 'sync@smartchef.local' };
}

/** Serializes one row's current state to its own file in the Hidden Clone
 *  — called right after every local create/update/delete in
 *  recipes.local.ts/ingredients.local.ts. One file per row (not per entity
 *  type) so a git diff on a single recipe is meaningful and two recipes
 *  edited at once don't collide in the same file. */
export function writeEntityFile(type: EntityType, id: string, data: Record<string, unknown>): Promise<void> {
  return serialize(async () => {
    const { dir } = await ensureHiddenCloneInitialized();
    // A field still waiting on the user is committed with the other
    // device's value until it is resolved — see overlayPendingConflicts().
    const entityType = DIR_TO_ENTITY_TYPE[type];
    const committed = entityType ? await overlayPendingConflicts(entityType, id, data) : data;
    const json = JSON.stringify(committed, null, 2);
    // Payload size is logged because a recipe carrying a data: URI as its
    // cover image (rather than a link or a stored local path) makes this
    // one file megabytes long, which then has to be written, hashed and
    // committed on every single save.
    const startedAt = performance.now();
    await gitfs.promises.writeFile(`${dir}/${type}/${id}.json`, json);
    dirtyPaths.add(`${type}/${id}.json`);
    // The file now reflects the row as of this updated_at — see
    // syncReconcile.local.ts.
    if (entityType) await recordSynced(entityType, id, data.updated_at);
    logIfSlow(`writeEntityFile(${type}) fs write`, startedAt, `${Math.round(json.length / 1024)}KB`);
    scheduleCommit();
  });
}

// ── Debounced commit — a burst of edits (typing a form, saving several
// ingredient rows) becomes one commit, not dozens. ──────────────────────

let commitTimer: ReturnType<typeof setTimeout> | null = null;

/** Entity files written since the last commit. statusMatrix() trusts git's
 *  index stat cache — same size and same mtime second means "unchanged" —
 *  so an edit that rewrites a file with a same-length value within a second
 *  of the previous write (a merge, then an immediate edit) was silently
 *  never committed. These paths are staged explicitly instead: git.add()
 *  always re-hashes what it is given. */
const dirtyPaths = new Set<string>();

export function scheduleCommit(delayMs = 2000): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    commitNow().catch((err) => console.error('SmartChef sync commit failed:', err));
  }, delayMs);
}

/** Stages and commits whatever changed under any of ALL_ENTITY_DIRS in the
 *  Hidden Clone — a no-op if nothing did. Unwrapped core — call this
 *  directly (not the serialized commitNow() export) from anywhere that's
 *  already running inside serialize(), e.g. syncNowInternal() below;
 *  going through commitNow() there would deadlock. */
async function commitNowInternal(): Promise<boolean> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();

  // Before git looks at the working tree: bring any image this device has
  // stored but not yet committed into the clone, so a recipe's cover travels
  // with the recipe row that references it. Add-only and content-addressed
  // (lib/sync/imageSync.ts), so this is a no-op on every cycle after the
  // first for a given photo.
  const imageCopy = await copyImagesIntoClone(dir);
  if (imageCopy.copied > 0) {
    console.info(`SmartChef: staged ${imageCopy.copied} image(s) for sync`);
  }

  if (dirtyPaths.size > 0) {
    const written = [...dirtyPaths];
    dirtyPaths.clear();
    await git.add({ fs: gitfs, dir, gitdir, filepath: written, cache: gitCache() });
  }

  const statusStartedAt = performance.now();
  const matrix = await git.statusMatrix({ fs: gitfs, dir, gitdir, filepaths: COMMITTED_DIRS, cache: gitCache() });
  logIfSlow('commit statusMatrix', statusStartedAt, `${matrix.length} files`);
  const changed = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (!changed) return false;

  await git.add({ fs: gitfs, dir, gitdir, filepath: COMMITTED_DIRS, cache: gitCache() });
  const id = await getDeviceId();
  const changedCount = matrix.filter(([, head, workdir, stage]) => head !== workdir || head !== stage).length;
  await git.commit({
    fs: gitfs,
    dir,
    gitdir,
    message: `sync: ${changedCount} change${changedCount === 1 ? '' : 's'} from ${id}`,
    author: author(),
  });
  return true;
}

export function commitNow(): Promise<boolean> {
  return serialize(commitNowInternal, 'commitNow');
}

/** Commits the outcome of merging `remoteOid` into this device as a real
 *  git merge commit — parents [local HEAD, remoteOid] — and does so even
 *  when the merge changed no file.
 *
 *  This is what makes Structured Merge three-way at all (ADR 0006). The
 *  post-merge commit used to be an ordinary single-parent commit on this
 *  device's own history, so the remote commit never became an ancestor:
 *  findMergeBase() never found common ground between two devices, every
 *  merge compared against nothing, and every field that differed came back
 *  as a conflict — sync after sync. It is also why git-remote pushes needed
 *  `force: true`. With the remote as a parent, the next merge's base is the
 *  commit this one already reconciled, and only edits made since compare.
 *
 *  With no local history yet (first sync) the remote is the only parent. */
async function commitMergeInternal(localOid: string | null, remoteOid: string): Promise<string> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();
  await copyImagesIntoClone(dir);
  await git.add({ fs: gitfs, dir, gitdir, filepath: COMMITTED_DIRS, cache: gitCache() });
  const id = await getDeviceId();
  return git.commit({
    fs: gitfs,
    dir,
    gitdir,
    message: `merge: sync from another device into ${id}`,
    author: author(),
    parent: localOid ? [localOid, remoteOid] : [remoteOid],
  });
}

/** Writes every file the remote tree has and the working tree lacks. The
 *  merge commit makes the remote an ancestor, so anything it doesn't carry
 *  reads to other devices as a deletion — an entity that failed to apply
 *  here, or an image this device never had, must still ride along. */
async function copyRemoteOnlyFiles(dir: string, gitdir: string, remoteOid: string, paths: string[]): Promise<void> {
  for (const filepath of paths) {
    const target = `${dir}/${filepath}`;
    try {
      await gitfs.promises.stat(target);
      continue; // the merge already wrote it
    } catch {
      // absent — copy it below
    }
    try {
      const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid: remoteOid, filepath, cache: gitCache() });
      const slash = filepath.lastIndexOf('/');
      if (slash > 0) await mkdirp(`${dir}/${filepath.slice(0, slash)}`);
      await gitfs.promises.writeFile(target, blob);
    } catch (err) {
      console.warn(`SmartChef: could not carry ${filepath} into the merge commit:`, err);
    }
  }
}

async function mkdirp(path: string): Promise<void> {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const partial = parts.slice(0, i).join('/');
    if (!partial) continue;
    try {
      await gitfs.promises.mkdir(partial);
    } catch {
      // exists already
    }
  }
}

// ── Remote transport resolution — which platform, and has the user
// actually configured a Sync Folder yet (skippable per ticket 07). ──────

async function getConfiguredRemoteTransport(): Promise<RemoteTransport | null> {
  if (isElectron()) {
    try {
      return await createElectronRemoteTransport();
    } catch {
      return null; // no folder chosen yet — createElectronRemoteTransport() throws until chooseElectronSyncFolder() has run
    }
  }
  const state = await getMirrorState();
  if (!state) return null;
  return createAndroidRemoteTransport(state.treeUri);
}

// ── Device registry — devices/<id>.json, one file per device, disjoint by
// writer so no merge logic is needed. Lives directly in the Sync Folder
// (via RemoteTransport, not the Hidden Clone) — never committed to git,
// same as the superseded design: always-fresh state, not history. ───────

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'electron';
  lastSyncAt: string;
}

/** Writes only this device's own devices/<id>.json, never another
 *  device's. No-op if no Sync Folder is configured — there's nowhere to
 *  write a shared registry entry to yet. */
async function writeDeviceRecord(transport: RemoteTransport | null): Promise<void> {
  if (!transport) return;
  const id = await getDeviceId();
  const record: DeviceRecord = {
    deviceId: id,
    deviceName: await getDeviceName(),
    platform: isElectron() ? 'electron' : 'android',
    lastSyncAt: new Date().toISOString(),
  };
  await transport.writeFile(`devices/${id}.json`, new TextEncoder().encode(JSON.stringify(record, null, 2)));
}

/** Every device that's ever synced through this Sync Folder, newest
 *  lastSyncAt first — Account.tsx's device list and SyncHistory.tsx both
 *  read this. A corrupt/partially-written file is skipped rather than
 *  failing the whole list. Empty when no Sync Folder is configured, or
 *  nothing's synced through it yet — neither is an error. */
export async function listDeviceRecords(): Promise<DeviceRecord[]> {
  const transport = await getConfiguredRemoteTransport();
  if (!transport) return [];
  let names: string[];
  try {
    names = await transport.listDir('devices');
  } catch {
    return [];
  }
  const records: DeviceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const bytes = await transport.readFile(`devices/${name}`);
      records.push(JSON.parse(new TextDecoder().decode(bytes)) as DeviceRecord);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => b.lastSyncAt.localeCompare(a.lastSyncAt));
}

/** Same singular entityType strings mergeBridge.ts's ENTITY_DIRS uses. */
export type SyncEntityType = 'recipe' | 'ingredient' | 'tool' | 'tag' | 'technique' | 'profile' | 'category' | 'unit';

export interface SyncResult {
  applied: number;
  /** `applied`, broken down by entity type — lets the UI say "3 recipes, 5
   *  ingredients" instead of just a bare count. */
  appliedByType: Partial<Record<SyncEntityType, number>>;
  committed: boolean;
  lastSyncAt: string;
  /** Newly pending Structured Merge conflicts from this sync cycle — not
   *  read by any existing caller yet (ticket 06's Conflicts UI reads
   *  conflicts.local.ts directly), but a useful signal to surface later
   *  without another SyncResult shape change. */
  conflicts: number;
  /** Object counts from this cycle's transfers — "uploaded" (pushed to the
   *  Sync Folder) vs "downloaded" (pulled from it), the direction the user
   *  actually asked about wanting visibility into. Combines both push
   *  calls (the one before merge and the one after, covering a merge
   *  commit) since neither on its own is what "how much did this sync
   *  cycle move" means. */
  pushedObjects: number;
  pulledObjects: number;
  /** Entities a remote change existed for but couldn't be written into
   *  Local Storage this cycle (mergeBridge.ts isolates each entity's write
   *  so one bad one doesn't abort the rest — see its own MergeBridgeResult.
   *  failedEntities). Should be empty in normal operation; surfaced here
   *  so a real failure shows up in the UI instead of only a console log
   *  nobody but a developer would ever open. */
  failedEntities: Array<{ entityType: string; entityId: string; error: string }>;
  /** Fields both devices changed that a rule settled without asking —
   *  during the merge, plus pending conflicts settled after it (ADR 0006). */
  autoResolved: number;
  /** Passthrough of mergeBridge.ts's own per-entity-type scan counts — see
   *  MergeBridgeResult.entityScanCounts for why this exists. Only the last
   *  merge call's counts are kept per type (git-remote/folder mode can run
   *  applyMergeIfNeeded() more than once in a retry loop; a later count is
   *  always at least as accurate as an earlier one from the same cycle). */
  entityScanCounts: Record<string, { remoteFiles: number; localFiles: number }>;
}

/** The main entry point — call on app foreground/resume, on a periodic
 *  timer, and from a manual "Sync Now" button.
 *
 *  Order: commit this device's own pending edits first (so local HEAD
 *  reflects everything it's done before comparing against remote) : pull
 *  into the remote-tracking ref : if that ref now differs from local HEAD,
 *  run Structured Merge (mergeBridge.ts), re-serialize whatever it touched
 *  back into the Hidden Clone, commit again : push, guarded by a compare-
 *  and-swap against exactly the remote ref bytes this cycle just observed
 *  : write this device's own device record. A push or pull failure is
 *  caught and logged rather than thrown — local reads/writes must keep
 *  working regardless of Sync Folder connectivity, same guarantee the
 *  superseded design had.
 *
 *  Pull-before-push is load-bearing, not stylistic: pushing first (the
 *  original order) writes this device's ref straight over the Sync
 *  Folder's shared ref before this device has looked at what's there,
 *  discarding any commit another device pushed since this device's last
 *  sync — the object stays on disk but nothing points at it anymore, no
 *  error raised anywhere. A file-sync tool watching the Sync Folder from
 *  outside observes that as two near-simultaneous edits to the same ref
 *  file (Syncthing renames one into a `.sync-conflict-*` copy instead of
 *  merging it — there is no textual merge for a git ref) or, on a
 *  provider with weaker conflict handling (Google Drive), silent data
 *  loss. Pulling first — and then guarding the push with a compare-and-
 *  swap against the exact ref bytes just pulled, retried through another
 *  pull+merge if a concurrent writer beat this device to it — closes that
 *  window instead of racing through it. */
async function syncNowInternal(onProgress?: (progress: TransferProgress) => void): Promise<SyncResult> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();

  // Repo → database first: whatever HEAD holds and this database failed to
  // take (see syncReconcile.local.ts), so the merge below starts from a
  // database that matches its own history.
  const pulledIntoDb = await pullHeadIntoDatabase(dir, gitdir);

  const committedBeforeSync = await commitNowInternal();

  let applied = pulledIntoDb.applied;
  const appliedByType: Partial<Record<SyncEntityType, number>> = {};
  let conflicts = 0;
  let autoResolved = 0;
  let mergeCommitted = false;
  const policy = await getConflictPolicy();
  let pushedObjects = 0;
  let pulledObjects = 0;
  const failedEntities: Array<{ entityType: string; entityId: string; error: string }> = [...pulledIntoDb.failed];
  const entityScanCounts: Record<string, { remoteFiles: number; localFiles: number }> = {};

  // The "sync paused" banner (Account.tsx, driven by androidMirror.ts's
  // pause-reason state) predates this rewrite and still reads that same
  // state — it just isn't androidMirror.ts itself producing it anymore for
  // this code path.
  //
  // This used to early-return on Electron, on the reasoning that Electron
  // has no separate mirror step to pause. That was wrong, and expensively
  // so: the state is plain Preferences and the banner is ordinary markup,
  // so both work identically on desktop — the guard was the only thing
  // stopping it. The cost was a desktop that failed to push for a week
  // while showing nothing at all, ending up 82 commits ahead of its remote
  // with every image it had migrated still sitting on the one machine. A
  // sync that cannot report its own failure is worse than one that fails
  // loudly, on every platform.
  // Judged over the whole push+pull pair, not each call individually: a
  // pull that "succeeds" only because RemoteTransport.exists() swallows a
  // permission error into `false` (see androidRemoteTransport.ts) must not
  // paper over a push that genuinely failed moments earlier in the same
  // cycle — the banner should only clear once both sides are healthy.
  async function reportTransportOutcome(ok: boolean, err?: unknown): Promise<void> {
    await setSyncPauseReason(ok ? null : err instanceof Error ? err.message : 'Sync transport failed');
  }

  // Shared between both sync modes: diffs local HEAD against whatever this
  // cycle's fetch/pull just wrote to DEFAULT_REMOTE_TRACKING_REF_NAME, runs
  // Structured Merge if they've diverged, and commits the result. Neither
  // mode's own fetch/pull step needs to know this exists — they just both
  // agree on writing to that one tracking ref location first.
  async function applyMergeIfNeeded(): Promise<void> {
    let localOid: string | null = null;
    try {
      localOid = await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
    } catch {
      // No local commits yet — this device's very first sync. mergeBridge.ts
      // treats a null localOid as "empty local tree", same code path.
    }

    let remoteOid: string | null = null;
    try {
      remoteOid = await git.resolveRef({ fs: gitfs, dir, gitdir, ref: DEFAULT_REMOTE_TRACKING_REF_NAME });
    } catch {
      // A successful fetch/pull is supposed to guarantee this resolves —
      // tolerated anyway rather than throwing, matching this function's
      // overall stance that a sync hiccup should degrade, not crash.
    }

    if (!remoteOid || remoteOid === localOid) return;
    // Already merged: the remote commit is in this device's history (the
    // normal state right after this device's own merge commit, until the
    // other device pushes again). Nothing new to take.
    if (localOid && await git.isDescendent({ fs: gitfs, dir, gitdir, oid: localOid, ancestor: remoteOid, depth: -1, cache: gitCache() })) return;

    let mergeResult;
    try {
      mergeResult = await mergeRemoteIntoLocal(dir, gitdir, localOid, remoteOid, { policy });
    } catch (err) {
      // mergeRemoteIntoLocal() calls git.listFiles() to enumerate each
      // commit's tree — unlike readEntityJson()'s per-blob reads inside
      // it, that call isn't defensively wrapped, so a still-missing tree
      // object throws isomorphic-git's own raw NotFoundError straight
      // through. Can happen even after a bundle catch-up (folder mode;
      // the bundle can itself be stale, or the gap can predate this
      // device ever running the pull-before-push fix) — a real git-remote
      // fetch shouldn't be able to leave a gap like this at all (the
      // server only ever hands over objects it actually has), but the
      // same defensive conversion costs nothing to keep here either way.
      console.warn('SmartChef: merge failed with a missing object even after catch-up:', err);
      throw new Error(
        "Couldn't finish merging — some data this device needs is still missing even after catching up. Try Sync Now " +
        'again once another device has synced recently.'
      );
    }
    // Before the merged entities land: make sure the images they reference
    // actually exist on this device. mergeRemoteIntoLocal() only writes the
    // JSON records it merged, so without this a recipe synced from another
    // device arrives pointing at a cover that was fetched as a git object
    // and never written anywhere a screen can read it.
    const imagesIn = await materializeImagesFromCommit(dir, gitdir, remoteOid);
    if (imagesIn.copied > 0) {
      console.info(`SmartChef: brought ${imagesIn.copied} image(s) across from the sync folder`);
    }

    applied += mergeResult.entitiesCreated + mergeResult.entitiesUpdated;
    conflicts += mergeResult.conflictsRecorded;
    autoResolved += mergeResult.autoResolved;
    failedEntities.push(...mergeResult.failedEntities);
    // The merged file still goes into the tree (mergeBridge.ts), so history
    // records the merge; the database catches up from HEAD next cycle.
    for (const failed of mergeResult.failedEntities) await queueRepair(failed.entityType, failed.entityId, failed.error);
    Object.assign(entityScanCounts, mergeResult.entityScanCounts);

    // Fast-forward (git's own rule): when this device has nothing the
    // remote lacks, there is nothing to reconcile in history — the branch
    // simply moves to the remote commit, with no merge commit. SQLite has
    // already taken every remote change above (local == base, so each one
    // was a fast-forward per field).
    const fastForward = localOid !== null
      && await git.isDescendent({ fs: gitfs, dir, gitdir, oid: remoteOid, ancestor: localOid, depth: -1, cache: gitCache() });
    if (fastForward) {
      const branch = (await git.currentBranch({ fs: gitfs, dir, gitdir })) ?? 'main';
      await git.writeRef({ fs: gitfs, dir, gitdir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
      await git.checkout({ fs: gitfs, dir, gitdir, ref: branch, force: true });
      resetGitCache();
    }

    for (const touched of mergeResult.touchedEntities) {
      const dirName = ENTITY_TYPE_TO_DIR[touched.entityType];
      if (!dirName) continue;
      const path = `${dirName}/${touched.entityId}.json`;
      await gitfs.promises.writeFile(`${dir}/${path}`, JSON.stringify(touched.finalFields, null, 2));
      await recordSynced(touched.entityType, touched.entityId, touched.finalFields.updated_at);
      // After a fast-forward the tree already is the remote's; anything this
      // device wrote differently (references it healed) is a new local edit
      // for the next commit.
      if (fastForward) dirtyPaths.add(path);
      const type = touched.entityType as SyncEntityType;
      appliedByType[type] = (appliedByType[type] ?? 0) + 1;
    }
    if (fastForward) {
      // Committed now, so this cycle's push carries it.
      if (await commitNowInternal()) mergeCommitted = true;
      return;
    }
    await copyRemoteOnlyFiles(dir, gitdir, remoteOid, mergeResult.remoteOnlyFiles);
    await commitMergeInternal(localOid, remoteOid);
    mergeCommitted = true;
  }

  // ── Folder mode (gitObjectTransport.ts) — a plain folder mirrored by an
  // external tool, reached via hand-rolled object/ref byte-copying. ──────

  // Pulls, and merges in the result if the remote actually moved. Returns
  // the freshly-observed remote ref bytes (null if the Sync Folder has no
  // history yet) so the caller can hand them straight to the next push's
  // compare-and-swap. Applied/conflict/appliedByType/mergeCommitted are
  // accumulated onto the enclosing function's own trackers rather than
  // returned, since a retried pull+merge (see the push loop below) needs
  // to add to the same totals, not replace them.
  async function pullAndMergeOnce(transport: RemoteTransport): Promise<Uint8Array | null> {
    const pullResult = await pullObjectsAndRefs(gitfs.promises, dir, transport, undefined, onProgress);
    pulledObjects += pullResult.objectsFetched;
    if (!pullResult.pulled) return null;

    // A directory listing that silently returned fewer objects than the
    // Sync Folder's manifest promises (see gitObjectTransport.ts's header —
    // Google Drive's Android SAF provider is the known offender) means
    // Structured Merge below would be working from a partial object set.
    // mergeBridge.ts's readEntityJson() can't tell "this field never
    // changed" apart from "the object holding its new value never arrived"
    // — both fail the same way, silently — so a merge against an
    // incomplete pull doesn't error, it just quietly drops changes. Before
    // giving up, try the one-file bundle catch-up (gitBundleTransport.ts)
    // — it sidesteps the exact enumeration this device's listing just
    // failed at, since applying it is one file transfer, not thousands of
    // existence checks. Only actually refuse to merge if there's no
    // bundle to fall back on either.
    if (!pullResult.complete) {
      const caughtUp = await tryCatchUpFromBundle(gitfs.promises, dir, gitdir, transport);
      if (!caughtUp) {
        throw new Error(
          "Sync Folder listing looks incomplete on this device — some files may not be visible through this platform's " +
          'folder access (Google Drive on Android is a known case). Switch the Sync Folder to Syncthing, which reliably ' +
          'replicates the whole folder, or try syncing again from a device with direct filesystem access first.'
        );
      }
    }

    await applyMergeIfNeeded();
    return pullResult.remoteRefBytes;
  }

  async function syncFolderMode(transport: RemoteTransport): Promise<void> {
    let transportFailure: unknown;
    let expectedRemoteRefBytes: Uint8Array | null = null;

    try {
      expectedRemoteRefBytes = await pullAndMergeOnce(transport);
    } catch (err) {
      console.warn('SmartChef: sync pull failed:', err);
      transportFailure = err;
    }

    // Bounded retry: a conflict here means another device's push landed on
    // the remote between this device's pull and this push — the expected
    // shape of real concurrent use, not a failure. Re-pull, merge again,
    // try again. Gives up (silently, until next cycle) rather than
    // spinning forever if two devices are pushing in a tight loop against
    // each other.
    const MAX_PUSH_ATTEMPTS = 3;
    for (let attempt = 0; transportFailure === undefined && attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      let pushResult;
      try {
        pushResult = await pushObjectsAndRefs(gitfs.promises, dir, transport, onProgress, expectedRemoteRefBytes);
      } catch (err) {
        console.warn('SmartChef: sync push failed:', err);
        transportFailure = err;
        break;
      }
      pushedObjects += pushResult.objectsUploaded;
      if (!pushResult.conflict) {
        await recordSuccessfulPush();
        // Best-effort: keeps the Sync Folder's one-file catch-up fresh for
        // whichever device next hits an incomplete listing. Never allowed
        // to fail the sync itself — see gitBundleTransport.ts's own
        // docstring for why every caller wraps it like this.
        await writeBundleIfStale(gitfs.promises, dir, gitdir, transport).catch((err) =>
          console.warn('SmartChef: writing sync bundle failed:', err)
        );
        // Every loose object this device had is now confirmed on the
        // remote (pushObjectsAndRefs() either found it already there or
        // just uploaded it, unconditionally, before the ref write above
        // — see gitPacking.ts's own docstring for why that makes this
        // the safe moment to prune). Best-effort and non-fatal, same as
        // the bundle write just above.
        // Invalidated first: packing replaces packs and deletes the loose
        // objects it absorbed, so a cached index from before it is stale.
        resetGitCache();
        await packLooseObjectsAfterPush(gitfs.promises, dir, gitdir).catch((err) =>
          console.warn('SmartChef: packing local objects failed:', err)
        );
        break;
      }

      if (attempt === MAX_PUSH_ATTEMPTS - 1) {
        console.warn('SmartChef: sync push conflict persisted after retries — will retry next cycle');
        break;
      }
      try {
        expectedRemoteRefBytes = await pullAndMergeOnce(transport);
      } catch (err) {
        console.warn('SmartChef: sync pull failed:', err);
        transportFailure = err;
      }
    }

    await reportTransportOutcome(transportFailure === undefined, transportFailure);
    await writeDeviceRecord(transport).catch((err) => console.warn('SmartChef: writing device record failed:', err));
  }

  // ── Git-remote mode (gitRemoteTransport.ts) — a real git server (GitHub,
  // GitLab, or self-hosted), reached over git's actual smart-HTTP push/
  // fetch protocol. No external file-sync tool in the loop, so none of
  // folder mode's known failure modes (ref races, incomplete listings)
  // apply here — the server itself owns atomic ref updates and always
  // knows its own true object set. Device records (folder mode's "Known
  // Devices" list) aren't tracked in this mode yet — there's no
  // equivalent of "just drop a file next to the git dir" for a real git
  // remote, only commit+push, and committing purely to refresh a
  // timestamp on every sync cycle would spam the history for no real
  // benefit. ───────────────────────────────────────────────────────────

  async function fetchAndMergeOnceGitRemote(config: GitRemoteConfig): Promise<void> {
    const fetchResult = await fetchGitRemote(dir, gitdir, config, (loaded, total) => {
      onProgress?.({ phase: 'pull', done: loaded, total });
    });
    if (!fetchResult.fetched) return;
    await applyMergeIfNeeded();
  }

  async function syncGitRemoteMode(config: GitRemoteConfig): Promise<void> {
    let transportFailure: unknown;

    try {
      await fetchAndMergeOnceGitRemote(config);
    } catch (err) {
      console.warn('SmartChef: git-remote fetch failed:', err);
      transportFailure = err;
    }

    const MAX_PUSH_ATTEMPTS = 3;
    for (let attempt = 0; transportFailure === undefined && attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      let pushResult;
      try {
        pushResult = await pushGitRemote(dir, gitdir, config);
      } catch (err) {
        console.warn('SmartChef: git-remote push failed:', err);
        transportFailure = err;
        break;
      }
      if (pushResult.pushed) {
        await recordSuccessfulPush();
        // A successful git.push() means the remote now has every object
        // reachable from the pushed ref — same "safe to prune" moment as
        // folder mode's, just reached through the real git protocol
        // instead of pushObjectsAndRefs()'s own per-object check. See
        // gitPacking.ts's docstring for the full safety argument.
        // Invalidated first: packing replaces packs and deletes the loose
        // objects it absorbed, so a cached index from before it is stale.
        resetGitCache();
        await packLooseObjectsAfterPush(gitfs.promises, dir, gitdir).catch((err) =>
          console.warn('SmartChef: packing local objects failed:', err)
        );
        break;
      }
      if (!pushResult.conflict) break; // nothing to push yet

      if (attempt === MAX_PUSH_ATTEMPTS - 1) {
        console.warn('SmartChef: git-remote push rejected after retries — will retry next cycle');
        break;
      }
      try {
        await fetchAndMergeOnceGitRemote(config);
      } catch (err) {
        console.warn('SmartChef: git-remote fetch failed:', err);
        transportFailure = err;
      }
    }

    await reportTransportOutcome(transportFailure === undefined, transportFailure);
  }

  const syncMode = await getSyncMode();
  if (syncMode === 'git-remote') {
    const gitRemoteConfig = await getGitRemoteConfig();
    if (gitRemoteConfig) await syncGitRemoteMode(gitRemoteConfig);
  } else {
    const transport = await getConfiguredRemoteTransport();
    if (transport) await syncFolderMode(transport);
  }

  const lastSyncAt = new Date().toISOString();
  await Preferences.set({ key: LAST_SYNC_KEY, value: lastSyncAt });
  return { applied, appliedByType, committed: committedBeforeSync || mergeCommitted, lastSyncAt, conflicts, autoResolved, pushedObjects, pulledObjects, failedEntities, entityScanCounts };
}

/** Wrapped so every caller — the startup watcher, the interval tick, a
 *  resume, the Sync Now button — publishes the same status. That matters
 *  more than it used to: first-run setup now lets someone into the app
 *  after the profile probe (firstRunProbe.ts) while the library itself is
 *  still arriving, so a screen showing an empty gallery needs to be able to
 *  say "still downloading" and to refill itself when entities land. */
// ── When a push last actually landed ──────────────────────────────────────
// The pause banner above only survives until something clears it, so a
// failure that happens, gets retried, and fails again leaves no lasting
// trace beyond a console line. This does: a push timestamp that stops
// advancing is durable, cheap, and exactly the signal that would have made
// a week of silently-failing pushes obvious on the first day. Deliberately
// separate from LAST_SYNC_KEY, which advances whenever a cycle completes —
// including cycles that fetched perfectly and pushed nothing at all, which
// is the state that hid this.
const LAST_PUSH_KEY = 'smartchef.sync.lastPushAt';

async function recordSuccessfulPush(): Promise<void> {
  await Preferences.set({ key: LAST_PUSH_KEY, value: new Date().toISOString() });
  // A push that actually landed is the only honest all-clear there is: it
  // proves write access empirically, where every other signal in this app
  // only ever proved the remote could be READ. Clearing it here means a
  // user who fixes their token sees the banner go away by itself, without
  // having to find the Test Connection button.
  await setGitRemoteAccessProblem(null);
}

/** null on a device that has never pushed — a fresh install, or one whose
 *  pushes have been failing since it was set up. */
export async function getLastPushAt(): Promise<string | null> {
  const { value } = await Preferences.get({ key: LAST_PUSH_KEY });
  return value ?? null;
}

/** The pull half of two-way reconciliation, against this device's own HEAD. */
async function pullHeadIntoDatabase(dir: string, gitdir: string): Promise<PullOutcome> {
  let head: string;
  try {
    head = await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
  } catch {
    return { applied: 0, failed: [] }; // no history yet
  }
  try {
    const files = await git.listFiles({ fs: gitfs, dir, gitdir, ref: head, cache: gitCache() });
    const headIds = new Map<string, string[]>();
    for (const file of files) {
      const slash = file.indexOf('/');
      const entityType = DIR_TO_ENTITY_TYPE[file.slice(0, slash)];
      if (!entityType || !file.endsWith('.json') || file.indexOf('/', slash + 1) !== -1) continue;
      const list = headIds.get(entityType) ?? [];
      list.push(file.slice(slash + 1, -'.json'.length));
      headIds.set(entityType, list);
    }
    const outcome = await pullRepoIntoDatabase(headIds, async (entityType, entityId) => {
      const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid: head, filepath: `${ENTITY_TYPE_TO_DIR[entityType]}/${entityId}.json`, cache: gitCache() });
      return JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
    });
    if (outcome.applied > 0) console.info(`SmartChef: took ${outcome.applied} item(s) from this device's sync history into its database`);
    return outcome;
  } catch (err) {
    console.warn('SmartChef: reconciling the database with sync history failed:', err);
    return { applied: 0, failed: [] };
  }
}

/** The push half: rows changed since their file was last written. Outside
 *  the git queue — each re-serialization queues on it itself. */
async function publishDatabaseAheadOfRepo(): Promise<void> {
  try {
    const published = await publishRowsAheadOfRepo();
    if (published > 0) console.info(`SmartChef: re-published ${published} item(s) whose changes had not reached sync`);
  } catch (err) {
    console.warn('SmartChef: re-publishing local changes failed:', err);
  }
}

/** Once per entity-file format change (ADR 0006), on the first sync after
 *  upgrading: re-serializes the whole library so its files carry what the
 *  new format adds — category_name, unit_symbol and a stable row order;
 *  then translations, ingredient tags, categories and units — and other
 *  devices stop seeing per-device ids or missing pieces. Queued ahead of
 *  the sync rather than run inside it — each write goes through
 *  serialize() itself, and awaiting that from within a serialized task
 *  would deadlock. */
const RESERIALIZE_KEY = 'smartchef.sync.reserializedFormat';
// '3': rewrites files still carrying unresolvable unit/category ids — see
// referenceHeal.ts.
// '4': the library was revised in place on one device (English base names,
// a name per language for every ingredient, tag, tool, technique and unit,
// folded duplicates). Units have no updated_at, so publishRowsAheadOfRepo
// cannot notice their new translations — this re-serialization is what
// carries them, and everything else, to the other devices.
const ENTITY_FILE_FORMAT = '4';

async function reserializeOnceForPortableIds(): Promise<void> {
  const { value } = await Preferences.get({ key: RESERIALIZE_KEY });
  if (value === ENTITY_FILE_FORMAT) return;
  try {
    const [ingredients, { resyncAllRecipes }, { resyncAllTags }, { resyncAllTechniques }] = await Promise.all([
      import('../../services/ingredients.local'),
      import('../../services/recipes.local'),
      import('../../services/tags.local'),
      import('../../services/techniques.local'),
    ]);
    await ingredients.resyncAllCategories();
    await ingredients.resyncAllUnits();
    await resyncAllTags();
    await ingredients.resyncAllTools();
    await resyncAllTechniques();
    await ingredients.resyncAllIngredients();
    await resyncAllRecipes();
    await Preferences.set({ key: RESERIALIZE_KEY, value: ENTITY_FILE_FORMAT });
  } catch (err) {
    console.warn('SmartChef: re-serializing the library for the new file format failed — will retry next sync:', err);
  }
}

/** updated_at of an entity as the last-fetched remote commit has it —
 *  used to settle conflicts recorded before timestamps were stored. */
export async function readRemoteEntityUpdatedAt(entityType: string, entityId: string): Promise<string | null> {
  const dirName = ENTITY_TYPE_TO_DIR[entityType];
  if (!dirName) return null;
  try {
    const { dir, gitdir } = await ensureHiddenCloneInitialized();
    const oid = await git.resolveRef({ fs: gitfs, dir, gitdir, ref: DEFAULT_REMOTE_TRACKING_REF_NAME });
    const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath: `${dirName}/${entityId}.json`, cache: gitCache() });
    const json = JSON.parse(new TextDecoder().decode(blob)) as { updated_at?: unknown };
    return typeof json.updated_at === 'string' ? json.updated_at : null;
  } catch {
    return null;
  }
}

/** Settles whatever pending conflicts a rule can decide (ADR 0006) — run
 *  after every sync, outside the git queue since resolving re-serializes
 *  entities through it. Covers the backlog recorded before these rules. */
export async function autoResolveConflictsNow(): Promise<number> {
  try {
    const outcome = await autoResolvePendingConflicts(await getConflictPolicy(), readRemoteEntityUpdatedAt);
    return outcome.resolved;
  } catch (err) {
    console.warn('SmartChef: auto-resolving pending conflicts failed:', err);
    return 0;
  }
}

/** Points rows at units this device can resolve, and folds duplicated
 *  ingredient categories — see repairUnknownUnitRefs and repairCategories.
 *  Before publishing, so the fix travels this cycle; after merging, for ids
 *  a merge just brought in (published next cycle). */
async function repairUnitRefs(): Promise<void> {
  try {
    const { fixed, unresolved } = await repairUnknownUnitRefs();
    if (fixed > 0) console.info(`SmartChef: pointed ${fixed} row(s) back at a known unit`);
    if (unresolved > 0) console.warn(`SmartChef: ${unresolved} row(s) reference a unit no device can name`);
  } catch (err) {
    console.warn('SmartChef: repairing unit references failed:', err);
  }
  try {
    const { moved, restored, folded } = await repairCategories();
    if (moved + restored + folded > 0) console.info(`SmartChef: categories repaired — ${moved} ingredient(s) moved, ${folded} duplicate(s) folded, ${restored} restored`);
  } catch (err) {
    console.warn('SmartChef: repairing categories failed:', err);
  }
}

export async function syncNow(onProgress?: (progress: TransferProgress) => void): Promise<SyncResult> {
  await reserializeOnceForPortableIds();
  await repairUnitRefs();
  await publishDatabaseAheadOfRepo();
  const result = await syncNowSerialized(onProgress);
  await repairUnitRefs();
  result.autoResolved += await autoResolveConflictsNow();
  return result;
}

function syncNowSerialized(onProgress?: (progress: TransferProgress) => void): Promise<SyncResult> {
  return serialize(async () => {
    reportSyncStarted();
    // Bracketed rather than left to live for the session: the cache holds
    // the packfile it has read (~13 MB after a first fetch), and gitPacking
    // can rewrite the object store underneath it. One cycle re-reads the
    // pack once; what this avoids is re-reading it per object, ~1,200 times,
    // within a single merge — see gitCache.ts for the measurements.
    resetGitCache();
    let applied = 0;
    try {
      const result = await syncNowInternal(onProgress);
      applied = result.applied;
      return result;
    } finally {
      // In a finally so a failed cycle clears `running` too — otherwise one
      // unreachable-remote tick would leave a "still downloading" banner up
      // for the rest of the session.
      reportSyncFinished(applied);
      resetGitCache();
    }
  }, 'syncNow');
}

export interface RepairResult {
  /** Entities whose Local Storage row got rewritten from this device's own
   *  git history — 0 is the expected, healthy outcome (nothing was stuck). */
  repaired: number;
  failedEntities: Array<{ entityType: string; entityId: string; error: string }>;
}

/** Re-applies this device's OWN current Hidden Clone history onto Local
 *  Storage — a pure local repair, no network involved, for a real bug this
 *  device could be stuck with: an entity whose row got created
 *  successfully while its whole-array fields (steps/ingredients/toolIds)
 *  silently failed to write (a global-id collision in conflicts.local.ts's
 *  writeArrayField(), fixed 2026-08-23). The git commit this device
 *  already has is fully correct either way — only the LOCAL SQLITE WRITE
 *  step could have failed — but nothing re-triggers that write on its own:
 *  mergeRemoteIntoLocal() no-ops whenever localOid === remoteOid, which is
 *  exactly the case once this device has already pulled and committed
 *  everything it's going to get from the remote side.
 *
 *  Implemented as mergeRemoteIntoLocal(dir, gitdir, null, ownHeadOid) —
 *  passing null as "local" makes every entity's every field look like a
 *  fresh fast-forward from "remote" (this device's own HEAD), the exact
 *  same code path a brand-new device's first sync already takes (see
 *  mergeRemoteIntoLocal()'s own doc comment and its "first sync" test) —
 *  reusing it here means repair goes through the same, already-correct
 *  array-field write path as every other sync, not a second
 *  implementation that could drift out of sync with it. Safe to run at
 *  any time, not just as a one-off recovery: re-applying already-correct
 *  data is idempotent, and commitNowInternal() below only actually
 *  commits if something genuinely changed. */
export async function repairLocalStorage(): Promise<RepairResult> {
  return serialize(async () => {
    const { dir, gitdir } = await ensureHiddenCloneInitialized();
    let ownHeadOid: string;
    try {
      ownHeadOid = await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
    } catch {
      return { repaired: 0, failedEntities: [] }; // no commits yet — nothing to repair from
    }

    const result = await mergeRemoteIntoLocal(dir, gitdir, null, ownHeadOid);
    for (const touched of result.touchedEntities) {
      const dirName = ENTITY_TYPE_TO_DIR[touched.entityType];
      if (!dirName) continue;
      await gitfs.promises.writeFile(`${dir}/${dirName}/${touched.entityId}.json`, JSON.stringify(touched.finalFields, null, 2));
    }
    if (result.touchedEntities.length > 0) await commitNowInternal();
    await markAllInSync();

    return { repaired: result.entitiesCreated + result.entitiesUpdated, failedEntities: result.failedEntities };
  });
}

// ── Replace this device with the synced data (`git reset --hard`) ─────────
// The opposite of "Resync All", which re-pushes this device's rows and so
// only ever merges: this throws this device's library away and takes the
// Sync Folder's (or git remote's) as the truth. For a device that has got
// itself into a state nobody wants to merge.

const NO_REMOTE_MESSAGE = 'No Sync Folder or git remote is configured on this device yet.';
const EMPTY_REMOTE_MESSAGE = 'The Sync Folder has no synced data yet — sync from another device first.';

/** Fetches the remote into the remote-tracking ref without merging
 *  anything, and returns the commit it points at. */
async function pullRemoteInternal(dir: string, gitdir: string, onProgress?: (progress: TransferProgress) => void): Promise<string> {
  if ((await getSyncMode()) === 'git-remote') {
    const config = await getGitRemoteConfig();
    if (!config) throw new Error(NO_REMOTE_MESSAGE);
    await fetchGitRemote(dir, gitdir, config, (loaded, total) => onProgress?.({ phase: 'pull', done: loaded, total }));
  } else {
    const transport = await getConfiguredRemoteTransport();
    if (!transport) throw new Error(NO_REMOTE_MESSAGE);
    const pulled = await pullObjectsAndRefs(gitfs.promises, dir, transport, undefined, onProgress);
    if (pulled.pulled && !pulled.complete && !(await tryCatchUpFromBundle(gitfs.promises, dir, gitdir, transport))) {
      throw new Error(i18n.t('errors.syncListingIncomplete'));
    }
  }
  try {
    return await git.resolveRef({ fs: gitfs, dir, gitdir, ref: DEFAULT_REMOTE_TRACKING_REF_NAME });
  } catch {
    throw new Error(EMPTY_REMOTE_MESSAGE);
  }
}

const REPLACE_COUNT_TYPES = ['recipe', 'ingredient', 'tool', 'tag', 'technique'] as const;
export type ReplaceCountType = typeof REPLACE_COUNT_TYPES[number];

export interface ReplacePreview {
  local: Record<ReplaceCountType, number>;
  remote: Record<ReplaceCountType, number>;
}

/** What a replace would do, without doing it — for the confirmation dialog. */
export function previewReplaceFromRemote(onProgress?: (progress: TransferProgress) => void): Promise<ReplacePreview> {
  return serialize(async () => {
    const { dir, gitdir } = await ensureHiddenCloneInitialized();
    const remoteOid = await pullRemoteInternal(dir, gitdir, onProgress);
    const snapshot = await readRemoteSnapshot(dir, gitdir, remoteOid);
    const local = {} as Record<ReplaceCountType, number>;
    const remote = {} as Record<ReplaceCountType, number>;
    for (const type of REPLACE_COUNT_TYPES) {
      local[type] = (await listLocalEntityIds(type)).length;
      remote[type] = snapshot.entities.get(type)?.size ?? 0;
    }
    return { local, remote };
  }, 'previewReplaceFromRemote');
}

export interface ReplaceResult extends ReplaceOutcome {
  /** Ref holding this device's history from before the replace, if it had
   *  any — recoverable with git, never shown as an everyday action. */
  backupRef: string | null;
}

const BACKUP_REF_DIR = 'refs/backups';
const BACKUPS_KEPT = 3;

function backupStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

async function writeBackupRef(dir: string, gitdir: string, oid: string): Promise<string> {
  const ref = `${BACKUP_REF_DIR}/pre-replace-${backupStamp()}`;
  await git.writeRef({ fs: gitfs, dir, gitdir, ref, value: oid, force: true });
  try {
    const existing = (await git.listRefs({ fs: gitfs, dir, gitdir, filepath: BACKUP_REF_DIR })).sort();
    for (const name of existing.slice(0, Math.max(0, existing.length - BACKUPS_KEPT))) {
      await git.deleteRef({ fs: gitfs, dir, gitdir, ref: `${BACKUP_REF_DIR}/${name}` });
    }
  } catch (err) {
    console.warn('SmartChef: pruning old backup refs failed:', err);
  }
  return ref;
}

/** Makes this device's library exactly the synced one: every synced row is
 *  overwritten with the remote copy, rows only this device has are
 *  discarded, pending conflicts are dropped, and the Hidden Clone is moved
 *  onto the remote commit so the next sync has nothing to merge or push.
 *
 *  Nothing is changed until every remote file has been read and parsed. The
 *  previous history stays reachable under refs/backups/. Categories, units,
 *  profiles on this device, cooking history, collections and settings are
 *  kept — see conflicts.local.ts discardLocalEntity(). */
export function replaceLocalWithRemote(onProgress?: (done: number, total: number) => void): Promise<ReplaceResult> {
  return serialize(async () => {
    reportSyncStarted();
    let applied = 0;
    try {
      const { dir, gitdir } = await ensureHiddenCloneInitialized();
      resetGitCache();
      await commitNowInternal();
      const remoteOid = await pullRemoteInternal(dir, gitdir);

      const snapshot = await readRemoteSnapshot(dir, gitdir, remoteOid);
      if (snapshot.unreadable.length > 0) {
        throw new Error(
          `${snapshot.unreadable.length} synced item(s) could not be read, so nothing was replaced. Sync again once the Sync Folder has finished copying.`
        );
      }

      let backupRef: string | null = null;
      try {
        backupRef = await writeBackupRef(dir, gitdir, await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' }));
      } catch {
        // No local history yet — nothing to back up.
      }

      const outcome = await applyRemoteSnapshot(dir, gitdir, remoteOid, snapshot, onProgress);
      // The database is now exactly the synced copy: nothing to re-publish.
      await markAllInSync();
      applied = Object.values(outcome.applied).reduce((n, c) => n + c, 0);
      await materializeImagesFromCommit(dir, gitdir, remoteOid).catch((err) =>
        console.warn('SmartChef: bringing images across during replace failed:', err)
      );

      const branch = (await git.currentBranch({ fs: gitfs, dir, gitdir })) ?? 'main';
      await git.writeRef({ fs: gitfs, dir, gitdir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
      await git.checkout({ fs: gitfs, dir, gitdir, ref: branch, force: true });
      resetGitCache();

      await Preferences.set({ key: LAST_SYNC_KEY, value: new Date().toISOString() });
      return { ...outcome, backupRef };
    } finally {
      reportSyncFinished(applied);
      resetGitCache();
    }
  }, 'replaceLocalWithRemote');
}

export async function getLastSyncAt(): Promise<string | null> {
  const { value } = await Preferences.get({ key: LAST_SYNC_KEY });
  return value ?? null;
}

// ── History (read-only — see SyncHistory.tsx) ───────────────────────────

export interface SyncCommit {
  oid: string;
  message: string;
  authorName: string;
  timestamp: number;
  changedFiles: string[];
}

export async function getSyncHistory(limit = 50): Promise<SyncCommit[]> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();
  let commits;
  try {
    commits = await git.log({ fs: gitfs, dir, gitdir, depth: limit, includeChanges: true, cache: gitCache() });
  } catch {
    return []; // no commits yet
  }
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message,
    authorName: c.commit.author.name,
    timestamp: c.commit.author.timestamp * 1000,
    changedFiles: (c.commit.changes ?? []).map((change) => String(change[2])),
  }));
}

// ── Watcher — sync on app resume, plus a periodic fallback. No
// connectivity listener — a shared folder being "reachable" is a
// filesystem question, not a network one, and a git-remote server being
// reachable is checked by just trying; whatever keeps the Sync Folder
// current (an OS-level cloud client, or nothing at all for a git remote)
// does its own thing on its own schedule, so a fixed timer is all there
// is to trigger a re-check with. Mode-agnostic — syncNow() itself branches
// on the configured sync mode, so this watcher drives both the same way.
// Named for its original folder-only design; kept for the one existing
// call site in App.tsx rather than a purely cosmetic rename. ────────────

let watcherStarted = false;
let watcherIntervalId: ReturnType<typeof setInterval> | null = null;

function runWatcherTick(): void {
  syncNow().catch((err) => console.error('SmartChef periodic sync failed:', err));
}

export async function startFolderSyncWatcher(): Promise<void> {
  if (watcherStarted) return;
  watcherStarted = true;

  syncNow().catch((err) => console.error('SmartChef initial sync failed:', err));

  const minutes = await getSyncIntervalMinutes();
  watcherIntervalId = setInterval(runWatcherTick, minutes * 60_000);

  import('@capacitor/app').then(({ App }) => {
    App.addListener('resume', () => {
      syncNow().catch((err) => console.error('SmartChef resume sync failed:', err));
    });
  }).catch(() => {});
}

/** Applies a newly-chosen interval immediately, without needing an app
 *  restart — called from the settings UI right after setSyncIntervalMinutes().
 *  No-op if the watcher hasn't started yet (still mid-onboarding); the
 *  new value is picked up on next launch regardless, since
 *  startFolderSyncWatcher() always reads the persisted setting itself. */
export function applySyncIntervalChange(minutes: number): void {
  if (!watcherStarted) return;
  if (watcherIntervalId) clearInterval(watcherIntervalId);
  watcherIntervalId = setInterval(runWatcherTick, minutes * 60_000);
}
