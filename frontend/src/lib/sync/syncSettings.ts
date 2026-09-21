// ════════════════════════════════════════════════════════════════════════
// SmartChef — Sync mode & settings (standalone mode)
//
// Two Sync Folder transports now exist: 'folder' (the original design — a
// plain folder mirrored by an external tool like Syncthing/OneDrive/Google
// Drive; the app hand-copies git's internal files, since none of those
// tools speak git) and 'git-remote' (a real git server — GitHub, GitLab,
// or self-hosted — reached over git's actual smart-HTTP push/fetch
// protocol, no external mirroring tool involved at all). See ADR 0001's
// 2026-08-23 update for why 'git-remote' exists: every bug that update
// documents (the ref race, incomplete SAF listings, Syncthing's
// conflict-copy renames) traces back to a file-sync tool touching git
// internals it doesn't understand — a real git remote removes that tool
// from the loop entirely, at the cost of needing a server to reach.
//
// 'folder' stays the default — existing installs keep working with zero
// migration needed; 'git-remote' is opt-in, chosen explicitly in Account →
// Folder Sync or during first-run setup.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import type { ConflictPolicy } from '../structuredMerge';

export type SyncMode = 'folder' | 'git-remote';

const MODE_KEY = 'smartchef.sync.mode';
const GIT_REMOTE_URL_KEY = 'smartchef.sync.gitRemote.url';
const GIT_REMOTE_USERNAME_KEY = 'smartchef.sync.gitRemote.username';
// Not a secret-store — Capacitor Preferences is plain on-device storage,
// same as every other setting in this file. Acceptable for a personal-use
// app the user's own device already trusts (matching this codebase's
// existing security bar — see e.g. the cloud LLM API keys, which server
// mode stores encrypted at rest specifically because they live in a
// shared Postgres database; this token lives only on the device that
// typed it in, no shared database involved). Flagged explicitly in the
// settings UI, not silently glossed over.
const GIT_REMOTE_TOKEN_KEY = 'smartchef.sync.gitRemote.token';
const GIT_REMOTE_CORS_PROXY_KEY = 'smartchef.sync.gitRemote.corsProxy';
// Why this device cannot upload, as learned by whichever check noticed
// first. Persisted rather than held in component state because the screen
// that DETECTS the problem (first-run setup, ServerConnect) is not the
// screen that can FIX it (Account -> Folder Sync) — before this, a rejected
// token was announced once during onboarding and then never mentioned
// again, while every push silently failed.
const GIT_REMOTE_ACCESS_PROBLEM_KEY = 'smartchef.sync.gitRemote.accessProblem';
const INTERVAL_VALUE_KEY = 'smartchef.sync.interval.value';
const INTERVAL_UNIT_KEY = 'smartchef.sync.interval.unit';
// Superseded by the value/unit pair above, kept only to read from: a
// device that saved an interval under this setting's very first shape
// (plain minutes, no unit) keeps that choice instead of silently
// reverting to the default the first time it loads this new code.
const LEGACY_INTERVAL_MINUTES_KEY = 'smartchef.sync.intervalMinutes';

// How a field both devices changed differently gets settled (ADR 0006).
// 'newest' — the default — keeps the side whose record was edited last,
// the way most people expect sync to behave; 'ask' records it in the
// Conflicts card for a manual pick. Either way, cases with an obvious
// answer (one side empty, both sides equal, tags added on both) never ask.
const CONFLICT_POLICY_KEY = 'smartchef.sync.conflictPolicy';

export type { ConflictPolicy };

// ── Library default vs per-device override ──────────────────────────────
// CONTEXT.md frames both the Conflict Policy and the auto-sync interval as
// per-device choices, and they stay that way: a phone on mobile data has
// every reason to sync less often than a desktop. But making each device
// set them from scratch is the friction this release is removing.
//
// So each gains a LIBRARY DEFAULT that travels as a synced setting, which
// a device follows unless it has one of its own. The presence of the
// Preferences key IS the override — no new flag, and every existing device
// is already in the overriding state, so nobody's behaviour changes on
// upgrade until they opt in.

/** Where a setting applies: only here, or everywhere in this library. */
export type SettingScope = 'device' | 'all-devices';

export async function getConflictPolicy(): Promise<ConflictPolicy> {
  const { value } = await Preferences.get({ key: CONFLICT_POLICY_KEY });
  if (value === 'ask' || value === 'newest') return value; // this device overrides
  const { getSetting, CONFLICT_POLICY_DEFAULT } = await import('../settingsRegistry');
  return getSetting<ConflictPolicy>(CONFLICT_POLICY_DEFAULT);
}

/** True when this device is deliberately ignoring the library default —
 *  so the settings screen can say so rather than looking inconsistent. */
export async function hasConflictPolicyOverride(): Promise<boolean> {
  const { value } = await Preferences.get({ key: CONFLICT_POLICY_KEY });
  return value === 'ask' || value === 'newest';
}

export async function setConflictPolicy(policy: ConflictPolicy, scope: SettingScope = 'device'): Promise<void> {
  if (scope === 'all-devices') {
    const { setSetting } = await import('../../services/settings.local');
    const { CONFLICT_POLICY_DEFAULT } = await import('../settingsRegistry');
    await setSetting(CONFLICT_POLICY_DEFAULT, policy);
    // Stop overriding, or this device would keep its old value while
    // telling every other device to use the new one.
    await Preferences.remove({ key: CONFLICT_POLICY_KEY });
    return;
  }
  await Preferences.set({ key: CONFLICT_POLICY_KEY, value: policy });
}

export async function getSyncMode(): Promise<SyncMode> {
  const { value } = await Preferences.get({ key: MODE_KEY });
  return value === 'git-remote' ? 'git-remote' : 'folder';
}

export async function setSyncMode(mode: SyncMode): Promise<void> {
  await Preferences.set({ key: MODE_KEY, value: mode });
}

export interface GitRemoteConfig {
  url: string;
  username: string | null;
  token: string | null;
  corsProxy: string | null;
}

/** null when no URL has been configured yet — the caller's cue to fall
 *  back to "not configured" the same way getElectronFolder()/getMirrorState()
 *  returning null already means "no folder-mode Sync Folder chosen yet". */
export async function getGitRemoteConfig(): Promise<GitRemoteConfig | null> {
  const { value: url } = await Preferences.get({ key: GIT_REMOTE_URL_KEY });
  if (!url) return null;
  const [{ value: username }, { value: token }, { value: corsProxy }] = await Promise.all([
    Preferences.get({ key: GIT_REMOTE_USERNAME_KEY }),
    Preferences.get({ key: GIT_REMOTE_TOKEN_KEY }),
    Preferences.get({ key: GIT_REMOTE_CORS_PROXY_KEY }),
  ]);
  return { url, username: username || null, token: token || null, corsProxy: corsProxy || null };
}

export interface GitRemoteConfigInput {
  url: string;
  username: string | null;
  /** undefined = leave whatever token is already stored untouched
   *  (the settings form's "leave blank to keep" save path); null or ""
   *  clears it; any other string sets it. Distinct from GitRemoteConfig's
   *  own `token`, which is always the actual current value on a read —
   *  a save needs this third "don't touch" state, a read never does. */
  token?: string | null;
  corsProxy: string | null;
}

export async function setGitRemoteConfig(config: GitRemoteConfigInput): Promise<void> {
  await Preferences.set({ key: GIT_REMOTE_URL_KEY, value: config.url });
  if (config.username) await Preferences.set({ key: GIT_REMOTE_USERNAME_KEY, value: config.username });
  else await Preferences.remove({ key: GIT_REMOTE_USERNAME_KEY });
  if (config.token !== undefined) {
    if (config.token) await Preferences.set({ key: GIT_REMOTE_TOKEN_KEY, value: config.token });
    else await Preferences.remove({ key: GIT_REMOTE_TOKEN_KEY });
    // A token the user just retyped has not been judged yet, so whatever
    // the last one was found guilty of no longer applies. Deliberately
    // inside this branch: a save that left the token untouched
    // (token === undefined) must not clear a still-accurate warning.
    await Preferences.remove({ key: GIT_REMOTE_ACCESS_PROBLEM_KEY });
  }
  if (config.corsProxy) await Preferences.set({ key: GIT_REMOTE_CORS_PROXY_KEY, value: config.corsProxy });
  else await Preferences.remove({ key: GIT_REMOTE_CORS_PROXY_KEY });
}

export async function clearGitRemoteConfig(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: GIT_REMOTE_URL_KEY }),
    Preferences.remove({ key: GIT_REMOTE_USERNAME_KEY }),
    Preferences.remove({ key: GIT_REMOTE_TOKEN_KEY }),
    Preferences.remove({ key: GIT_REMOTE_CORS_PROXY_KEY }),
    Preferences.remove({ key: GIT_REMOTE_ACCESS_PROBLEM_KEY }),
  ]);
}

/** Why this device cannot upload to the configured git remote.
 *
 *  Every value here means "reads may well be working, writes are not" —
 *  which is precisely the failure mode that went unnoticed: fetching a
 *  PUBLIC repository needs no credentials at all, so a device with a bad
 *  token syncs down perfectly and fails every push. */
export type GitRemoteAccessProblem =
  /** A token is configured and the server refused it outright. */
  | 'token-rejected'
  /** The server accepted the token but will not let it write. */
  | 'read-only'
  /** No token configured at all — fine for reading a public repo, fatal for
   *  every push. */
  | 'no-credentials'
  /** Cannot be a credential for this host — caught locally, before any
   *  request went out. See tokenShape.ts. */
  | 'malformed-token';

const ACCESS_PROBLEMS: readonly GitRemoteAccessProblem[] = [
  'token-rejected',
  'read-only',
  'no-credentials',
  'malformed-token',
];

/** null when this device has no known upload problem — either everything
 *  works, or nothing has checked yet. */
export async function getGitRemoteAccessProblem(): Promise<GitRemoteAccessProblem | null> {
  const { value } = await Preferences.get({ key: GIT_REMOTE_ACCESS_PROBLEM_KEY });
  // Checked against the union rather than trusted: an older build (or a hand-edited
  // preference) could hold a string this union no longer contains, and a
  // bad value here would drive the banner's copy lookup to undefined.
  return ACCESS_PROBLEMS.includes(value as GitRemoteAccessProblem) ? (value as GitRemoteAccessProblem) : null;
}

export async function setGitRemoteAccessProblem(problem: GitRemoteAccessProblem | null): Promise<void> {
  if (problem) await Preferences.set({ key: GIT_REMOTE_ACCESS_PROBLEM_KEY, value: problem });
  else await Preferences.remove({ key: GIT_REMOTE_ACCESS_PROBLEM_KEY });
}

export type SyncIntervalUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface SyncInterval {
  value: number;
  unit: SyncIntervalUnit;
}

// A fixed 30-day month, not calendar-accurate (no "the 15th of every
// month" scheduling here) — this only ever feeds a plain millisecond
// setInterval() duration (gitSync.ts's watcher), which has no concept of
// calendar months either. Good enough for "roughly once a month."
const UNIT_TO_MINUTES: Record<SyncIntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
  weeks: 7 * 24 * 60,
  months: 30 * 24 * 60,
};

export const DEFAULT_SYNC_INTERVAL: SyncInterval = { value: 5, unit: 'minutes' };
// Below this, a periodic timer competes with genuine work (image writes,
// commit/merge CPU) for no real benefit — external sync tools and git
// servers alike aren't going to have new data more often than this in
// normal use anyway.
export const MIN_SYNC_INTERVAL_MINUTES = 1;

function isSyncIntervalUnit(value: string): value is SyncIntervalUnit {
  return value === 'minutes' || value === 'hours' || value === 'days' || value === 'weeks' || value === 'months';
}

export function syncIntervalToMinutes(interval: SyncInterval): number {
  return Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(interval.value * UNIT_TO_MINUTES[interval.unit]));
}

export async function getSyncInterval(): Promise<SyncInterval> {
  const [{ value: rawValue }, { value: rawUnit }] = await Promise.all([
    Preferences.get({ key: INTERVAL_VALUE_KEY }),
    Preferences.get({ key: INTERVAL_UNIT_KEY }),
  ]);
  if (rawValue && rawUnit && isSyncIntervalUnit(rawUnit)) {
    const value = Number(rawValue);
    if (Number.isFinite(value) && value > 0) return { value, unit: rawUnit };
  }

  const { value: legacyMinutes } = await Preferences.get({ key: LEGACY_INTERVAL_MINUTES_KEY });
  if (legacyMinutes) {
    const value = Number(legacyMinutes);
    if (Number.isFinite(value) && value > 0) return { value, unit: 'minutes' };
  }

  // No override on this device: follow the library default (see above).
  const { getSetting, SYNC_INTERVAL_DEFAULT } = await import('../settingsRegistry');
  const shared = getSetting<{ value: number; unit: string }>(SYNC_INTERVAL_DEFAULT);
  if (shared && isSyncIntervalUnit(shared.unit) && Number.isFinite(shared.value) && shared.value > 0) {
    return { value: shared.value, unit: shared.unit };
  }

  return DEFAULT_SYNC_INTERVAL;
}

export async function hasSyncIntervalOverride(): Promise<boolean> {
  const [{ value: rawValue }, { value: rawUnit }] = await Promise.all([
    Preferences.get({ key: INTERVAL_VALUE_KEY }),
    Preferences.get({ key: INTERVAL_UNIT_KEY }),
  ]);
  return !!(rawValue && rawUnit && isSyncIntervalUnit(rawUnit));
}

export async function setSyncInterval(interval: SyncInterval, scope: SettingScope = 'device'): Promise<void> {
  const value = Math.max(1, interval.value);
  if (scope === 'all-devices') {
    const { setSetting } = await import('../../services/settings.local');
    const { SYNC_INTERVAL_DEFAULT } = await import('../settingsRegistry');
    await setSetting(SYNC_INTERVAL_DEFAULT, { value, unit: interval.unit });
    await Preferences.remove({ key: INTERVAL_VALUE_KEY });
    await Preferences.remove({ key: INTERVAL_UNIT_KEY });
    return;
  }
  await Preferences.set({ key: INTERVAL_VALUE_KEY, value: String(value) });
  await Preferences.set({ key: INTERVAL_UNIT_KEY, value: interval.unit });
}

/** gitSync.ts's watcher only ever needs a millisecond duration and has no
 *  reason to know which unit the user picked it in — this is its one
 *  entry point into this setting. */
export async function getSyncIntervalMinutes(): Promise<number> {
  return syncIntervalToMinutes(await getSyncInterval());
}
