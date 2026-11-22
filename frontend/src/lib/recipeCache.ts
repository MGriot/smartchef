// ════════════════════════════════════════════════════════════════════════
// SmartChef — recipe page: the last answer per recipe, for an instant paint
//
// Opening a recipe is a dozen reads through the SQLite bridge, which on
// Android is the slow part. The page shows the copy it got last time (or the
// one the gallery fetched when the pointer landed on the card) at once and
// still refetches: like galleryCache, this is only what it shows until the
// fresh answer lands, never the answer itself.
//
// Kept in memory only, a handful of recipes, and emptied whenever a sync
// changed anything, so nothing stale outlives a pull.
// ════════════════════════════════════════════════════════════════════════

import { apiFetch } from './api';
import { getSyncStatus, subscribeSyncStatus } from './sync/syncStatus';

const LIMIT = 20;

/** The query string the recipe page asks with, shared so a prefetch is a hit. */
export function recipeDetailPath(id: string, lang?: string | null): string {
  const params = new URLSearchParams();
  if (lang) params.set('lang', lang);
  params.set('include', 'sub_ingredients');
  return `/api/recipes/${id}?${params.toString()}`;
}

const entries = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();
const keyOf = (id: string, lang?: string | null) => `${id}|${lang ?? ''}`;

let revision = getSyncStatus().appliedRevision;
subscribeSyncStatus((s) => {
  if (s.appliedRevision !== revision) {
    revision = s.appliedRevision;
    entries.clear();
  }
});

export function readRecipe<T>(id: string, lang?: string | null): T | null {
  const key = keyOf(id, lang);
  const hit = entries.get(key);
  if (hit === undefined) return null;
  // Most recently used last, so the oldest is the one dropped.
  entries.delete(key);
  entries.set(key, hit);
  return hit as T;
}

export function writeRecipe(id: string, lang: string | null | undefined, data: unknown): void {
  const key = keyOf(id, lang);
  entries.delete(key);
  entries.set(key, data);
  while (entries.size > LIMIT) entries.delete(entries.keys().next().value as string);
}

export function forgetRecipe(id: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(`${id}|`)) entries.delete(key);
}

/** Fetches a recipe the user is about to open (pointer on its card), once. */
export function prefetchRecipe(id: string, lang?: string | null): void {
  const key = keyOf(id, lang);
  if (entries.has(key) || inFlight.has(key)) return;
  const p = apiFetch(recipeDetailPath(id, lang))
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => { if (json?.data) writeRecipe(id, lang, json.data); })
    .catch(() => {})
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
}

/** The prefetch for this recipe if one is still running, so the page waits
 *  for it instead of sending the same dozen reads a second time. */
export function pendingRecipe(id: string, lang?: string | null): Promise<unknown> | null {
  return inFlight.get(keyOf(id, lang)) ?? null;
}
