// ════════════════════════════════════════════════════════════════════════
// SmartChef — Languages
//
// The app has always had exactly four languages, hardcoded in i18n/index.ts,
// and that one list was doing two different jobs:
//
//   1. UI language — needs a translation bundle (locales/<code>.json) that
//      ships with the build. A user cannot add one of these at runtime;
//      there is nothing to load.
//   2. Content language — the language a recipe is written in, the target of
//      a translation, the `lang` on every catalog row. This needs no bundle
//      at all: it is just a code stored next to some text.
//
// Only (1) is actually limited to four. This module opens (2) up: a user can
// add any language they want to write recipes in, and it shows up wherever a
// content language is chosen. The UI stays in whichever bundled language it
// was.
//
// Labels come from Intl.DisplayNames rather than being typed in, so adding
// "pt" gets you "Português" (and "Portuguese" when the UI is English)
// without the user naming it — and, importantly, so a language code that
// arrives from ANOTHER device via sync still renders as a real language name
// here even though this device never added it. That is what keeps custom
// languages usable despite the list itself being per-device.
// ════════════════════════════════════════════════════════════════════════

import { CUSTOM_LANGUAGES, HIDDEN_LANGUAGES, getSetting } from './settingsRegistry';
import { writeCachedSetting } from './settingsCache';

/** The list is a SYNCED setting now (services/settings.local.ts), so a
 *  language added on one device shows up in the other's picker instead of
 *  having to be typed in twice.
 *
 *  Reads stay synchronous — they come from lib/settingsCache.ts, which is
 *  the same localStorage access this file used to do by hand. Writes go to
 *  the cache immediately and to SQLite/git behind a dynamic import, so a
 *  picker never waits on a database that may not be open yet and this
 *  module keeps its "imports nothing heavy" property. */
function persist(key: string, codes: string[]): void {
  writeCachedSetting(key, codes);
  void import('../services/settings.local')
    .then(({ setSetting }) => setSetting(key, codes))
    .catch((err) => console.warn('SmartChef: saving the language list failed:', err));
}

export interface Language {
  code: string;
  label: string;
  /** True when locales/<code>.json ships in the build, i.e. this language
   *  can be the UI language and not only a content language. */
  hasUiBundle: boolean;
}

/** The languages with a real translation bundle. Kept here rather than in
 *  i18n/index.ts so that importing the language list does not drag i18next
 *  and four locale files into a module that only wanted the codes. */
export const BUNDLED_LANGUAGE_CODES = ['en', 'it', 'fr', 'es'] as const;

/** Hand-written because these are the languages the UI itself is translated
 *  into: each is shown in its OWN language, which is the convention for a
 *  UI-language picker (you find your language by recognising it, not by
 *  reading it in a language you don't speak). */
const BUNDLED_LABELS: Record<string, string> = {
  en: 'English',
  it: 'Italiano',
  fr: 'Français',
  es: 'Español',
};

/** A BCP-47-ish code: two or three letters, optionally a region subtag
 *  ("pt", "pt-BR"). Deliberately permissive about what language it names —
 *  rejecting codes Intl doesn't recognise would block valid regional and
 *  minority languages — but strict about shape, because this value ends up
 *  in a database column and a URL query parameter. */
const CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export function isValidLanguageCode(code: string): boolean {
  return CODE_RE.test(code.trim().toLowerCase());
}

export function normalizeLanguageCode(code: string): string {
  const trimmed = code.trim();
  const [base, region] = trimmed.split('-');
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase();
}

/** A human name for any language code, in `uiLang` where possible.
 *
 *  Falls back through: the bundled label, Intl.DisplayNames, then the code
 *  upper-cased. The last case is not a failure — it is what a code with no
 *  known name should look like, and it keeps a recipe's language readable
 *  rather than blank. */
export function languageLabel(code: string, uiLang?: string): string {
  if (!code) return '';
  const normalized = normalizeLanguageCode(code);
  if (BUNDLED_LABELS[normalized]) return BUNDLED_LABELS[normalized];
  try {
    // Not available in every engine this app runs in (the Electron build is
    // Chromium 114, Android's WebView is whatever the device shipped), so
    // never assume it resolves.
    const dn = new Intl.DisplayNames([uiLang || 'en'], { type: 'language' });
    const name = dn.of(normalized);
    if (name && name.toLowerCase() !== normalized.toLowerCase()) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch {
    /* fall through to the code */
  }
  return normalized.toUpperCase();
}

// ── Custom (user-added) content languages ───────────────────────────────
// Stored per device rather than in the database. A synced recipe carries its
// language *code* in its own row, and languageLabel() above resolves that on
// any device, so the only thing that does not travel is the entry in this
// picker — which is a preference, not data.

export function getCustomLanguageCodes(): string[] {
  return getSetting<string[]>(CUSTOM_LANGUAGES)
    .map(normalizeLanguageCode)
    .filter((c) => isValidLanguageCode(c) && !BUNDLED_LANGUAGE_CODES.includes(c as never));
}

function writeCustomLanguageCodes(codes: string[]): void {
  persist(CUSTOM_LANGUAGES, codes);
}

// ── Hidden languages ────────────────────────────────────────────────────
// Removing a language used to mean removing it from the custom list, which
// left the four bundled ones permanently in every picker: a user who never
// writes in French had French in front of them on every recipe, with a
// padlock next to it.
//
// Hiding is a separate list rather than a hole punched in
// BUNDLED_LANGUAGE_CODES, because that constant is doing a second job —
// "has a shipped UI bundle" — which is a fact about the build, not a
// preference. Hiding is also deliberately NOT a deletion: every
// translation row stays in SQLite and keeps syncing, and languageLabel()
// still resolves the code, so a recipe written in a hidden language
// remains perfectly readable. Un-hiding puts everything back.

export function getHiddenLanguageCodes(): string[] {
  return getSetting<string[]>(HIDDEN_LANGUAGES)
    .map(normalizeLanguageCode)
    // English is the i18n fallback: with it hidden there is no language
    // left to resolve a missing key against.
    .filter((c) => isValidLanguageCode(c) && c !== 'en');
}

/** True when this language may be hidden at all. English may not. */
export function canHideLanguage(code: string): boolean {
  return normalizeLanguageCode(code) !== 'en';
}

export function hideLanguage(code: string): string[] {
  const normalized = normalizeLanguageCode(code);
  if (!canHideLanguage(normalized)) return getHiddenLanguageCodes();
  const current = getHiddenLanguageCodes();
  if (current.includes(normalized)) return current;
  const next = [...current, normalized];
  persist(HIDDEN_LANGUAGES, next);
  return next;
}

export function unhideLanguage(code: string): string[] {
  const normalized = normalizeLanguageCode(code);
  const next = getHiddenLanguageCodes().filter((c) => c !== normalized);
  persist(HIDDEN_LANGUAGES, next);
  return next;
}

/** The hidden ones, with labels — for the "show hidden" disclosure that
 *  makes hiding reversible. */
export function listHiddenLanguages(uiLang?: string): Language[] {
  return getHiddenLanguageCodes().map((code) => ({
    code,
    label: BUNDLED_LABELS[code] ?? languageLabel(code, uiLang),
    hasUiBundle: BUNDLED_LANGUAGE_CODES.includes(code as never),
  }));
}

/** Returns the updated list. Rejects a malformed code, and silently ignores
 *  one that is already present (bundled or custom) rather than duplicating
 *  it in the picker. */
export function addCustomLanguage(code: string): string[] {
  const normalized = normalizeLanguageCode(code);
  if (!isValidLanguageCode(normalized)) throw new Error('invalid language code');
  if (BUNDLED_LANGUAGE_CODES.includes(normalized as never)) return getCustomLanguageCodes();
  const current = getCustomLanguageCodes();
  if (current.includes(normalized)) return current;
  const next = [...current, normalized];
  writeCustomLanguageCodes(next);
  return next;
}

export function removeCustomLanguage(code: string): string[] {
  const normalized = normalizeLanguageCode(code);
  const next = getCustomLanguageCodes().filter((c) => c !== normalized);
  writeCustomLanguageCodes(next);
  return next;
}

/** Every language the pickers should offer: the bundled ones first, in their
 *  declared order, then whatever the user added, in the order they added it. */
export function listLanguages(uiLang?: string): Language[] {
  const hidden = new Set(getHiddenLanguageCodes());
  const bundled = BUNDLED_LANGUAGE_CODES.filter((code) => !hidden.has(code)).map((code) => ({
    code,
    label: BUNDLED_LABELS[code],
    hasUiBundle: true,
  }));
  const custom = getCustomLanguageCodes().filter((code) => !hidden.has(code)).map((code) => ({
    code,
    label: languageLabel(code, uiLang),
    hasUiBundle: false,
  }));
  return [...bundled, ...custom];
}

/** True when switching to this language can also switch the UI. Used by the
 *  header picker to decide whether to change the interface language or only
 *  the content language. */
export function hasUiBundle(code: string): boolean {
  return BUNDLED_LANGUAGE_CODES.includes(normalizeLanguageCode(code) as never);
}
