import { describe, it, expect, beforeEach } from 'vitest';
import {
  BARE_UI_LANG_KEY,
  uiLangKey,
  readUiLang,
  persistUiLang,
  adoptUiLangForAccount,
} from './uiLanguage';

// Same in-memory stand-in as lib/languages.test.ts: the suite runs on plain
// Node with no jsdom, and this module reads/writes localStorage directly.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

beforeEach(() => {
  localStorage.clear();
});

describe('uiLangKey', () => {
  it('scopes to an account, and falls back to the bare bootstrap key', () => {
    expect(uiLangKey('abc')).toBe('smartchef.abc.uiLang');
    expect(uiLangKey(undefined)).toBe(BARE_UI_LANG_KEY);
    expect(uiLangKey(null)).toBe(BARE_UI_LANG_KEY);
  });
});

describe('readUiLang', () => {
  it('defaults to English when nothing is stored', () => {
    expect(readUiLang()).toBe('en');
    expect(readUiLang('abc')).toBe('en');
  });

  it('prefers the account key over the device-wide one', () => {
    localStorage.setItem(BARE_UI_LANG_KEY, 'it');
    localStorage.setItem(uiLangKey('abc'), 'fr');
    expect(readUiLang('abc')).toBe('fr');
    expect(readUiLang()).toBe('it');
  });

  it('falls back to the device-wide value for an account that has none', () => {
    localStorage.setItem(BARE_UI_LANG_KEY, 'es');
    expect(readUiLang('nobody')).toBe('es');
  });

  it('ignores a stored language with no translation bundle', () => {
    // i18next's fallbackLng only covers missing KEYS, not a missing resource
    // bundle — honouring "pt" here would render the UI as raw key names.
    localStorage.setItem(uiLangKey('abc'), 'pt');
    expect(readUiLang('abc')).toBe('en');
  });
});

describe('persistUiLang', () => {
  it('stores under the account key and keeps the bootstrap key in step', () => {
    expect(persistUiLang('it', 'abc')).toBe(true);
    expect(localStorage.getItem(uiLangKey('abc'))).toBe('it');
    expect(localStorage.getItem(BARE_UI_LANG_KEY)).toBe('it');
  });

  it('refuses a content-only language', () => {
    expect(persistUiLang('pt', 'abc')).toBe(false);
    expect(localStorage.getItem(uiLangKey('abc'))).toBeNull();
  });

  it('keeps two accounts on one device independent', () => {
    persistUiLang('it', 'alice');
    persistUiLang('fr', 'bob');
    expect(readUiLang('alice')).toBe('it');
    expect(readUiLang('bob')).toBe('fr');
  });
});

describe('adoptUiLangForAccount', () => {
  it('inherits the device default on first sign-in', () => {
    localStorage.setItem(BARE_UI_LANG_KEY, 'it');
    expect(adoptUiLangForAccount('abc')).toBe('it');
    expect(localStorage.getItem(uiLangKey('abc'))).toBe('it');
  });

  it('does not re-inherit once the account has its own choice', () => {
    localStorage.setItem(uiLangKey('abc'), 'fr');
    localStorage.setItem(BARE_UI_LANG_KEY, 'it');
    expect(adoptUiLangForAccount('abc')).toBe('fr');
    expect(localStorage.getItem(uiLangKey('abc'))).toBe('fr');
  });

  it('lands on English when the device has no default either', () => {
    expect(adoptUiLangForAccount('abc')).toBe('en');
  });
});
