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

import * as git from 'isomorphic-git';
import { Preferences } from '@capacitor/preferences';
import { gitfs } from '../gitfs';
import { isElectron } from '../electronBridge';
import { ensureHiddenCloneInitialized, resetHiddenCloneInitFlag } from './hiddenClone';
import { pushObjectsAndRefs, pullObjectsAndRefs, DEFAULT_REMOTE_TRACKING_REF_NAME, type RemoteTransport, type TransferProgress } from './gitObjectTransport';
import { writeBundleIfStale, tryCatchUpFromBundle } from './gitBundleTransport';
import { packLooseObjectsAfterPush } from './gitPacking';
import { fetchGitRemote, pushGitRemote } from './gitRemoteTransport';
import { getSyncMode, getGitRemoteConfig, getSyncIntervalMinutes, type GitRemoteConfig } from './syncSettings';
import { createElectronRemoteTransport } from './electronRemoteTransport';
import { createAndroidRemoteTransport } from './androidRemoteTransport';
import { getMirrorState, setSyncPauseReason } from './androidMirror';
import { mergeRemoteIntoLocal } from './mergeBridge';

const DEVICE_ID_KEY = 'smartchef.sync.deviceId';
const DEVICE_NAME_KEY = 'smartchef.sync.deviceName';
const LAST_SYNC_KEY = 'smartchef.sync.lastSyncAt';

// Same reasoning as the superseded design: writeEntityFile() fires once
// per row during a bulk import, each independently touching the Hidden
// Clone, while startFolderSyncWatcher()'s periodic tick (or a user
// clicking "Sync Now" mid-import) can call syncNow() concurrently against
// the same dir/gitdir. Serializing every entry point through one shared
// queue — same promise-chain-mutex pattern db/local.ts uses for the same
// reason — is what actually prevents two callers racing through git
// operations at once.
let gitQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(fn, fn);
  gitQueue = next.catch(() => {});
  return next;
}

type EntityType = 'recipes' | 'ingredients' | 'tools' | 'tags' | 'techniques' | 'profiles';
const ENTITY_TYPE_TO_DIR: Record<string, EntityType> = {
  recipe: 'recipes',
  ingredient: 'ingredients',
  tool: 'tools',
  tag: 'tags',
  technique: 'techniques',
  profile: 'profiles',
};
const ALL_ENTITY_DIRS: EntityType[] = ['recipes', 'ingredients', 'tools', 'tags', 'techniques', 'profiles'];

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
    await gitfs.promises.writeFile(`${dir}/${type}/${id}.json`, JSON.stringify(data, null, 2));
    scheduleCommit();
  });
}

// ── Debounced commit — a burst of edits (typing a form, saving several
// ingredient rows) becomes one commit, not dozens. ──────────────────────

let commitTimer: ReturnType<typeof setTimeout> | null = null;

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
  const matrix = await git.statusMatrix({ fs: gitfs, dir, gitdir, filepaths: ALL_ENTITY_DIRS });
  const changed = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (!changed) return false;

  await git.add({ fs: gitfs, dir, gitdir, filepath: ALL_ENTITY_DIRS });
  const id = await getDeviceId();
  const changedCount = matrix.filter(([, head, workdir]) => head !== workdir).length;
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
  return serialize(commitNowInternal);
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
export type SyncEntityType = 'recipe' | 'ingredient' | 'tool' | 'tag' | 'technique' | 'profile';

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

  const committedBeforeSync = await commitNowInternal();

  let applied = 0;
  const appliedByType: Partial<Record<SyncEntityType, number>> = {};
  let conflicts = 0;
  let mergeCommitted = false;
  let pushedObjects = 0;
  let pulledObjects = 0;
  const failedEntities: Array<{ entityType: string; entityId: string; error: string }> = [];

  // Android's "sync paused — folder access lost" banner (Account.tsx,
  // driven by androidMirror.ts's pause-reason state) predates this
  // rewrite and still reads that same state — it just isn't androidMirror.ts
  // itself producing it anymore for this code path, so a real transport
  // failure here needs to keep reporting into it. Electron has no
  // equivalent UI (no separate mirror step to pause), so this is a no-op
  // there — matches FolderSyncCard.refreshPauseReason()'s existing guard.
  // Judged over the whole push+pull pair, not each call individually: a
  // pull that "succeeds" only because RemoteTransport.exists() swallows a
  // permission error into `false` (see androidRemoteTransport.ts) must not
  // paper over a push that genuinely failed moments earlier in the same
  // cycle — the banner should only clear once both sides are healthy.
  async function reportTransportOutcome(ok: boolean, err?: unknown): Promise<void> {
    if (isElectron()) return;
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

    let mergeResult;
    try {
      mergeResult = await mergeRemoteIntoLocal(dir, gitdir, localOid, remoteOid);
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
    applied += mergeResult.entitiesCreated + mergeResult.entitiesUpdated;
    conflicts += mergeResult.conflictsRecorded;
    failedEntities.push(...mergeResult.failedEntities);

    for (const touched of mergeResult.touchedEntities) {
      const dirName = ENTITY_TYPE_TO_DIR[touched.entityType];
      if (!dirName) continue;
      await gitfs.promises.writeFile(`${dir}/${dirName}/${touched.entityId}.json`, JSON.stringify(touched.finalFields, null, 2));
      const type = touched.entityType as SyncEntityType;
      appliedByType[type] = (appliedByType[type] ?? 0) + 1;
    }
    if (mergeResult.touchedEntities.length > 0) {
      mergeCommitted = (await commitNowInternal()) || mergeCommitted;
    }
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
        // A successful git.push() means the remote now has every object
        // reachable from the pushed ref — same "safe to prune" moment as
        // folder mode's, just reached through the real git protocol
        // instead of pushObjectsAndRefs()'s own per-object check. See
        // gitPacking.ts's docstring for the full safety argument.
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
  return { applied, appliedByType, committed: committedBeforeSync || mergeCommitted, lastSyncAt, conflicts, pushedObjects, pulledObjects, failedEntities };
}

export function syncNow(onProgress?: (progress: TransferProgress) => void): Promise<SyncResult> {
  return serialize(() => syncNowInternal(onProgress));
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
    commits = await git.log({ fs: gitfs, dir, gitdir, depth: limit, includeChanges: true });
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
