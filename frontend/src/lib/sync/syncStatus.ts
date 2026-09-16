// ════════════════════════════════════════════════════════════════════════
// SmartChef — "is a sync running, and did it just change anything?"
//
// Exists because first-run setup no longer waits for the library. The
// profile probe (firstRunProbe.ts) lets someone in after ~2.3 MB, and the
// recipes, ingredients and images arrive on the ordinary background sync
// afterwards — so for the first minute or two of a new device's life the
// gallery is legitimately empty and then legitimately fills in. Without a
// signal for that, an empty gallery is indistinguishable from a broken one,
// and a gallery that has quietly gained thirty recipes since it was
// rendered stays stale until something else happens to refetch.
//
// A plain module-level observable rather than a store slice or a window
// event: gitSync.ts is imported lazily (it pulls in isomorphic-git), so
// whatever publishes this has to be reachable without dragging that in,
// and subscribers are components that mount and unmount freely.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';

/** Owned here rather than in gitSync.ts so a screen can ask "has this
 *  device ever finished a sync?" without importing gitSync — which pulls
 *  in isomorphic-git, and is exactly the weight a gallery should not be
 *  loading to render a banner. gitSync.ts writes it. */
export const LAST_SYNC_KEY = 'smartchef.sync.lastSyncAt';

/** False only on a device that has never completed a cycle — i.e. one that
 *  has just been set up and whose library is genuinely still arriving.
 *  This is what separates "your recipes are on their way" from a routine
 *  five-minute tick, which must not put a banner in front of someone who
 *  is just browsing. */
export async function hasEverCompletedSync(): Promise<boolean> {
  const { value } = await Preferences.get({ key: LAST_SYNC_KEY });
  return !!value;
}

export interface SyncStatus {
  /** A sync cycle is in flight right now. */
  running: boolean;
  /** Bumped every time a cycle finishes having actually applied entities.
   *  A counter rather than a boolean so a subscriber can use it directly as
   *  a refetch trigger without needing to reset anything. */
  appliedRevision: number;
}

let status: SyncStatus = { running: false, appliedRevision: 0 };
const listeners = new Set<(s: SyncStatus) => void>();

function publish(next: SyncStatus): void {
  status = next;
  for (const listener of listeners) {
    try {
      listener(status);
    } catch (err) {
      // One bad subscriber must not stop the others being told.
      console.error('SmartChef: sync status listener failed:', err);
    }
  }
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: (s: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by gitSync.ts around each cycle. `appliedEntities` is how many
 *  rows the merge actually wrote — zero is the common case (a cycle with
 *  nothing new), and must NOT bump the revision, or every idle tick would
 *  refetch every open screen. */
export function reportSyncStarted(): void {
  publish({ ...status, running: true });
}

export function reportSyncFinished(appliedEntities: number): void {
  publish({
    running: false,
    appliedRevision: appliedEntities > 0 ? status.appliedRevision + 1 : status.appliedRevision,
  });
}

/** True when this device is still completing sync cycles but its uploads
 *  have stopped landing.
 *
 *  Deliberately requires a real gap between the two timestamps rather than
 *  treating "never pushed" as stale: a device that has genuinely never had
 *  anything to send would otherwise be accused of failing on its first
 *  launch. That case is covered by the pause banner instead, which now
 *  carries the actual reason.
 *
 *  A day of tolerance, because a healthy device advances the push timestamp
 *  on every cycle it has commits for — so anything approaching 24 hours
 *  behind is not a quiet period, it is a device whose pushes are failing. */
export const STALE_PUSH_MS = 24 * 60 * 60 * 1000;

export function stalePush(lastSyncAt: string | null, lastPushAt: string | null): boolean {
  if (!lastSyncAt || !lastPushAt) return false;
  const synced = Date.parse(lastSyncAt);
  const pushed = Date.parse(lastPushAt);
  if (Number.isNaN(synced) || Number.isNaN(pushed)) return false;
  return synced - pushed > STALE_PUSH_MS;
}
