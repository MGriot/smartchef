// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone mode profiles
// Standalone mode has no password (each device's data is already private
// to whoever holds it) — but it does now support more than one named
// profile per shared library, since a household sharing one Sync Folder is
// exactly the case a single hardcoded per-device name doesn't cover. Two
// genuinely different things live here:
//   - WHICH PROFILES EXIST — a synced entity (services/profiles.local.ts,
//     its own `profiles` table, written through Folder Sync like any other
//     entity) so a profile created on one device is pickable on every
//     other device sharing the same folder.
//   - WHICH PROFILE *THIS DEVICE* IS CURRENTLY USING — a plain, deliberately
//     unsynced Preferences pointer (activeProfileId), same spirit as
//     gitSync.ts's own device id/name. Switching it is instant and
//     per-device on purpose: two people sharing a desktop pick different
//     profiles at different times without that choice leaking anywhere else.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { initLocalSchema } from '../db/local';

const ENABLED_KEY = 'smartchef.standaloneEnabled';
const ACTIVE_PROFILE_KEY = 'smartchef.activeProfileId';
// Pre-multi-profile shape ({name, avatarUrl}), still read (never written
// again) so a device that set up standalone mode before profiles existed
// doesn't get silently signed out — see migrateLegacyProfileIfNeeded().
const LEGACY_PROFILE_KEY = 'smartchef.standaloneProfile';

export interface StandaloneProfile {
  id: string;
  name: string;
  avatarUrl?: string;
  role?: 'admin' | 'user';
}

let cachedEnabled: boolean | undefined; // undefined = not loaded yet
let cachedActiveId: string | null | undefined; // undefined = not loaded yet

/** Whether this device has ever completed standalone first-run setup —
 *  independent of whether a profile is currently active on it (a device
 *  can be standalone-enabled with nobody picked yet, right after "Switch
 *  Profile" or on a device that just joined an existing Sync Folder).
 *  apiFetch() (lib/api.ts) gates local-router dispatch on this, not on an
 *  active profile — the local database and its routing exist independent
 *  of who's currently using the device. */
export async function isStandaloneMode(): Promise<boolean> {
  if (cachedEnabled !== undefined) return cachedEnabled;
  const { value } = await Preferences.get({ key: ENABLED_KEY });
  if (value === 'true') {
    cachedEnabled = true;
    return true;
  }
  const legacy = await Preferences.get({ key: LEGACY_PROFILE_KEY });
  cachedEnabled = !!legacy.value;
  return cachedEnabled;
}

/** One-time upgrade for a device that set up standalone mode before
 *  profiles existed: turns its old single {name, avatarUrl} blob into a
 *  real (synced) profile row and makes it this device's active profile —
 *  so upgrading the app never reads as "you've been signed out." Runs at
 *  most once per device (guarded by ACTIVE_PROFILE_KEY already being set),
 *  and only when there's legacy data to migrate at all.
 *
 *  Deliberately swallows its own errors: this runs inline in every app
 *  launch's path to getActiveProfileId(), and a device whose one-time
 *  migration hits a genuine failure (a write error, a race) must still
 *  reach the profile picker afterward instead of hanging on the loading
 *  spinner forever — worst case here is "create your profile again,"
 *  never "app won't start." */
async function migrateLegacyProfileIfNeeded(): Promise<void> {
  try {
    const { value: activeIdValue } = await Preferences.get({ key: ACTIVE_PROFILE_KEY });
    if (activeIdValue) return;
    const { value: legacyValue } = await Preferences.get({ key: LEGACY_PROFILE_KEY });
    if (!legacyValue) return;

    const legacy = JSON.parse(legacyValue) as { name?: string; avatarUrl?: string };
    if (!legacy.name) return;

    await initLocalSchema();
    const { createProfile } = await import('../services/profiles.local');
    const profile = await createProfile(legacy.name, legacy.avatarUrl ?? null);
    cachedActiveId = profile.id;
    await Preferences.set({ key: ACTIVE_PROFILE_KEY, value: profile.id });
    await Preferences.set({ key: ENABLED_KEY, value: 'true' });
    cachedEnabled = true;
  } catch (err) {
    console.error('SmartChef: legacy standalone profile migration failed:', err);
  }
}

/** This device's currently-active profile id, or null if nobody's picked
 *  one yet (a fresh standalone-enabled device, or one that just switched
 *  profiles) — callers wanting the full row should use getActiveProfile(). */
export async function getActiveProfileId(): Promise<string | null> {
  if (cachedActiveId !== undefined) return cachedActiveId;
  await migrateLegacyProfileIfNeeded();
  const { value } = await Preferences.get({ key: ACTIVE_PROFILE_KEY });
  cachedActiveId = value ?? null;
  return cachedActiveId;
}

export async function getActiveProfile(): Promise<StandaloneProfile | null> {
  const id = await getActiveProfileId();
  if (!id) return null;
  const { getProfile } = await import('../services/profiles.local');
  const row = await getProfile(id);
  if (!row) return null;
  return { id: row.id, name: row.name, avatarUrl: row.avatar_url ?? undefined, role: row.role };
}

/** Kept for existing callers (localRouter.ts's creator_name/cooked_by_name
 *  attribution) that only ever needed the name/avatar, not the id — same
 *  shape the pre-multi-profile version of this module returned. */
export async function getStandaloneProfile(): Promise<{ name: string; avatarUrl?: string } | null> {
  const profile = await getActiveProfile();
  return profile ? { name: profile.name, avatarUrl: profile.avatarUrl } : null;
}

/** Every profile on this shared library, for the profile-picker screen —
 *  pulled from Local Storage, so it reflects whatever the last sync (if
 *  any) brought in from other devices, not just this device's own. */
export async function listStandaloneProfiles(): Promise<StandaloneProfile[]> {
  const { listProfiles } = await import('../services/profiles.local');
  const rows = await listProfiles();
  return rows.map((r) => ({ id: r.id, name: r.name, avatarUrl: r.avatar_url ?? undefined, role: r.role }));
}

/** First-run: initializes the local schema, marks standalone mode enabled,
 *  and creates + activates a brand-new profile. Call from the "Use offline
 *  on this device" flow (ServerConnect.tsx) when the chosen Sync Folder (if
 *  any) turned out to have no existing profiles to pick from instead. */
export async function initStandaloneProfile(name: string, avatarUrl?: string | null): Promise<StandaloneProfile> {
  await initLocalSchema();
  await Preferences.set({ key: ENABLED_KEY, value: 'true' });
  cachedEnabled = true;
  const { createProfile } = await import('../services/profiles.local');
  const profile = await createProfile(name, avatarUrl ?? null);
  cachedActiveId = profile.id;
  await Preferences.set({ key: ACTIVE_PROFILE_KEY, value: profile.id });
  return { id: profile.id, name: profile.name, avatarUrl: profile.avatar_url ?? undefined };
}

/** Switches this device to an already-existing profile — the profile
 *  picker's "that's me" action, and ServerConnect.tsx's path when a
 *  freshly-chosen Sync Folder already has profiles synced in from other
 *  devices. Marks standalone mode enabled too (a device picking a profile
 *  here is, by definition, choosing to use this device standalone), and
 *  initializes the local schema — safe/idempotent either way. */
export async function activateStandaloneProfile(id: string): Promise<void> {
  await initLocalSchema();
  await Preferences.set({ key: ENABLED_KEY, value: 'true' });
  cachedEnabled = true;
  cachedActiveId = id;
  await Preferences.set({ key: ACTIVE_PROFILE_KEY, value: id });
}

/** Adds a new profile to the shared library and makes it this device's
 *  active one — the picker's "+ New Profile" action for a device that's
 *  already standalone-enabled (as opposed to initStandaloneProfile(),
 *  first-run's equivalent). */
export async function createAndActivateProfile(name: string, avatarUrl?: string | null): Promise<StandaloneProfile> {
  const { createProfile } = await import('../services/profiles.local');
  const profile = await createProfile(name, avatarUrl ?? null);
  await activateStandaloneProfile(profile.id);
  return { id: profile.id, name: profile.name, avatarUrl: profile.avatar_url ?? undefined };
}

/** Clears which profile this device is using, without leaving standalone
 *  mode or touching any local data — brings back the profile picker on
 *  next load. This is "Switch Profile," distinct from clearStandaloneProfile()
 *  below ("forget this device entirely"). */
export async function clearActiveProfile(): Promise<void> {
  cachedActiveId = null;
  await Preferences.remove({ key: ACTIVE_PROFILE_KEY });
}

/** Renames the currently-active profile (Account page). */
export async function setStandaloneName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const id = await getActiveProfileId();
  if (!id) return;
  const current = await getActiveProfile();
  const { updateProfile } = await import('../services/profiles.local');
  await updateProfile(id, trimmed, current?.avatarUrl ?? null);
}

/** Sets the currently-active profile's avatar (Account page). */
export async function setStandaloneAvatar(avatarUrl: string): Promise<void> {
  const id = await getActiveProfileId();
  if (!id) return;
  const current = await getActiveProfile();
  const { updateProfile } = await import('../services/profiles.local');
  await updateProfile(id, current?.name ?? '', avatarUrl || null);
}

/** Forgets this device's standalone setup entirely so the app falls back
 *  to the first-run "Connect to a server / Use offline" screen. Deliberately
 *  does NOT touch the local SQLite database (db/local.ts), any profile row,
 *  or any Folder Sync state — this is "sign this device out of standalone
 *  mode," not "erase this device's library" or "delete my profile."
 *  Starting standalone mode back up afterward sees the same data (and the
 *  same profiles, pickable again) since initLocalSchema() never wipes
 *  existing rows. */
export async function clearStandaloneProfile(): Promise<void> {
  cachedEnabled = false;
  cachedActiveId = null;
  await Preferences.remove({ key: ENABLED_KEY });
  await Preferences.remove({ key: ACTIVE_PROFILE_KEY });
  await Preferences.remove({ key: LEGACY_PROFILE_KEY });
}

/** Promotes/demotes another profile — Account page's admin-only profile
 *  list. Guards (last-admin, self-demote) live in profiles.local.ts; this
 *  just supplies "who's asking" from the active-profile pointer. */
export async function setProfileRole(id: string, role: 'admin' | 'user'): Promise<void> {
  const actingId = await getActiveProfileId();
  const { updateProfileRole } = await import('../services/profiles.local');
  await updateProfileRole(id, role, actingId);
}

/** Deletes another profile (soft-delete) — Account page's admin-only
 *  profile list. Guards (active-profile, last-admin) live in
 *  profiles.local.ts. */
export async function removeProfile(id: string): Promise<void> {
  const actingId = await getActiveProfileId();
  const { deleteProfile } = await import('../services/profiles.local');
  await deleteProfile(id, actingId);
}
