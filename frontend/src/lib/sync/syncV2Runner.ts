// ════════════════════════════════════════════════════════════════════════
// SmartChef — running sync v2 in the app, and moving a device onto it
// (docs/plans/2026-11-01-sync-v2-change-log.md, phases 2–3)
//
// gitSync.syncNow() hands over to syncNowV2() once this device's engine is
// 'v2' (syncSettings.ts getSyncEngine), so every existing trigger — start-
// up, the interval, resume, the Sync Now button — runs the new cycle with
// no change of its own, and the result keeps the SyncResult shape the
// status banner and Account page already read.
//
// Moving onto v2 (switchToSyncV2):
//   1. one last git sync, so this device starts from what the others have;
//   2. the change log is switched on and the engine set to 'v2';
//   3. the whole library is re-serialized once — every entity through
//      writeEntityFile(), which now records it — so the log starts with a
//      full picture of this device rather than only future edits;
//   4. a first v2 cycle publishes it and reads any device that moved first.
// Devices move one at a time; values every device already agrees on are
// equal and merge silently, so the first v2 cycles only settle what the
// git era had not.
//
// The store is the same place the git era syncs through: the Sync Folder,
// under its own `smartchef-v2/` root (lib/changeLog/store.ts), or the same
// git server, on its own `smartchef-v2` branch (lib/changeLog/gitStore.ts).
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { storeFromTransport, type SyncStore } from '../changeLog/store';
import { openLibraryStore, type Keyring } from '../changeLog/libraryStore';
import { defaultImageFs } from '../localImages';
import {
  getConflictPolicy, getEncryptNewLibrary, getGitRemoteConfig, getLibraryKey, getSyncMode, getWebDavConfig, setLibraryKey, setSyncEngine,
} from './syncSettings';

/** This device's library key, kept in its settings. */
export const deviceKeyring: Keyring = { get: getLibraryKey, set: setLibraryKey, encryptNew: getEncryptNewLibrary };
import { reportSyncFinished, reportSyncStarted, LAST_SYNC_KEY } from './syncStatus';
import type { SyncResult } from './gitSync';

/** The store this device syncs through, or null when none is set up. */
export async function getV2Store(): Promise<SyncStore | null> {
  const mode = await getSyncMode();
  if (mode === 'webdav') {
    const config = await getWebDavConfig();
    if (!config) return null;
    const { createWebDavStore } = await import('../changeLog/webdavStore');
    return createWebDavStore(config);
  }
  if (mode === 'git-remote') {
    const config = await getGitRemoteConfig();
    if (!config) return null;
    const [{ gitfs }, { getHiddenCloneDir }, { createGitStore }, { isomorphicGitRemote }, { getDeviceName }] = await Promise.all([
      import('../gitfs'), import('./hiddenClone'), import('../changeLog/gitStore'), import('../changeLog/gitStoreRemote'), import('./gitSync'),
    ]);
    // Its own small repository beside the Hidden Clone, never inside it.
    const dir = `${(await getHiddenCloneDir()).replace(/\/+$/, '')}-v2`;
    const gitdir = `${dir}/.git`;
    return createGitStore({ fs: gitfs, dir, gitdir, remote: isomorphicGitRemote(gitfs, dir, gitdir, config), message: `Sync from ${await getDeviceName()}` });
  }
  const { getConfiguredRemoteTransport } = await import('./gitSync');
  const transport = await getConfiguredRemoteTransport();
  return transport ? storeFromTransport(transport) : null;
}

export async function syncNowV2(): Promise<SyncResult> {
  const { getDeviceId, getDeviceName } = await import('./gitSync');
  const { syncOnceV2 } = await import('../../services/syncV2.local');
  const lastSyncAt = new Date().toISOString();
  const result: SyncResult = {
    applied: 0, appliedByType: {}, committed: false, lastSyncAt, conflicts: 0, autoResolved: 0,
    pushedObjects: 0, pulledObjects: 0, failedEntities: [], stuck: 0, entityScanCounts: {},
  };

  await publishRowsAhead();
  const raw = await getV2Store();
  if (!raw) return result;
  const store = openLibraryStore(raw, deviceKeyring);

  reportSyncStarted();
  try {
    const report = await syncOnceV2(store, {
      device: await getDeviceId(), deviceName: await getDeviceName(), policy: await getConflictPolicy(), images: defaultImageFs(),
    });
    result.applied = report.pulledChanges;
    result.conflicts = report.conflicts;
    result.pushedObjects = report.pushedChanges + report.imagesUploaded;
    result.pulledObjects = report.pulledChanges + report.imagesDownloaded;
    result.failedEntities = report.failed;
    if (report.incompleteDevices.length > 0) {
      console.info(`SmartChef: still waiting on part of the log of ${report.incompleteDevices.length} device(s) — the next sync continues`);
    }
    await Preferences.set({ key: LAST_SYNC_KEY, value: lastSyncAt });
  } finally {
    reportSyncFinished(result.applied);
  }

  try {
    const { autoResolvePendingConflicts } = await import('../../services/conflicts.local');
    result.autoResolved = (await autoResolvePendingConflicts(await getConflictPolicy())).resolved;
  } catch (err) {
    console.warn('SmartChef: auto-resolving pending conflicts failed:', err);
  }
  try {
    const { importLegacySettingsOnce, refreshSettingsAfterSync } = await import('../../services/settings.local');
    await importLegacySettingsOnce();
    await refreshSettingsAfterSync();
  } catch (err) {
    console.warn('SmartChef: refreshing synced settings failed:', err);
  }
  return result;
}

/** Rows changed without going through writeEntityFile (bulk SQL, a merge
 *  tool) are recorded before the cycle, so they travel in it. */
async function publishRowsAhead(): Promise<void> {
  try {
    const { publishRowsAheadOfRepo } = await import('../../services/syncReconcile.local');
    await publishRowsAheadOfRepo();
  } catch (err) {
    console.warn('SmartChef: recording local changes before sync failed:', err);
  }
}

/** Every entity, once, through writeEntityFile() — which records it into
 *  the change log once the engine is 'v2'. */
export async function recordWholeLibrary(): Promise<void> {
  const [ingredients, { resyncAllRecipes }, { resyncAllTags }, { resyncAllTechniques }, { resyncAllProfiles }, { resyncAllSettings }] = await Promise.all([
    import('../../services/ingredients.local'),
    import('../../services/recipes.local'),
    import('../../services/tags.local'),
    import('../../services/techniques.local'),
    import('../../services/profiles.local'),
    import('../../services/settings.local'),
  ]);
  await resyncAllSettings();
  await ingredients.resyncAllCategories();
  await ingredients.resyncAllUnits();
  await resyncAllTags();
  await ingredients.resyncAllTools();
  await resyncAllTechniques();
  await ingredients.resyncAllIngredients();
  await resyncAllProfiles();
  await resyncAllRecipes();
}

/** Moves this device onto sync v2. See the header for the steps. */
export async function switchToSyncV2(): Promise<SyncResult> {
  const gitSync = await import('./gitSync');
  try {
    await gitSync.syncNow();
  } catch (err) {
    // A last git sync is a courtesy, not a requirement: the v2 merge settles
    // anything the git era had not.
    console.warn('SmartChef: last git sync before switching failed:', err);
  }
  const { setChangeLogEnabled } = await import('../../services/changeLog.local');
  await setChangeLogEnabled(true);
  await setSyncEngine('v2');
  await recordWholeLibrary();
  return syncNowV2();
}

/** Back to the git engine on this device. The change log is kept (and
 *  stops recording), so switching forward again resumes where it was.
 *  Not available on WebDAV, which only v2 can sync through. */
export async function switchBackToGit(): Promise<void> {
  if ((await getSyncMode()) === 'webdav') throw new Error('WebDAV syncs only with the new engine. Pick a Sync Folder or a git server first.');
  const { setChangeLogEnabled } = await import('../../services/changeLog.local');
  await setSyncEngine('git');
  await setChangeLogEnabled(false);
}
