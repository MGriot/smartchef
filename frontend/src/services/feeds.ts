// ════════════════════════════════════════════════════════════════════════
// SmartChef — Discover: fetching the feeds
//
// Reuses fetchPageHtml(), which already knows how to reach an arbitrary
// site from each runtime (Electron main-process fetch, Android GitHttp,
// or the backend's fetch-page route in server mode) and carries the
// private-network guard. A feed is just text it returns.
//
// One bad site must never blank the list, so every source settles on its
// own. Results are kept in memory and in localStorage: a copy under a quarter
// of an hour old is used as is, an older one (up to a week) is shown at once
// and refreshed behind it, so opening the view is instant and survives a flaky
// connection.
// ════════════════════════════════════════════════════════════════════════

import { fetchPageHtml } from './pageFetcher';
import { parseFeed, looksLikeFeed, discoverFeedLinks, type FeedItem } from '../lib/feedParser';
import { searchFeedUrl, type FeedSource } from '../lib/feedSources';

export interface DiscoverItem extends FeedItem {
  sourceId: string;
  sourceName: string;
}

export interface DiscoverResult {
  items: DiscoverItem[];
  /** Source id → what went wrong, for sources that returned nothing usable. */
  errors: Record<string, string>;
  /** While loading: sources settled so far out of those being loaded. */
  done?: number;
  total?: number;
}

/** A copy younger than this is shown without asking the site again. */
const TTL_MS = 15 * 60_000;
/** An older copy is still painted first (then refreshed) for this long. */
const MAX_STALE_MS = 7 * 24 * 60 * 60_000;
const CACHE_KEY = 'smartchef.discover.cache';
const SAVE_DELAY_MS = 300;

type CacheEntry = { at: number; items: FeedItem[] };

// Loaded from localStorage once, then kept here: reading and rewriting the
// whole JSON blob for every feed that lands was a per-feed cost on the UI thread.
let cache: Record<string, CacheEntry> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function entries(): Record<string, CacheEntry> {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') ?? {}; } catch { cache = {}; }
  return cache!;
}

function remember(url: string, entry: CacheEntry) {
  entries()[url] = entry;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const all = entries();
    const now = Date.now();
    for (const [key, e] of Object.entries(all)) {
      if (now - e.at > MAX_STALE_MS) delete all[key];
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch { /* a full or blocked store only costs the offline copy */ }
  }, SAVE_DELAY_MS);
}

/** Test seam: forget everything held in memory (the stored copy is untouched). */
export function resetDiscoverCache() {
  cache = null;
  clearTimeout(saveTimer);
}

const isFresh = (e: CacheEntry | undefined) => !!e && Date.now() - e.at < TTL_MS;
const isUsable = (e: CacheEntry | undefined) => !!e && Date.now() - e.at < MAX_STALE_MS;

// A second load that starts while a feed is still on its way (a chip tapped, a
// source added, React mounting twice in dev) waits for that request instead of
// sending another to the same site.
const inflight = new Map<string, Promise<{ items: FeedItem[]; error?: string }>>();

function loadOne(source: FeedSource) {
  let p = inflight.get(source.feedUrl);
  if (!p) {
    p = fetchOne(source).finally(() => inflight.delete(source.feedUrl));
    inflight.set(source.feedUrl, p);
  }
  return p;
}

async function fetchOne(source: FeedSource): Promise<{ items: FeedItem[]; error?: string }> {
  try {
    const text = await fetchPageHtml(source.feedUrl);
    if (!looksLikeFeed(text)) throw new Error('not a feed');
    const items = parseFeed(text).items;
    remember(source.feedUrl, { at: Date.now(), items });
    return { items };
  } catch (err) {
    // Offline or blocked: fall back to the last copy this device saw.
    const stale = entries()[source.feedUrl];
    const error = err instanceof Error ? err.message : String(err);
    return { items: stale?.items ?? [], error };
  }
}

/** At most this many feeds are in flight at once: each response is parsed and
 *  decoded on the UI thread, and on Android every byte crosses the plugin bridge. */
const CONCURRENCY = 3;

const byNewest = (a: DiscoverItem, b: DiscoverItem) => (b.published ?? '').localeCompare(a.published ?? '');

const tag = (s: FeedSource, items: FeedItem[]): DiscoverItem[] =>
  items.map((it) => ({ ...it, sourceId: s.id, sourceName: s.name }));

/** Whatever this device already holds for these sources, however old, or null
 *  when nothing is cached. Lets the view paint on its first frame. */
export function peekDiscover(sources: FeedSource[]): DiscoverResult | null {
  const all = entries();
  const items: DiscoverItem[] = [];
  for (const s of sources) {
    const e = all[s.feedUrl];
    if (isUsable(e)) items.push(...tag(s, e.items));
  }
  return items.length ? { items: items.sort(byNewest), errors: {} } : null;
}

/** Shows the cached copy of every source at once, then asks only the sites
 *  whose copy is missing or older than TTL_MS (all of them when `force`), a few
 *  at a time, handing the merged list so far to `onUpdate` after each one. The
 *  empty sources go first so the list fills where it is emptiest. Each source
 *  keeps only its newest entries (see parseFeed). */
export async function loadDiscover(
  sources: FeedSource[],
  force = false,
  onUpdate?: (partial: DiscoverResult) => void,
): Promise<DiscoverResult> {
  const all = entries();
  const bySource = new Map<string, DiscoverItem[]>();
  const errors: Record<string, string> = {};
  for (const s of sources) {
    const e = all[s.feedUrl];
    if (isUsable(e)) bySource.set(s.id, tag(s, e.items));
  }
  const queue = sources
    .filter((s) => force || !isFresh(all[s.feedUrl]))
    .sort((a, b) => Number(bySource.has(a.id)) - Number(bySource.has(b.id)));
  const total = sources.length;
  let done = total - queue.length;
  const snapshot = (): DiscoverResult => ({
    items: [...bySource.values()].flat().sort(byNewest),
    errors: { ...errors },
    done,
    total,
  });
  // Cached copies go out first, before any network round trip.
  if (bySource.size > 0) onUpdate?.(snapshot());
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const s = queue[next++];
      const r = await loadOne(s);
      if (r.error && r.items.length === 0) errors[s.id] = r.error;
      else delete errors[s.id];
      bySource.set(s.id, tag(s, r.items));
      done++;
      onUpdate?.(snapshot());
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return snapshot();
}

const SEARCH_TTL_MS = 5 * 60_000;
const SEARCH_LIMIT = 20;
const searchMemory = new Map<string, { at: number; items: FeedItem[] }>();

/** Marker error for a source whose site has no search this app can read. */
export const NOT_SEARCHABLE = 'not searchable';

/** Asks each source's own site for `query`, a few at a time, so recipes that
 *  have scrolled out of the feed can still be found. Only WordPress-style
 *  sites answer (see searchFeedUrl); the rest are reported as NOT_SEARCHABLE.
 *  Same shape and pacing as loadDiscover. */
export async function searchDiscover(
  sources: FeedSource[],
  query: string,
  onUpdate?: (partial: DiscoverResult) => void,
): Promise<DiscoverResult> {
  const q = query.trim().toLowerCase();
  const items: DiscoverItem[] = [];
  const errors: Record<string, string> = {};
  const snapshot = (): DiscoverResult => ({ items: [...items].sort(byNewest), errors: { ...errors } });
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const s = sources[next++];
      const url = searchFeedUrl(s.feedUrl, q);
      if (!url) {
        errors[s.id] = NOT_SEARCHABLE;
      } else {
        const key = `${s.id}:${q}`;
        const hit = searchMemory.get(key);
        try {
          let found: FeedItem[];
          if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
            found = hit.items;
          } else {
            const text = await fetchPageHtml(url);
            if (!looksLikeFeed(text)) throw new Error(NOT_SEARCHABLE);
            found = parseFeed(text, SEARCH_LIMIT).items;
            searchMemory.set(key, { at: Date.now(), items: found });
          }
          for (const it of found) items.push({ ...it, sourceId: s.id, sourceName: s.name });
        } catch (err) {
          errors[s.id] = err instanceof Error ? err.message : String(err);
        }
      }
      onUpdate?.(snapshot());
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
  return snapshot();
}

/** Accepts a feed URL or a site's address: if the address is a page, the
 *  feed it advertises is used. Throws when neither works, so the Settings
 *  card can say why a site cannot be added. */
export async function resolveFeedSource(input: string): Promise<{ name: string; feedUrl: string }> {
  let url = input.trim();
  if (!url) throw new Error('empty');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const hostName = new URL(url).hostname.replace(/^www\./, '');
  const text = await fetchPageHtml(url);
  if (looksLikeFeed(text)) return { name: parseFeed(text, 1).title ?? hostName, feedUrl: url };
  for (const candidate of discoverFeedLinks(text, url)) {
    try {
      const body = await fetchPageHtml(candidate);
      if (looksLikeFeed(body)) return { name: parseFeed(body, 1).title ?? hostName, feedUrl: candidate };
    } catch { /* try the next advertised feed */ }
  }
  throw new Error('no-feed');
}
