// ════════════════════════════════════════════════════════════════════════
// SmartChef — which settings are synced, and what a valid value looks like
//
// Split out of services/settings.local.ts because the theme and the UI
// language are read at module-evaluation time, before React mounts. That
// module imports db/local (and therefore @capacitor-community/sqlite) and
// @capacitor/preferences; importing it from store/app.store.ts would pull
// the whole SQLite stack into the bundle's first chunk to answer a
// question localStorage can answer synchronously.
//
// So: the registry, the validators and the synchronous read live here and
// import nothing but lib/settingsCache.ts. Writing, hydrating and
// publishing live in services/settings.local.ts, which re-exports all of
// this so callers that already touch the database only import one module.
//
// See services/settings.local.ts for what is deliberately NOT synced —
// every credential, and everything that describes this device rather than
// this library.
// ════════════════════════════════════════════════════════════════════════

import { hasCachedSetting, readCachedSetting } from './settingsCache';

type Parse = (raw: unknown) => unknown;

export interface SettingSpec {
  /** An exact key, or one containing a single `*` standing for one
   *  path segment (`profile.*.uiLang`). */
  key: string;
  fallback: unknown;
  parse: Parse;
  /** Where this device kept the value before settings were synced. */
  legacy?: { store: 'local' | 'preferences'; key: string };
}

// ── Validators ──────────────────────────────────────────────────────────
// Every value arrives from either another device's JSON or this device's
// localStorage, so none of it is trusted. A value that does not validate
// falls back rather than propagating: a corrupt theme must not be able to
// stop the app painting.

const oneOf = (allowed: readonly string[], fallback: string): Parse =>
  (raw) => (typeof raw === 'string' && allowed.includes(raw) ? raw : fallback);

const stringOrNull: Parse = (raw) => (typeof raw === 'string' && raw.trim() ? raw : null);

const languageCodeList: Parse = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(c));
};

/** Null when nothing is stored, which is NOT the same as a stored value
 *  that happens to equal the app default: syncSettings.getSyncInterval()
 *  must be able to tell "no library default has ever been set" from "the
 *  library default is 15 minutes", or this module's own fallback would
 *  silently override DEFAULT_SYNC_INTERVAL. */
const syncInterval: Parse = (raw) => {
  const v = raw as { value?: unknown; unit?: unknown } | null | undefined;
  if (!v || typeof v !== 'object') return null;
  const units = ['minutes', 'hours', 'days', 'weeks', 'months'];
  if (typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value <= 0) return null;
  if (typeof v.unit !== 'string' || !units.includes(v.unit)) return null;
  return { value: Math.floor(v.value), unit: v.unit };
};

export const THEME_MODE = 'display.themeMode';
export const ACCENT_SCHEME = 'display.accentScheme';
export const MEASUREMENT_SYSTEM = 'display.measurementSystem';
export const CUSTOM_LANGUAGES = 'display.customLanguages';
export const HIDDEN_LANGUAGES = 'display.hiddenLanguages';
export const LLM_PROVIDER = 'llm.provider';
export const CONFLICT_POLICY_DEFAULT = 'sync.conflictPolicy.default';
export const SYNC_INTERVAL_DEFAULT = 'sync.interval.default';

export const SYNCED_SETTINGS: SettingSpec[] = [
  { key: THEME_MODE, fallback: 'system', parse: oneOf(['light', 'dark', 'system'], 'system'),
    legacy: { store: 'local', key: 'smartchef.themeMode' } },
  // Added by the accent-scheme work; harmless before it exists.
  { key: ACCENT_SCHEME, fallback: 'garden', parse: (raw) => (typeof raw === 'string' && raw ? raw : 'garden') },
  { key: MEASUREMENT_SYSTEM, fallback: 'metric', parse: oneOf(['metric', 'imperial'], 'metric'),
    legacy: { store: 'local', key: 'smartchef.displaySystem' } },
  { key: CUSTOM_LANGUAGES, fallback: [], parse: languageCodeList,
    legacy: { store: 'local', key: 'smartchef.customLanguages' } },
  { key: HIDDEN_LANGUAGES, fallback: [], parse: languageCodeList },
  { key: 'profile.*.uiLang', fallback: null, parse: stringOrNull },
  { key: 'profile.*.contentLang', fallback: null, parse: stringOrNull },
  { key: LLM_PROVIDER, fallback: null,
    parse: (raw) => (typeof raw === 'string' && ['ollama', 'anthropic', 'gemini', 'openai'].includes(raw) ? raw : null),
    legacy: { store: 'preferences', key: 'smartchef.llm.provider' } },
  // The model NAME only — never a key. A model name is not a constant in
  // practice (providers retire them), so agreeing on one across devices is
  // worth carrying; the credential to call it is not.
  { key: 'llm.model.*', fallback: null, parse: stringOrNull },
  // A LIBRARY DEFAULT, not this device's setting. A device that has its
  // own value in Preferences keeps overriding it — see syncSettings.ts.
  { key: CONFLICT_POLICY_DEFAULT, fallback: 'newest', parse: oneOf(['newest', 'ask'], 'newest') },
  { key: SYNC_INTERVAL_DEFAULT, fallback: null, parse: syncInterval },
];

export function specFor(key: string): SettingSpec | null {
  for (const spec of SYNCED_SETTINGS) {
    if (spec.key === key) return spec;
    if (!spec.key.includes('*')) continue;
    const [head, tail] = spec.key.split('*');
    if (key.startsWith(head) && key.endsWith(tail) && key.length > head.length + tail.length) {
      // The wildcard stands for ONE segment, so a key with an extra dot in
      // it is not a match — `profile.a.b.uiLang` must not read as one.
      const middle = key.slice(head.length, key.length - tail.length);
      if (!middle.includes('.')) return spec;
    }
  }
  return null;
}

/** True for a key this module is allowed to store. Anything else is
 *  ignored on the way in AND on the way out, so a future release that
 *  syncs a key this one does not know cannot smuggle a credential onto an
 *  older device by naming it something plausible. */
export function isSyncedSetting(key: string): boolean {
  return specFor(key) !== null;
}

// ── Reads and writes ────────────────────────────────────────────────────

/** Synchronous, because the callers that matter run before SQLite opens.
 *  Reads the cache, which hydration keeps level with the database. */
export function getSetting<T>(key: string): T {
  const spec = specFor(key);
  if (!spec) throw new Error(`getSetting: '${key}' is not a synced setting`);
  if (hasCachedSetting(key)) return spec.parse(readCachedSetting(key, spec.fallback)) as T;
  // Nothing in the cache yet. On an upgrading device that is the normal
  // state for one launch — importLegacySettingsOnce() has not run, and on
  // a server-mode install it never will — so read where this setting used
  // to live before assuming the default.
  //
  // Without this, a user who had explicitly chosen a dark theme got
  // 'system' on the first launch after upgrading, which silently matched
  // their choice only if their OS agreed.
  //
  // localStorage only: a Preferences read is async, and the settings read
  // before React mounts all live in localStorage.
  if (spec.legacy?.store === 'local') {
    const legacy = readLegacyLocal(spec.legacy.key);
    if (legacy !== undefined) return spec.parse(legacy) as T;
  }
  return spec.parse(spec.fallback) as T;
}

function readLegacyLocal(key: string): unknown {
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
