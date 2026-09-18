// ════════════════════════════════════════════════════════════════════════
// SmartChef — UI (interface) language, per user
//
// The app has two language axes, described at length in lib/languages.ts:
// the CONTENT language (what recipes are written in) and the UI language
// (what the chrome is rendered in). Content language has been per-account
// for a while — store/app.store.ts keys it `smartchef.<accountId>.contentLang`
// so two household profiles sharing one device don't overwrite each other.
// The UI language never got the same treatment: it lived in one bare,
// device-wide `smartchef.uiLang`, so whoever switched last switched it for
// everybody on that device.
//
// This module is that missing half, deliberately shaped like the
// contentLangKey()/setAccount() pair it mirrors:
//
//   - the BARE key stays the pre-login bootstrap default, because
//     i18n/index.ts has to resolve a language at module init, long before
//     any account is known;
//   - on first sign-in the bare value is inherited into the account-scoped
//     key once, then that account writes only its own key from then on.
//
// It is a plain .ts module with no React and no i18next import on purpose:
// the vitest suite runs on bare Node (no jsdom), so keeping the logic here
// is what makes it testable at all.
// ════════════════════════════════════════════════════════════════════════

import { hasUiBundle, normalizeLanguageCode } from './languages';

/** The pre-login bootstrap key. Read by i18n/index.ts at module init and by
 *  the first account to sign in on this device; never account-specific. */
export const BARE_UI_LANG_KEY = 'smartchef.uiLang';

export function uiLangKey(accountId?: string | null): string {
  return accountId ? `smartchef.${accountId}.uiLang` : BARE_UI_LANG_KEY;
}

/** localStorage can throw outright (Chromium holds a per-profile lock, which
 *  the Electron build hits when a second instance starts) as well as simply
 *  be empty, so every access here is guarded. A language preference is never
 *  worth failing a render over: falling back to the bundled default is
 *  always a correct answer. */
function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage locked — the choice just won't outlive the session */
  }
}

/** This account's interface language, falling back to the device-wide
 *  bootstrap value and finally to English.
 *
 *  Only ever returns a code that actually has a translation bundle: a value
 *  left over from an older build (or hand-edited) that names a language with
 *  no locales/<code>.json would otherwise render the whole UI as raw key
 *  names, since i18next's fallbackLng only covers MISSING keys, not a
 *  missing resource bundle. */
export function readUiLang(accountId?: string | null): string {
  const candidates = accountId
    ? [readKey(uiLangKey(accountId)), readKey(BARE_UI_LANG_KEY)]
    : [readKey(BARE_UI_LANG_KEY)];
  for (const value of candidates) {
    if (value && hasUiBundle(value)) return normalizeLanguageCode(value);
  }
  return 'en';
}

/** Persists `code` for this account (or device-wide when there is no account
 *  yet). A language with no UI bundle is rejected rather than stored: those
 *  are content-only languages, and writing one here would strand the next
 *  launch on a bundle that doesn't exist. Returns whether it was stored. */
export function persistUiLang(code: string, accountId?: string | null): boolean {
  if (!hasUiBundle(code)) return false;
  const normalized = normalizeLanguageCode(code);
  writeKey(uiLangKey(accountId), normalized);
  // Keep the bootstrap key in step too, so the NEXT cold start renders in
  // this language during the window before an account is resolved, instead
  // of flashing whatever the previously-signed-in profile had chosen.
  writeKey(BARE_UI_LANG_KEY, normalized);
  return true;
}

/** First sign-in on this device inherits the bootstrap value into this
 *  account's own key, exactly once; afterwards the account's stored value
 *  wins. Returns the language the caller should now apply.
 *
 *  Same shape as the contentLang branch of store/app.store.ts's setAccount(),
 *  and for the same reason: without it, an account that has never touched
 *  the picker would snap back to English on its first login even though the
 *  device was already running in Italian. */
export function adoptUiLangForAccount(accountId: string): string {
  const existing = readKey(uiLangKey(accountId));
  if (existing && hasUiBundle(existing)) return normalizeLanguageCode(existing);
  const inherited = readUiLang(null);
  writeKey(uiLangKey(accountId), inherited);
  return inherited;
}
