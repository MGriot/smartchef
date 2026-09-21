// ════════════════════════════════════════════════════════════════════════
// SmartChef — the synchronous face of a setting
//
// Settings are stored in SQLite so they can travel between devices as
// Entity Files (services/settings.local.ts). But two of them are read
// before SQLite is even open:
//
//   - store/app.store.ts applies the theme at module evaluation, before
//     React mounts, so the app does not paint light and then switch to dark;
//   - i18n/index.ts reads the UI language at module evaluation, because
//     i18next needs it to initialise.
//
// SQLite is opened later, from App.tsx, and reading it is async. So
// localStorage stays — not as the source of truth, but as a synchronous
// WRITE-AHEAD CACHE in front of it: every local change is written here
// first and to SQLite after, and hydration reconciles in BOTH directions,
// so a value written while the database was unavailable is republished
// rather than lost.
//
// This module deliberately imports NOTHING — no Capacitor, no db/local —
// so the modules above can keep importing it at evaluation time without
// dragging SQLite into the main bundle.
//
// One key, one JSON.parse for every setting. That is strictly less work
// than the per-setting getItem() calls this replaces, which were scattered
// across app.store, uiLanguage, languages, useLibraryView, Home and
// RecipeDetail.
// ════════════════════════════════════════════════════════════════════════

export const SETTINGS_CACHE_KEY = 'smartchef.settings.cache';

type Listener = (changedKeys: string[]) => void;

let memory: Record<string, unknown> | null = null;
const listeners = new Set<Listener>();

/** Reads can throw outright, not just come back empty: a private window, a
 *  device with site data blocked, a thumbnail capture — and on Electron,
 *  Chromium's localStorage lock when a second instance is running. Every
 *  access is guarded for the same reason lib/uiLanguage.ts guards its own. */
function readAll(): Record<string, unknown> {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    memory = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // An empty cache is the right answer to every one of those: each
    // setting still has a fallback, and hydration will fill it in.
    memory = {};
  }
  return memory;
}

function persist(): void {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(memory ?? {}));
  } catch {
    /* storage blocked — the value lives for this session and no longer */
  }
}

export function listCachedSettings(): Record<string, unknown> {
  return { ...readAll() };
}

export function readCachedSetting<T>(key: string, fallback: T): T {
  const all = readAll();
  return key in all && all[key] !== undefined ? (all[key] as T) : fallback;
}

export function hasCachedSetting(key: string): boolean {
  return key in readAll();
}

export function writeCachedSetting(key: string, value: unknown): void {
  const all = readAll();
  if (JSON.stringify(all[key]) === JSON.stringify(value)) return;
  all[key] = value;
  persist();
  notify([key]);
}

/** Replaces the whole cache after hydration. Returns the keys that
 *  actually changed, so callers only re-apply what moved. */
export function replaceCachedSettings(next: Record<string, unknown>): string[] {
  const all = readAll();
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(all), ...Object.keys(next)])) {
    if (JSON.stringify(all[key]) !== JSON.stringify(next[key])) changed.push(key);
  }
  memory = { ...next };
  persist();
  if (changed.length) notify(changed);
  return changed;
}

/** Test seam. Not called by the app. */
export function resetCachedSettings(): void {
  memory = null;
}

function notify(changedKeys: string[]): void {
  for (const listener of listeners) {
    try {
      listener(changedKeys);
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

/** localStorage fires no event in the tab that wrote it, so components
 *  that render a setting subscribe here instead — the same reason
 *  hooks/useLanguages.ts keeps its own module-level listener set. */
export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
