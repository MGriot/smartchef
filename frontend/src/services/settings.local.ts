// ════════════════════════════════════════════════════════════════════════
// SmartChef — settings that travel between a user's own devices
//
// Until now nothing in this app's preferences crossed a device boundary.
// Themes, languages, measurement system and the chosen LLM provider had to
// be set up again on every device, which for a two-device household meant
// the second device never quite matched the first.
//
// Each setting is one row in `settings`, and each row is an Entity File
// like any recipe — so a preference merges, fast-forwards and tombstones
// through exactly the machinery that already exists, with no special case
// anywhere in conflicts.local.ts. The setting KEY is the row id, which
// makes these portable ids by construction: two devices that both set a
// theme are editing the same row, not creating two.
//
// ── What is deliberately NOT here ───────────────────────────────────────
// Nothing that is a credential, and nothing that describes THIS DEVICE
// rather than this library:
//
//   every smartchef.llm.*Key      an API key in a git history is a leak,
//                                 and one that is very hard to take back
//   smartchef.llm.ollamaUrl       a per-device network address
//   smartchef.sync.gitRemote.*    URL, username and token — the Setup File
//                                 (lib/setupConfigFile.ts) exists for
//                                 exactly this, encrypted, and is the only
//                                 sanctioned way a token moves
//   deviceId / deviceName         identity, one per device, never synced
//   lastSyncAt / lastPushAt       observations about this device
//   activeProfileId               which person is using THIS device now
//   cookProgress / shoppingCart   in-flight state, not a preference
//
// Also left per-device on purpose: gallery column count and the per-section
// library view/sort. Those are window-shaped rather than taste-shaped — a
// phone and a desktop genuinely want different answers — so syncing them
// would make one device worse to satisfy the other.
//
// ── Why there is a cache in front ───────────────────────────────────────
// See lib/settingsCache.ts: the theme and UI language are read before
// SQLite is open, so localStorage stays as a synchronous write-ahead cache
// and this module reconciles the two in both directions at hydration.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { query, queryOne } from '../db/local';
import { listCachedSettings, replaceCachedSettings, writeCachedSetting } from '../lib/settingsCache';
import { SYNCED_SETTINGS, specFor, isSyncedSetting } from '../lib/settingsRegistry';

// Re-exported so a caller that already touches the database imports one
// module, not two. The registry itself is dependency-free on purpose —
// see lib/settingsRegistry.ts.
export {
  SYNCED_SETTINGS, isSyncedSetting, getSetting,
  THEME_MODE, ACCENT_SCHEME, MEASUREMENT_SYSTEM, CUSTOM_LANGUAGES, HIDDEN_LANGUAGES,
  LLM_PROVIDER, CONFLICT_POLICY_DEFAULT, SYNC_INTERVAL_DEFAULT,
} from '../lib/settingsRegistry';
export type { SettingSpec } from '../lib/settingsRegistry';

/** Bumped when a later release adds keys that should be imported from a
 *  device's legacy storage. Same pattern as gitSync.ts's RESERIALIZE_KEY. */
const LEGACY_IMPORT_KEY = 'smartchef.settings.importedVersion';
const LEGACY_IMPORT_VERSION = '1';

/** Writes the cache first (so a synchronous read right after sees it, and
 *  a crash before the database write does not lose it), then the row,
 *  then publishes the Entity File. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  const spec = specFor(key);
  if (!spec) throw new Error(`setSetting: '${key}' is not a synced setting`);
  const parsed = spec.parse(value);
  writeCachedSetting(key, parsed);
  await query(
    `INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, deleted_at = NULL, updated_at = now()`,
    [key, JSON.stringify(parsed)]
  );
  await syncSetting(key);
}

/** Publishes one setting's Entity File. Mirrors ingredients.local.ts's
 *  syncTool() — never throws into the caller, because a preference change
 *  must not fail just because the Sync Folder is unreachable. */
export async function syncSetting(key: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>(`SELECT * FROM settings WHERE id = $1`, [key]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('settings', key, row);
  } catch (err) {
    console.error('SmartChef sync (setting) failed:', err);
  }
}

export async function resyncAllSettings(): Promise<number> {
  const rows = await query<{ id: string }>(`SELECT id FROM settings`);
  for (const row of rows) await syncSetting(row.id);
  return rows.length;
}

// ── Hydration ───────────────────────────────────────────────────────────

/** Reconciles the cache and the database in BOTH directions:
 *
 *   database -> cache  a setting another device changed, applied here;
 *   cache -> database  a value written while the database was unavailable
 *                      (a crash between the two writes, or a first run on
 *                      a device whose legacy import has not run yet).
 *
 *  The second direction is what makes the cache a write-ahead log rather
 *  than a mirror, and is why a setting cannot be silently lost by the
 *  ordering inside setSetting().
 *
 *  Returns the keys whose value changed, so the caller can re-apply just
 *  those. */
export async function hydrateSettings(): Promise<string[]> {
  const rows = await query<{ id: string; value: string | null; deleted_at: string | null }>(
    `SELECT id, value, deleted_at FROM settings`
  );
  const fromDb: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.deleted_at) continue; // reset to the default, per the Deletion Marker
    const spec = specFor(row.id);
    if (!spec) continue; // a key this build does not know: leave it be
    try {
      fromDb[row.id] = spec.parse(row.value === null ? null : JSON.parse(row.value));
    } catch {
      /* unparseable row — the fallback is a better answer than a crash */
    }
  }

  const cached = listCachedSettings();
  const ahead = Object.keys(cached).filter((key) => isSyncedSetting(key) && !(key in fromDb));
  for (const key of ahead) {
    const spec = specFor(key)!;
    const value = spec.parse(cached[key]);
    fromDb[key] = value;
    await query(
      `INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    await syncSetting(key);
  }

  return replaceCachedSettings(fromDb);
}

/** Same reconciliation, after a sync cycle has written other devices'
 *  rows — so a preference changed elsewhere lands without a restart. */
export async function refreshSettingsAfterSync(): Promise<string[]> {
  return hydrateSettings();
}

// ── One-time import of what this device already had ─────────────────────

function readLocal(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // plain strings were never JSON-encoded
    }
  } catch {
    return undefined;
  }
}

/** Moves this device's existing preferences into the synced store, exactly
 *  once.
 *
 *  The anti-clobber rule is simply: A ROW THAT ALREADY EXISTS IS NEVER
 *  TOUCHED. If another device has already published a theme, that theme
 *  wins and this device's local value is abandoned rather than racing it.
 *  The legacy keys are left in place, so this is reversible by downgrade.
 *
 *  Which makes WHEN this runs load-bearing: gitSync calls it AFTER a sync
 *  cycle, so a device with a remote has already pulled whatever the others
 *  published and the rule above has something to see. A device with no
 *  remote configured imports immediately from hydrateSettings(). */
export async function importLegacySettingsOnce(): Promise<number> {
  const { value: done } = await Preferences.get({ key: LEGACY_IMPORT_KEY });
  if (done === LEGACY_IMPORT_VERSION) return 0;

  let imported = 0;
  const candidates: Array<{ key: string; value: unknown }> = [];

  for (const spec of SYNCED_SETTINGS) {
    if (!spec.legacy || spec.key.includes('*')) continue;
    const raw = spec.legacy.store === 'local'
      ? readLocal(spec.legacy.key)
      : (await Preferences.get({ key: spec.legacy.key })).value ?? undefined;
    if (raw === undefined || raw === null) continue;
    candidates.push({ key: spec.key, value: raw });
  }

  // Per-profile language keys are `smartchef.<profileId>.uiLang`, so they
  // have to be found rather than looked up.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const stored = localStorage.key(i);
      const match = stored?.match(/^smartchef\.([^.]+)\.(uiLang|contentLang)$/);
      if (!match || match[1] === 'llm' || match[1] === 'sync' || match[1] === 'library') continue;
      const raw = readLocal(stored!);
      if (typeof raw === 'string' && raw) candidates.push({ key: `profile.${match[1]}.${match[2]}`, value: raw });
    }
  } catch {
    /* storage blocked — nothing to import from it */
  }

  // The LLM model overrides, one Preferences key per provider.
  for (const provider of ['ollama', 'anthropic', 'gemini', 'openai']) {
    const { value } = await Preferences.get({ key: `smartchef.llm.${provider}Model` });
    if (value) candidates.push({ key: `llm.model.${provider}`, value });
  }

  for (const candidate of candidates) {
    const spec = specFor(candidate.key);
    if (!spec) continue;
    if (await queryOne(`SELECT id FROM settings WHERE id = $1`, [candidate.key])) continue; // another device got here first
    const parsed = spec.parse(candidate.value);
    await query(`INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, now())`, [candidate.key, JSON.stringify(parsed)]);
    writeCachedSetting(candidate.key, parsed);
    await syncSetting(candidate.key);
    imported++;
  }

  await Preferences.set({ key: LEGACY_IMPORT_KEY, value: LEGACY_IMPORT_VERSION });
  return imported;
}
