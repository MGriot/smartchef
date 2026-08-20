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
// Recipes/ingredients only, matching the superseded design's own scope —
// tools/tags/techniques were never committed to git there either.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { Preferences } from '@capacitor/preferences';
import { gitfs } from '../gitfs';
import { isElectron } from '../electronBridge';
import { ensureHiddenCloneInitialized, resetHiddenCloneInitFlag } from './hiddenClone';
import { pushObjectsAndRefs, pullObjectsAndRefs, DEFAULT_REMOTE_TRACKING_REF_NAME, type RemoteTransport } from './gitObjectTransport';
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

type EntityType = 'recipes' | 'ingredients';
const ENTITY_TYPE_TO_DIR: Record<string, EntityType> = { recipe: 'recipes', ingredient: 'ingredients' };

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

/** Stages and commits whatever changed under recipes/ or ingredients/ in
 *  the Hidden Clone — a no-op if nothing did. Unwrapped core — call this
 *  directly (not the serialized commitNow() export) from anywhere that's
 *  already running inside serialize(), e.g. syncNowInternal() below;
 *  going through commitNow() there would deadlock. */
async function commitNowInternal(): Promise<boolean> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();
  const matrix = await git.statusMatrix({ fs: gitfs, dir, gitdir, filepaths: ['recipes', 'ingredients'] });
  const changed = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (!changed) return false;

  await git.add({ fs: gitfs, dir, gitdir, filepath: ['recipes', 'ingredients'] });
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

export interface SyncResult {
  applied: number;
  committed: boolean;
  lastSyncAt: string;
  /** Newly pending Structured Merge conflicts from this sync cycle — not
   *  read by any existing caller yet (ticket 06's Conflicts UI reads
   *  conflicts.local.ts directly), but a useful signal to surface later
   *  without another SyncResult shape change. */
  conflicts: number;
}

/** The main entry point — call on app foreground/resume, on a periodic
 *  timer, and from a manual "Sync Now" button.
 *
 *  Order: commit this device's own pending edits first (so local HEAD
 *  reflects everything it's done before comparing against remote) : push
 *  : pull into the remote-tracking ref : if that ref now differs from
 *  local HEAD, run Structured Merge (mergeBridge.ts), re-serialize
 *  whatever it touched back into the Hidden Clone, commit again : write
 *  this device's own device record : push once more (covers the merge
 *  commit, if any — pushing when there's nothing new is cheap, every
 *  object gets skipped). A push or pull failure is caught and logged
 *  rather than thrown — local reads/writes must keep working regardless
 *  of Sync Folder connectivity, same guarantee the superseded design had. */
async function syncNowInternal(): Promise<SyncResult> {
  const { dir, gitdir } = await ensureHiddenCloneInitialized();

  const committedBeforeSync = await commitNowInternal();

  const transport = await getConfiguredRemoteTransport();
  let applied = 0;
  let conflicts = 0;
  let mergeCommitted = false;

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

  if (transport) {
    let transportFailure: unknown;

    try {
      await pushObjectsAndRefs(gitfs.promises, dir, transport);
    } catch (err) {
      console.warn('SmartChef: sync push failed:', err);
      transportFailure = err;
    }

    const pullResult = await pullObjectsAndRefs(gitfs.promises, dir, transport).catch((err) => {
      console.warn('SmartChef: sync pull failed:', err);
      transportFailure = err;
      return null;
    });

    await reportTransportOutcome(transportFailure === undefined, transportFailure);

    if (pullResult?.pulled) {
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
        // pulled:true is supposed to guarantee this resolves — tolerated
        // anyway rather than throwing, matching this function's overall
        // stance that a sync hiccup should degrade, not crash.
      }

      if (remoteOid && remoteOid !== localOid) {
        const mergeResult = await mergeRemoteIntoLocal(dir, gitdir, localOid, remoteOid);
        applied = mergeResult.entitiesCreated + mergeResult.entitiesUpdated;
        conflicts = mergeResult.conflictsRecorded;

        for (const touched of mergeResult.touchedEntities) {
          const dirName = ENTITY_TYPE_TO_DIR[touched.entityType];
          if (!dirName) continue;
          await gitfs.promises.writeFile(`${dir}/${dirName}/${touched.entityId}.json`, JSON.stringify(touched.finalFields, null, 2));
        }
        if (mergeResult.touchedEntities.length > 0) {
          mergeCommitted = await commitNowInternal();
        }
      }
    }
  }

  await writeDeviceRecord(transport).catch((err) => console.warn('SmartChef: writing device record failed:', err));

  if (transport) {
    await pushObjectsAndRefs(gitfs.promises, dir, transport).catch((err) => console.warn('SmartChef: sync push failed:', err));
  }

  const lastSyncAt = new Date().toISOString();
  await Preferences.set({ key: LAST_SYNC_KEY, value: lastSyncAt });
  return { applied, committed: committedBeforeSync || mergeCommitted, lastSyncAt, conflicts };
}

export function syncNow(): Promise<SyncResult> {
  return serialize(syncNowInternal);
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
// filesystem question, not a network one; whatever OS-level client keeps
// it synced does its own thing on its own schedule, so a fixed timer is
// all there is to trigger a re-check with. ──────────────────────────────

let watcherStarted = false;

export function startFolderSyncWatcher(intervalMs = 5 * 60_000): void {
  if (watcherStarted) return;
  watcherStarted = true;

  syncNow().catch((err) => console.error('SmartChef initial folder sync failed:', err));
  setInterval(() => {
    syncNow().catch((err) => console.error('SmartChef periodic folder sync failed:', err));
  }, intervalMs);

  import('@capacitor/app').then(({ App }) => {
    App.addListener('resume', () => {
      syncNow().catch((err) => console.error('SmartChef resume folder sync failed:', err));
    });
  }).catch(() => {});
}
