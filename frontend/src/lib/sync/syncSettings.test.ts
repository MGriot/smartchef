import { describe, it, expect, beforeEach, vi } from 'vitest';

// @capacitor/preferences' web implementation needs window.localStorage,
// unavailable in this suite's plain Node test environment (see
// vitest.config.ts) — same reason mergeBridge.test.ts mocks isomorphic-git
// rather than exercising the real dependency.
const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async get({ key }: { key: string }) {
      return { value: store.has(key) ? store.get(key)! : null };
    },
    async set({ key, value }: { key: string; value: string }) {
      store.set(key, value);
    },
    async remove({ key }: { key: string }) {
      store.delete(key);
    },
  },
}));

import {
  getSyncMode, setSyncMode,
  getGitRemoteConfig, setGitRemoteConfig, clearGitRemoteConfig,
  getSyncInterval, setSyncInterval, getSyncIntervalMinutes, syncIntervalToMinutes,
  DEFAULT_SYNC_INTERVAL, MIN_SYNC_INTERVAL_MINUTES,
} from './syncSettings';

beforeEach(() => {
  store.clear();
});

describe('sync mode', () => {
  it('defaults to folder mode — existing installs need zero migration', async () => {
    expect(await getSyncMode()).toBe('folder');
  });

  it('round-trips a chosen mode', async () => {
    await setSyncMode('git-remote');
    expect(await getSyncMode()).toBe('git-remote');
    await setSyncMode('folder');
    expect(await getSyncMode()).toBe('folder');
  });
});

describe('git remote config', () => {
  it('returns null when nothing has been configured yet', async () => {
    expect(await getGitRemoteConfig()).toBeNull();
  });

  it('round-trips a full config', async () => {
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me', token: 'ghp_abc123', corsProxy: 'https://cors.example.com' });
    expect(await getGitRemoteConfig()).toEqual({
      url: 'https://github.com/me/recipes.git',
      username: 'me',
      token: 'ghp_abc123',
      corsProxy: 'https://cors.example.com',
    });
  });

  it('stores a bare URL with null optional fields', async () => {
    await setGitRemoteConfig({ url: 'https://git.example.com/recipes.git', username: null, token: null, corsProxy: null });
    expect(await getGitRemoteConfig()).toEqual({
      url: 'https://git.example.com/recipes.git',
      username: null,
      token: null,
      corsProxy: null,
    });
  });

  it('leaves the stored token untouched when token is omitted (undefined) on save — the settings form\'s "leave blank to keep" path', async () => {
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me', token: 'ghp_original', corsProxy: null });
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me-renamed', token: undefined, corsProxy: null });
    expect((await getGitRemoteConfig())?.token).toBe('ghp_original');
    expect((await getGitRemoteConfig())?.username).toBe('me-renamed');
  });

  it('clears the token when explicitly set to null', async () => {
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me', token: 'ghp_original', corsProxy: null });
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me', token: null, corsProxy: null });
    expect((await getGitRemoteConfig())?.token).toBeNull();
  });

  it('clearGitRemoteConfig() removes everything', async () => {
    await setGitRemoteConfig({ url: 'https://github.com/me/recipes.git', username: 'me', token: 'ghp_abc', corsProxy: 'https://cors.example.com' });
    await clearGitRemoteConfig();
    expect(await getGitRemoteConfig()).toBeNull();
  });
});

describe('sync interval', () => {
  it('defaults to DEFAULT_SYNC_INTERVAL when unset', async () => {
    expect(await getSyncInterval()).toEqual(DEFAULT_SYNC_INTERVAL);
  });

  it('round-trips a chosen value+unit', async () => {
    await setSyncInterval({ value: 3, unit: 'days' });
    expect(await getSyncInterval()).toEqual({ value: 3, unit: 'days' });
  });

  it('migrates a device that already saved a plain-minutes value under this setting\'s original shape', async () => {
    store.set('smartchef.sync.intervalMinutes', '45');
    expect(await getSyncInterval()).toEqual({ value: 45, unit: 'minutes' });
  });

  it('a saved value+unit pair takes priority over any legacy plain-minutes value', async () => {
    store.set('smartchef.sync.intervalMinutes', '45');
    await setSyncInterval({ value: 2, unit: 'hours' });
    expect(await getSyncInterval()).toEqual({ value: 2, unit: 'hours' });
  });

  it('falls back to the default if the stored value is somehow corrupt', async () => {
    store.set('smartchef.sync.interval.value', 'not-a-number');
    store.set('smartchef.sync.interval.unit', 'minutes');
    expect(await getSyncInterval()).toEqual(DEFAULT_SYNC_INTERVAL);
  });

  it('falls back to the default if the stored unit is unrecognized', async () => {
    store.set('smartchef.sync.interval.value', '3');
    store.set('smartchef.sync.interval.unit', 'fortnights');
    expect(await getSyncInterval()).toEqual(DEFAULT_SYNC_INTERVAL);
  });

  describe('syncIntervalToMinutes', () => {
    it('converts every unit to minutes', () => {
      expect(syncIntervalToMinutes({ value: 90, unit: 'minutes' })).toBe(90);
      expect(syncIntervalToMinutes({ value: 2, unit: 'hours' })).toBe(120);
      expect(syncIntervalToMinutes({ value: 1, unit: 'days' })).toBe(24 * 60);
      expect(syncIntervalToMinutes({ value: 1, unit: 'weeks' })).toBe(7 * 24 * 60);
      expect(syncIntervalToMinutes({ value: 1, unit: 'months' })).toBe(30 * 24 * 60);
    });

    it('clamps to MIN_SYNC_INTERVAL_MINUTES', () => {
      expect(syncIntervalToMinutes({ value: 0, unit: 'minutes' })).toBe(MIN_SYNC_INTERVAL_MINUTES);
    });
  });

  it('getSyncIntervalMinutes() is the minutes-only view gitSync.ts\'s watcher uses', async () => {
    await setSyncInterval({ value: 1, unit: 'weeks' });
    expect(await getSyncIntervalMinutes()).toBe(7 * 24 * 60);
  });
});
