// ════════════════════════════════════════════════════════════════════════
// SmartChef — Native offline sync orchestration
// Watches connectivity (device-level via @capacitor/network, plus an
// actual reachability probe against the configured server — "phone has
// WiFi" and "phone can reach my server" are different questions) and,
// whenever the server becomes reachable: replays the local outbox
// (pending_operations) against the real API in order, then re-pulls the
// full snapshot so the local cache reflects the authoritative post-merge
// state (including anything that changed on another device via folder
// sync in the meantime).
// ════════════════════════════════════════════════════════════════════════

import { Network } from '@capacitor/network';
import { apiFetch, isNative, getServerUrl } from './api';
import { cacheSnapshot, getPendingOperations, removePendingOperation } from './offlineStore';

let syncing = false;

export async function isServerReachable(): Promise<boolean> {
  const base = await getServerUrl();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pullSnapshot(): Promise<void> {
  const res = await apiFetch('/api/sync-folder/snapshot');
  const json = await res.json();
  await cacheSnapshot(json.data);
}

/** Replays queued writes in order; stops at the first failure so nothing
 *  gets applied out of order or silently dropped. */
export async function replayQueue(): Promise<{ replayed: number; remaining: number }> {
  const ops = await getPendingOperations();
  let replayed = 0;
  for (const op of ops) {
    try {
      const res = await fetch(`${await getServerUrl()}${op.path}`, {
        method: op.method,
        headers: op.body ? { 'Content-Type': 'application/json' } : undefined,
        body: op.body ?? undefined,
        credentials: 'include',
        signal: AbortSignal.timeout(10_000),
      });
      // A 4xx means the request itself is invalid (stale reference, etc.) —
      // replaying it again won't help, so drop it and move on rather than
      // blocking the rest of the queue forever. 5xx/network errors stop
      // the queue so it can be retried as a whole next time.
      if (!res.ok && res.status < 500) {
        await removePendingOperation(op.id);
        continue;
      }
      if (!res.ok) break;
      await removePendingOperation(op.id);
      replayed++;
    } catch {
      break;
    }
  }
  const remaining = (await getPendingOperations()).length;
  return { replayed, remaining };
}

export async function runOfflineSync(): Promise<void> {
  if (syncing || !isNative()) return;
  syncing = true;
  try {
    const reachable = await isServerReachable();
    if (!reachable) return;
    const { remaining } = await replayQueue();
    if (remaining === 0) await pullSnapshot();
  } catch (err) {
    console.warn('Offline sync cycle failed:', err);
  } finally {
    syncing = false;
  }
}

let watcherStarted = false;
const PERIODIC_SYNC_MS = 5 * 60_000;

export function startOfflineSyncWatcher(): void {
  if (!isNative() || watcherStarted) return;
  watcherStarted = true;
  Network.addListener('networkStatusChange', (status) => {
    if (status.connected) runOfflineSync();
  });
  // Reconnect events cover most cases, but a session that stays connected
  // for a long time with no network-status transition should still
  // periodically refresh the cache and flush anything queued.
  setInterval(runOfflineSync, PERIODIC_SYNC_MS);
  runOfflineSync();
}
