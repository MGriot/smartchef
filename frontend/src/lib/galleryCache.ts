// ════════════════════════════════════════════════════════════════════════
// SmartChef — gallery: last recipe list per query, for an instant first paint
//
// The gallery always refetches (a sync may have changed anything), so this is
// only what it shows until the answer lands: the list the same query returned
// last time. Kept in memory per query, and the plain unfiltered list also in
// localStorage so reopening the app is not an empty screen.
// ════════════════════════════════════════════════════════════════════════

export interface GalleryQuery {
  lang?: string | null;
  q?: string;
  tags?: string[];
  categories?: string[];
  regions?: string[];
  seasonalOnly?: boolean;
  sort: string;
}

/** Cards mounted on the first frame. */
export const REVEAL_INITIAL = 12;
/** Cards added per step after that. */
export const REVEAL_STEP = 8;
/** Pause between steps, so the grid fills in rather than landing in one render. */
export const REVEAL_DELAY_MS = 50;

const DISK_KEY = 'smartchef.gallery.cache';
const DISK_LIMIT = 300;
const MEMORY_LIMIT = 20;

/** Same key for the same query, whatever order its filters were picked in. */
export function galleryKey(query: GalleryQuery): string {
  const list = (a?: string[]) => [...(a ?? [])].sort().join(',');
  return [
    query.lang ?? '',
    (query.q ?? '').trim(),
    list(query.tags),
    list(query.categories),
    list(query.regions),
    query.seasonalOnly ? '1' : '0',
    query.sort,
  ].join('|');
}

const isPlain = (query: GalleryQuery) =>
  !(query.q ?? '').trim() && !query.tags?.length && !query.categories?.length && !query.regions?.length && !query.seasonalOnly;

const memory = new Map<string, unknown[]>();

/** Test seam: forget everything held in memory (the stored copy is untouched). */
export function resetGalleryCache() {
  memory.clear();
}

export function readGallery<T>(query: GalleryQuery): T[] | null {
  const key = galleryKey(query);
  const hit = memory.get(key);
  if (hit) return hit as T[];
  if (!isPlain(query)) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(DISK_KEY) ?? 'null');
    if (stored && stored.key === key && Array.isArray(stored.list)) return stored.list as T[];
  } catch { /* unreadable or blocked: start empty */ }
  return null;
}

export function writeGallery<T>(query: GalleryQuery, list: T[]) {
  const key = galleryKey(query);
  memory.delete(key);
  memory.set(key, list);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  if (!isPlain(query)) return;
  try {
    localStorage.setItem(DISK_KEY, JSON.stringify({ key, list: list.slice(0, DISK_LIMIT) }));
  } catch { /* a full or blocked store only costs the first-paint copy */ }
}
