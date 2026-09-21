// ════════════════════════════════════════════════════════════════════════
// SmartChef — making a setting that arrived from another device take effect
//
// hydrateSettings() puts the value in the cache; the screen does not
// change until something acts on it. Themes and languages are applied
// imperatively (a class on <html>, an i18next call), so they need this;
// anything a component reads through useSyncedSetting() re-renders on its
// own and is deliberately absent here.
//
// Kept apart from services/settings.local.ts so that module stays free of
// i18next and the store — it is imported by gitSync, which runs on a
// background timer with no UI attached.
// ════════════════════════════════════════════════════════════════════════

// The REGISTRY, not the service: this runs before React mounts, and the
// service imports db/local and @capacitor/preferences.
import { ACCENT_SCHEME, THEME_MODE, getSetting } from './settingsRegistry';

/** Applied to <html> so a scheme is one attribute rather than a class per
 *  token. `garden` is the built-in green and sets no attribute at all, so
 *  the default palette needs no scheme block in theme.css. */
export function applyAccentScheme(scheme: string): void {
  const root = document.documentElement;
  if (!scheme || scheme === 'garden') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', scheme);
}

export function applyThemeMode(mode: string): void {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.documentElement.classList.toggle('dark', mode === 'dark' || (mode === 'system' && prefersDark));
}

/** Re-applies whichever of the imperative settings actually changed.
 *  Called with hydrateSettings()'s changed-key list, so a sync that
 *  touched nothing costs nothing. */
export function applySyncedSettings(changedKeys: string[]): void {
  if (changedKeys.includes(THEME_MODE)) applyThemeMode(getSetting<string>(THEME_MODE));
  if (changedKeys.includes(ACCENT_SCHEME)) applyAccentScheme(getSetting<string>(ACCENT_SCHEME));
}

/** Applied at module load, before React mounts, from the synchronous
 *  cache — so a device that already chose dark never paints light first. */
export function applyAppearanceFromCache(): void {
  applyThemeMode(getSetting<string>(THEME_MODE));
  applyAccentScheme(getSetting<string>(ACCENT_SCHEME));
}
