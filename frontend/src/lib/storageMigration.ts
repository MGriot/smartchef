// ════════════════════════════════════════════════════════════════════════
// SmartChef — Moving the library between offline storage and a server
//
// Both directions are a COPY, never a move: the source library is left
// exactly as it was, so switching back lands on the same data and a
// migration that goes wrong is never the only copy of anything. The
// destination MERGES the snapshot in (newest wins per item, matched by id)
// rather than being wiped first — the same behavior the Backup & Restore
// card already documents, and the same tested code paths:
//
//   offline → server   services/backup.local.ts exportSnapshot()
//                      → POST {server}/api/backup/import  (folder-sync's mergeSnapshot)
//   server → offline   GET {server}/api/backup/export     (folder-sync's buildFullSnapshot)
//                      → services/backup.local.ts importSnapshot()
//
// The two snapshot formats are the same format — backup.local.ts is
// written against backend/src/services/folder-sync.service.ts's Snapshot
// shape on purpose — which is why this module is mostly plumbing.
//
// Native only. On web there is no local SQLite library and no configurable
// server URL, so there is nothing to move between.
// ════════════════════════════════════════════════════════════════════════

import { setServerUrl } from './api';

/** Trailing slashes stripped; a bare host gets https:// so "box.ts.net"
 *  works as typed. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  if (res.status === 413) {
    return 'The library is larger than the server accepts in one request (its JSON body limit is 5 MB). Export a backup from here and restore it on the server by hand instead.';
  }
  try {
    const json = await res.json();
    if (typeof json?.error === 'string') return json.error;
  } catch {
    /* non-JSON body — fall through */
  }
  return `${fallback} (HTTP ${res.status})`;
}

/** Confirms something SmartChef-shaped is answering at `url` before any
 *  data is moved, and reports whether it has been set up yet. */
export async function probeServer(url: string): Promise<{ hasAccount: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/auth/status`, { credentials: 'include' });
  } catch {
    throw new Error("Couldn't reach that address. Check the URL, and that Tailscale/the LAN is connected.");
  }
  if (!res.ok) throw new Error(await readError(res, 'That server rejected the request'));
  const json = await res.json().catch(() => null);
  if (!json?.data || typeof json.data.hasAccount !== 'boolean') {
    throw new Error("That address answered, but it doesn't look like a SmartChef server.");
  }
  return { hasAccount: json.data.hasAccount };
}

export interface MigrationSummary {
  categories: number;
  tools: number;
  techniques: number;
  tags: number;
  ingredients: number;
  recipes: number;
  conflicts?: string[];
}

/**
 * Offline → server. Signs in to the destination (the session cookie it
 * sets is the one the app keeps using afterward), copies this device's
 * local library up, and only then repoints the device at the server.
 *
 * Ordering matters: the switch is the LAST step, so a failed login or a
 * rejected import leaves the device exactly where it started — still
 * offline, still holding its own library — instead of stranded pointing at
 * a server it never managed to populate.
 */
export async function migrateOfflineToServer(opts: {
  url: string;
  username: string;
  password: string;
  onStage?: (stage: string) => void;
}): Promise<MigrationSummary> {
  const url = normalizeServerUrl(opts.url);

  opts.onStage?.('Checking the server…');
  await probeServer(url);

  opts.onStage?.('Signing in…');
  const loginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: opts.username.trim().toLowerCase(), password: opts.password }),
  });
  if (!loginRes.ok) throw new Error(await readError(loginRes, 'Sign-in failed'));

  opts.onStage?.('Packing up this device’s library…');
  const { exportSnapshot } = await import('../services/backup.local');
  const snapshot = await exportSnapshot();

  opts.onStage?.('Copying it to the server…');
  const importRes = await fetch(`${url}/api/backup/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(snapshot),
  });
  if (!importRes.ok) throw new Error(await readError(importRes, 'The server refused the import'));
  const summary = (await importRes.json()).data as MigrationSummary;

  opts.onStage?.('Switching this device over…');
  await setServerUrl(url);
  // Leaves the local SQLite library and any Sync Folder wiring untouched —
  // this only stops the app routing through them.
  const { clearStandaloneProfile } = await import('./standalone');
  await clearStandaloneProfile();

  return summary;
}

/**
 * Server → offline. Pulls the whole library down (this device is already
 * authenticated, so it reuses the session it has), merges it into local
 * SQLite, and switches over with no profile selected — the app comes back
 * up on "who's cooking?".
 *
 * Same ordering rule: nothing about this device changes until the data has
 * actually landed locally.
 */
export async function migrateServerToOffline(opts: {
  onStage?: (stage: string) => void;
} = {}): Promise<MigrationSummary> {
  const { apiFetch } = await import('./api');

  opts.onStage?.('Downloading the library…');
  // Images are embedded by the server's exporter, so this can be large and
  // slow; the 10s native default would abort a real library mid-download.
  const res = await apiFetch('/api/backup/export', { timeoutMs: 300_000 });
  if (!res.ok) throw new Error(await readError(res, 'Export failed'));
  const snapshot = (await res.json()).data;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('The server sent back something that is not a library snapshot.');
  }

  opts.onStage?.('Saving it on this device…');
  const { initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  const { importSnapshot } = await import('../services/backup.local');
  const summary = await importSnapshot(snapshot);

  opts.onStage?.('Switching this device over…');
  const { enableStandaloneMode } = await import('./standalone');
  await enableStandaloneMode();

  return summary as MigrationSummary;
}
