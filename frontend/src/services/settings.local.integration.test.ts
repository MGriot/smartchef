// ════════════════════════════════════════════════════════════════════════
// Settings against real SQLite: hydration in both directions, and the
// one-time import's anti-clobber rule.
//
// The rule that matters most here is "a row that already exists is never
// touched". It is what stops a second device, on the release that
// introduces settings sync, from overwriting the theme the first device
// already published with whatever happened to be in its own localStorage.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
const localStore = new Map<string, string>();
const prefs = new Map<string, string>();

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) {
            db.exec(sql);
            return;
          }
          db.exec('BEGIN');
          try {
            db.exec(sql);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => {
          db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected — one connection, created once');
      },
    };
  }),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.has(key) ? prefs.get(key)! : null }),
    set: async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void prefs.delete(key),
  },
}));

// Publishing an Entity File needs a Hidden Clone; none of that is what
// this file is testing, so it is stubbed to a no-op recorder.
const published: string[] = [];
vi.mock('../lib/sync/gitSync', () => ({
  writeEntityFile: async (_dir: string, id: string) => void published.push(id),
}));

(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (localStore.has(k) ? localStore.get(k)! : null),
  setItem: (k: string, v: string) => void localStore.set(k, String(v)),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
  key: (i: number) => [...localStore.keys()][i] ?? null,
  get length() { return localStore.size; },
};

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  localStore.clear();
  prefs.clear();
  published.length = 0;
  vi.resetModules();
});

async function load() {
  const local = await import('../db/local');
  await local.initLocalSchema();
  return {
    ...local,
    settings: await import('./settings.local'),
    cache: await import('../lib/settingsCache'),
  };
}

describe('hydrateSettings', () => {
  it('applies a setting another device published', async () => {
    const { query, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['display.themeMode', '"dark"']);

    const changed = await settings.hydrateSettings();

    expect(changed).toContain('display.themeMode');
    expect(settings.getSetting('display.themeMode')).toBe('dark');
  });

  it('publishes a value the cache has but the database does not', async () => {
    // The write-ahead half: a crash between writeCachedSetting() and the
    // INSERT, or a preference set while the database was not open.
    const { queryOne, settings, cache } = await load();
    cache.resetCachedSettings();
    cache.writeCachedSetting('display.measurementSystem', 'imperial');

    await settings.hydrateSettings();

    const row = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE id=$1`, ['display.measurementSystem']);
    expect(JSON.parse(row!.value)).toBe('imperial');
    expect(published).toContain('display.measurementSystem');
  });

  it('treats a deleted row as a reset to the default, not as a value', async () => {
    const { query, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value, deleted_at) VALUES ($1, $2, now())`, ['display.themeMode', '"dark"']);

    await settings.hydrateSettings();

    expect(settings.getSetting('display.themeMode')).toBe('system');
  });

  it('ignores a row for a key this build does not know', async () => {
    // Forward compatibility: a newer device syncing a setting this one has
    // never heard of must not crash it, and must not be echoed back.
    const { query, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['display.somethingNewer', '"x"']);

    await expect(settings.hydrateSettings()).resolves.not.toThrow();
    expect(cache.listCachedSettings()).not.toHaveProperty('display.somethingNewer');
  });

  it('survives an unparseable stored value', async () => {
    const { query, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['display.themeMode', '{not json']);

    await settings.hydrateSettings();

    expect(settings.getSetting('display.themeMode')).toBe('system');
  });
});

describe('setSetting', () => {
  it('writes the cache, the row and the entity file', async () => {
    const { queryOne, settings, cache } = await load();
    cache.resetCachedSettings();

    await settings.setSetting('display.themeMode', 'dark');

    expect(settings.getSetting('display.themeMode')).toBe('dark');
    const row = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE id=$1`, ['display.themeMode']);
    expect(JSON.parse(row!.value)).toBe('dark');
    expect(published).toContain('display.themeMode');
  });

  it('refuses a key outside the allowlist', async () => {
    const { settings, cache } = await load();
    cache.resetCachedSettings();
    await expect(settings.setSetting('llm.anthropicKey', 'sk-ant-secret')).rejects.toThrow();
  });

  it('clears a deletion marker when the value is set again', async () => {
    const { query, queryOne, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value, deleted_at) VALUES ($1, $2, now())`, ['display.themeMode', '"dark"']);

    await settings.setSetting('display.themeMode', 'light');

    const row = await queryOne<{ deleted_at: string | null }>(`SELECT deleted_at FROM settings WHERE id=$1`, ['display.themeMode']);
    expect(row!.deleted_at).toBeNull();
  });
});

describe('importLegacySettingsOnce', () => {
  it('moves this device’s existing preferences in', async () => {
    const { queryOne, settings, cache } = await load();
    cache.resetCachedSettings();
    localStore.set('smartchef.themeMode', 'dark');
    localStore.set('smartchef.displaySystem', 'imperial');
    localStore.set('smartchef.customLanguages', JSON.stringify(['pt']));
    prefs.set('smartchef.llm.provider', 'anthropic');
    prefs.set('smartchef.llm.anthropicModel', 'claude-opus-5');

    expect(await settings.importLegacySettingsOnce()).toBe(5);

    expect(JSON.parse((await queryOne<{ value: string }>(`SELECT value FROM settings WHERE id=$1`, ['display.themeMode']))!.value)).toBe('dark');
    expect(JSON.parse((await queryOne<{ value: string }>(`SELECT value FROM settings WHERE id=$1`, ['llm.model.anthropic']))!.value)).toBe('claude-opus-5');
  });

  it('never touches a row another device already published', async () => {
    // THE anti-clobber rule. This device prefers light; the library
    // already says dark. The library wins and nothing is overwritten.
    const { query, queryOne, settings, cache } = await load();
    cache.resetCachedSettings();
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['display.themeMode', '"dark"']);
    localStore.set('smartchef.themeMode', 'light');

    await settings.importLegacySettingsOnce();

    expect(JSON.parse((await queryOne<{ value: string }>(`SELECT value FROM settings WHERE id=$1`, ['display.themeMode']))!.value)).toBe('dark');
  });

  it('runs once, then never again', async () => {
    const { settings, cache } = await load();
    cache.resetCachedSettings();
    localStore.set('smartchef.themeMode', 'dark');

    expect(await settings.importLegacySettingsOnce()).toBe(1);
    localStore.set('smartchef.displaySystem', 'imperial');
    expect(await settings.importLegacySettingsOnce()).toBe(0);
  });

  it('finds the per-profile language keys, which are named after the profile', async () => {
    const { queryOne, settings, cache } = await load();
    cache.resetCachedSettings();
    localStore.set('smartchef.9f3a.contentLang', 'it');
    localStore.set('smartchef.9f3a.uiLang', 'en');
    // Not a profile — these prefixes are other namespaces entirely.
    localStore.set('smartchef.llm.uiLang', 'xx');
    localStore.set('smartchef.sync.uiLang', 'xx');

    await settings.importLegacySettingsOnce();

    expect(await queryOne(`SELECT id FROM settings WHERE id=$1`, ['profile.9f3a.contentLang'])).toBeTruthy();
    expect(await queryOne(`SELECT id FROM settings WHERE id=$1`, ['profile.9f3a.uiLang'])).toBeTruthy();
    expect(await queryOne(`SELECT id FROM settings WHERE id=$1`, ['profile.llm.uiLang'])).toBeNull();
    expect(await queryOne(`SELECT id FROM settings WHERE id=$1`, ['profile.sync.uiLang'])).toBeNull();
  });

  it('imports no credential, whatever is sitting in Preferences', async () => {
    const { query, settings, cache } = await load();
    cache.resetCachedSettings();
    prefs.set('smartchef.llm.anthropicKey', 'sk-ant-api03-DEADBEEF');
    prefs.set('smartchef.sync.gitRemote.token', 'ghp_DEADBEEFdeadbeef');
    prefs.set('smartchef.llm.ollamaUrl', 'http://192.168.1.50:11434');

    await settings.importLegacySettingsOnce();

    const rows = await query<{ id: string; value: string }>(`SELECT id, value FROM settings`);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('192.168.1.50');
  });
});
