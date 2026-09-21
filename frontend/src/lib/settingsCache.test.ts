import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SETTINGS_CACHE_KEY, listCachedSettings, readCachedSetting, replaceCachedSettings,
  resetCachedSettings, subscribeSettings, writeCachedSetting,
} from './settingsCache';
import { getSetting, isSyncedSetting, THEME_MODE, CUSTOM_LANGUAGES, SYNC_INTERVAL_DEFAULT } from './settingsRegistry';

const store = new Map<string, string>();
let throwOnAccess = false;

(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => {
    if (throwOnAccess) throw new Error('storage locked');
    return store.has(k) ? store.get(k)! : null;
  },
  setItem: (k: string, v: string) => {
    if (throwOnAccess) throw new Error('storage locked');
    store.set(k, String(v));
  },
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

beforeEach(() => {
  store.clear();
  throwOnAccess = false;
  resetCachedSettings();
});

describe('settingsCache', () => {
  it('keeps everything under one key, so a cold read is one parse', () => {
    writeCachedSetting('display.themeMode', 'dark');
    writeCachedSetting('display.measurementSystem', 'imperial');
    expect([...store.keys()]).toEqual([SETTINGS_CACHE_KEY]);
  });

  it('survives storage that throws outright, not just storage that is empty', () => {
    // A private window, blocked site data, a thumbnail capture — and on
    // Electron, Chromium's per-profile localStorage lock when a second
    // instance starts. A preference is never worth failing a render over.
    throwOnAccess = true;
    expect(() => readCachedSetting('display.themeMode', 'system')).not.toThrow();
    expect(readCachedSetting('display.themeMode', 'system')).toBe('system');
    expect(() => writeCachedSetting('display.themeMode', 'dark')).not.toThrow();
  });

  it('falls back when the stored blob is corrupt', () => {
    store.set(SETTINGS_CACHE_KEY, '{not json');
    resetCachedSettings();
    expect(readCachedSetting('display.themeMode', 'system')).toBe('system');
  });

  it('ignores a stored blob that is not an object', () => {
    store.set(SETTINGS_CACHE_KEY, JSON.stringify(['an', 'array']));
    resetCachedSettings();
    expect(listCachedSettings()).toEqual({});
  });

  it('notifies subscribers only for keys that actually moved', () => {
    const seen: string[][] = [];
    const stop = subscribeSettings((keys) => seen.push(keys));
    writeCachedSetting('display.themeMode', 'dark');
    writeCachedSetting('display.themeMode', 'dark'); // same value, no event
    expect(seen).toEqual([['display.themeMode']]);
    stop();
    writeCachedSetting('display.themeMode', 'light');
    expect(seen).toHaveLength(1);
  });

  it('does not let one throwing subscriber stop the others', () => {
    const good = vi.fn();
    subscribeSettings(() => { throw new Error('boom'); });
    subscribeSettings(good);
    writeCachedSetting('display.themeMode', 'dark');
    expect(good).toHaveBeenCalled();
  });

  it('reports what replaceCachedSettings changed, including removals', () => {
    writeCachedSetting('display.themeMode', 'dark');
    writeCachedSetting('display.measurementSystem', 'imperial');
    const changed = replaceCachedSettings({ 'display.themeMode': 'dark', 'display.customLanguages': ['pt'] });
    // themeMode is unchanged; measurementSystem disappeared; customLanguages appeared.
    expect(changed.sort()).toEqual(['display.customLanguages', 'display.measurementSystem']);
  });
});

describe('settingsRegistry', () => {
  it('only recognises keys it declares', () => {
    expect(isSyncedSetting(THEME_MODE)).toBe(true);
    expect(isSyncedSetting('profile.abc123.uiLang')).toBe(true);
    expect(isSyncedSetting('llm.model.anthropic')).toBe(true);
    // The whole point of the allowlist: a plausible-looking key must not
    // be able to smuggle a credential through.
    expect(isSyncedSetting('llm.anthropicKey')).toBe(false);
    expect(isSyncedSetting('sync.gitRemote.token')).toBe(false);
    expect(isSyncedSetting('smartchef.llm.openaiKey')).toBe(false);
  });

  it('treats the wildcard as exactly one segment', () => {
    expect(isSyncedSetting('profile.a.b.uiLang')).toBe(false);
    expect(isSyncedSetting('profile..uiLang')).toBe(false);
  });

  it('falls back rather than propagating a value that does not validate', () => {
    writeCachedSetting(THEME_MODE, 'chartreuse');
    expect(getSetting(THEME_MODE)).toBe('system');
    writeCachedSetting(CUSTOM_LANGUAGES, ['pt', 42, 'not a code']);
    expect(getSetting(CUSTOM_LANGUAGES)).toEqual(['pt']);
    // Null, not a made-up interval: syncSettings.getSyncInterval() has to
    // be able to tell "no library default set" from one that happens to
    // equal the app's own default, or this fallback would quietly win.
    writeCachedSetting(SYNC_INTERVAL_DEFAULT, { value: -5, unit: 'fortnights' });
    expect(getSetting(SYNC_INTERVAL_DEFAULT)).toBeNull();
    writeCachedSetting(SYNC_INTERVAL_DEFAULT, { value: 2, unit: 'hours' });
    expect(getSetting(SYNC_INTERVAL_DEFAULT)).toEqual({ value: 2, unit: 'hours' });
  });

  it('reads where the setting used to live when the cache is still empty', () => {
    // The first launch after upgrading: nothing has been imported yet, and
    // on a server-mode install nothing ever will be. Falling straight to
    // the default here silently discarded an explicit choice — a user who
    // had picked dark got 'system', which only looked right if their OS
    // happened to agree.
    store.set('smartchef.themeMode', 'dark');
    expect(getSetting(THEME_MODE)).toBe('dark');
    store.set('smartchef.displaySystem', 'imperial');
    expect(getSetting('display.measurementSystem')).toBe('imperial');
  });

  it('prefers the cache over the legacy key once there is one', () => {
    store.set('smartchef.themeMode', 'dark');
    writeCachedSetting(THEME_MODE, 'light');
    expect(getSetting(THEME_MODE)).toBe('light');
  });

  it('still validates a legacy value', () => {
    store.set('smartchef.themeMode', 'chartreuse');
    expect(getSetting(THEME_MODE)).toBe('system');
  });

  it('refuses to read or write a key it does not declare', () => {
    expect(() => getSetting('llm.anthropicKey')).toThrow();
  });
});
