import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidLanguageCode,
  normalizeLanguageCode,
  languageLabel,
  addCustomLanguage,
  removeCustomLanguage,
  getCustomLanguageCodes,
  listLanguages,
  hasUiBundle,
  BUNDLED_LANGUAGE_CODES,
} from './languages';

// The suite runs on plain Node with no jsdom, so `localStorage` — which this
// module reads and writes directly — does not exist. A minimal in-memory
// stand-in is enough: the module only uses getItem/setItem, and the tests
// need clear() between them.
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

describe('isValidLanguageCode', () => {
  it('accepts plain and regional codes', () => {
    for (const code of ['en', 'pt', 'yue', 'pt-BR', 'zh-Hant']) {
      expect(isValidLanguageCode(code)).toBe(true);
    }
  });

  it('rejects shapes that would be unsafe in a column or a query string', () => {
    for (const code of ['', 'e', 'english!', 'pt_BR', '../etc', 'toolongcode', 'pt-']) {
      expect(isValidLanguageCode(code)).toBe(false);
    }
  });
});

describe('normalizeLanguageCode', () => {
  it('lowercases the language and uppercases the region', () => {
    expect(normalizeLanguageCode('PT-br')).toBe('pt-BR');
    expect(normalizeLanguageCode('  EN  ')).toBe('en');
  });
});

describe('languageLabel', () => {
  it('uses the language its own name for the bundled four', () => {
    expect(languageLabel('it')).toBe('Italiano');
    expect(languageLabel('fr')).toBe('Français');
  });

  it('resolves a code the app never shipped, so synced content stays readable', () => {
    // The point of this: a recipe written in `pt` on another device must not
    // show up here as a bare code just because this device never added it.
    const label = languageLabel('pt', 'en');
    expect(label.toLowerCase()).toContain('portuguese');
  });

  it('translates the label into the UI language', () => {
    expect(languageLabel('pt', 'it').toLowerCase()).toContain('portoghese');
  });

  it('falls back to the upper-cased code for something Intl cannot name', () => {
    expect(languageLabel('qqq')).toBe('QQQ');
  });

  it('returns an empty string for an empty code rather than throwing', () => {
    expect(languageLabel('')).toBe('');
  });
});

describe('custom languages', () => {
  it('adds, lists and removes', () => {
    addCustomLanguage('pt');
    expect(getCustomLanguageCodes()).toEqual(['pt']);
    removeCustomLanguage('pt');
    expect(getCustomLanguageCodes()).toEqual([]);
  });

  it('normalizes on the way in, so pt-br and PT-BR are one entry', () => {
    addCustomLanguage('pt-br');
    addCustomLanguage('PT-BR');
    expect(getCustomLanguageCodes()).toEqual(['pt-BR']);
  });

  it('refuses a malformed code', () => {
    expect(() => addCustomLanguage('not a language')).toThrow();
    expect(getCustomLanguageCodes()).toEqual([]);
  });

  it('ignores a language that already ships with the app', () => {
    addCustomLanguage('it');
    expect(getCustomLanguageCodes()).toEqual([]);
  });

  it('survives a corrupted storage value instead of breaking every picker', () => {
    localStorage.setItem('smartchef.customLanguages', '{not json');
    expect(getCustomLanguageCodes()).toEqual([]);
    expect(listLanguages()).toHaveLength(BUNDLED_LANGUAGE_CODES.length);
  });

  it('drops entries that are not strings', () => {
    localStorage.setItem('smartchef.customLanguages', JSON.stringify(['pt', 42, null]));
    expect(getCustomLanguageCodes()).toEqual(['pt']);
  });
});

describe('listLanguages', () => {
  it('puts the bundled languages first, then custom ones in insertion order', () => {
    addCustomLanguage('pt');
    addCustomLanguage('de');
    const codes = listLanguages().map((l) => l.code);
    expect(codes.slice(0, 4)).toEqual([...BUNDLED_LANGUAGE_CODES]);
    expect(codes.slice(4)).toEqual(['pt', 'de']);
  });

  it('marks which languages can drive the interface', () => {
    addCustomLanguage('pt');
    const byCode = Object.fromEntries(listLanguages().map((l) => [l.code, l.hasUiBundle]));
    expect(byCode.en).toBe(true);
    expect(byCode.pt).toBe(false);
  });
});

describe('hasUiBundle', () => {
  it('is true only for the four that ship a translation file', () => {
    expect(hasUiBundle('en')).toBe(true);
    expect(hasUiBundle('IT')).toBe(true);
    expect(hasUiBundle('pt')).toBe(false);
  });
});
