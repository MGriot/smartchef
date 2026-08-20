// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone mode profile
// Standalone mode has no server and no password (each device's data is
// already private to whoever holds the device) — just a display name,
// used for "cooked by"/"created by" attribution, matching the multi-user
// server mode's account.name field in spirit without any of its auth
// machinery. Persisted via @capacitor/preferences, same as the server
// connection URL in lib/api.ts.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { initLocalSchema } from '../db/local';

const KEY = 'smartchef.standaloneProfile';

export interface StandaloneProfile {
  name: string;
}

let cached: StandaloneProfile | null | undefined; // undefined = not loaded yet

export async function getStandaloneProfile(): Promise<StandaloneProfile | null> {
  if (cached !== undefined) return cached;
  const { value } = await Preferences.get({ key: KEY });
  const resolved: StandaloneProfile | null = value ? JSON.parse(value) : null;
  cached = resolved;
  return resolved;
}

/** Initializes the local schema and persists the profile — call once, from
 *  the "Use offline on this device" first-run flow (ServerConnect.tsx).
 *
 *  wayfinder ticket 07 (standalone-storage-sync map): sync-folder selection
 *  used to happen as a side effect of this function, Electron-only (a bare
 *  native dialog with zero in-app copy, nothing at all on Android). That's
 *  now the calling UI's job instead — an explicit, symmetric "Sync across
 *  your devices" step on both platforms, using the same chooseElectron
 *  SyncFolder()/pickTree() calls Account.tsx's "Change Folder" button
 *  already used — so this function only ever provisions the profile and
 *  local schema, nothing folder-related. */
export async function initStandaloneProfile(name: string): Promise<void> {
  await initLocalSchema();
  const profile: StandaloneProfile = { name: name.trim() };
  cached = profile;
  await Preferences.set({ key: KEY, value: JSON.stringify(profile) });
}

export async function isStandaloneMode(): Promise<boolean> {
  return (await getStandaloneProfile()) !== null;
}

/** Renames the current standalone profile (Account page). Local data is
 *  untouched — this only changes the display name used for future "created
 *  by"/"cooked by" attribution, same as setDeviceName() in gitSync.ts is a
 *  separate, unrelated label for Folder Sync's device list. */
export async function setStandaloneName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const profile: StandaloneProfile = { name: trimmed };
  cached = profile;
  await Preferences.set({ key: KEY, value: JSON.stringify(profile) });
}

/** Forgets this device's standalone profile so the app falls back to the
 *  first-run "Connect to a server / Use offline" screen. Deliberately does
 *  NOT touch the local SQLite database (db/local.ts) or any Folder Sync
 *  state — this is "sign out of this device", not "erase this device's
 *  library". Setting the same or a different name back up afterward (via
 *  initStandaloneProfile()) sees the same data again, since initLocalSchema()
 *  is idempotent (CREATE TABLE IF NOT EXISTS) and never wipes existing rows. */
export async function clearStandaloneProfile(): Promise<void> {
  cached = null;
  await Preferences.remove({ key: KEY });
}
