// ════════════════════════════════════════════════════════════════════════
// SmartChef — Discover: fetching the feeds
//
// Reuses fetchPageHtml(), which already knows how to reach an arbitrary
// site from each runtime (Electron main-process fetch, Android GitHttp,
// or the backend's fetch-page route in server mode) and carries the
// private-network guard. A feed is just text it returns.
//
// One bad site must never blank the list, so every source settles on its
// own. Results are kept in memory and in localStorage for a quarter of an
// hour so reopening the view is instant and survives a flaky connection.
// ════════════════════════════════════════════════════════════════════════

import { fetchPageHtml } from './pageFetcher';
import { parseFeed, looksLikeFeed, discoverFeedLinks, type FeedItem } from '../lib/feedParser';
import type { FeedSource } from '../lib/feedSources';

export interface DiscoverItem extends FeedItem {
  sourceId: string;
  sourceName: string;
}

export interface DiscoverResult {
  items: DiscoverItem[];
  /** Source id → what went wrong, for sources that returned nothing usable. */
  errors: Record<string, string>;
}

const TTL_MS = 15 * 60_000;
const CACHE_KEY = 'smartchef.discover.cache';
const memory = new Map<string, { at: number; items: FeedItem[] }>();

function readDisk(): Record<string, { at: number; items: FeedItem[] }> {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function writeDisk(url: string, entry: { at: number; items: FeedItem[] }) {
  try {
    const all = readDisk();
    all[url] = entry;
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* a full or blocked store only costs the offline copy */ }
}

async function loadOne(source: FeedSource, force: boolean): Promise<{ items: FeedItem[]; error?: string }> {
  const hit = memory.get(source.feedUrl);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return { items: hit.items };
  try {
    const text = await fetchPageHtml(source.feedUrl);
    if (!looksLikeFeed(text)) throw new Error('not a feed');
    const items = parseFeed(text).items;
    const entry = { at: Date.now(), items };
    memory.set(source.feedUrl, entry);
    writeDisk(source.feedUrl, entry);
    return { items };
  } catch (err) {
    // Offline or blocked: fall back to the last copy this device saw.
    const stale = hit ?? readDisk()[source.feedUrl];
    const error = err instanceof Error ? err.message : String(err);
    return { items: stale?.items ?? [], error };
  }
}

/** At most this many feeds are in flight at once: each response is parsed and
 *  decoded on the UI thread, and on Android every byte crosses the plugin bridge. */
const CONCURRENCY = 3;

const byNewest = (a: DiscoverItem, b: DiscoverItem) => (b.published ?? '').localeCompare(a.published ?? '');

/** Loads the given sources a few at a time, handing the merged list so far to
 *  `onUpdate` after each one, so the first page appears without waiting for
 *  the slowest site. Each source keeps only its newest entries (see parseFeed). */
export async function loadDiscover(
  sources: FeedSource[],
  force = false,
  onUpdate?: (partial: DiscoverResult) => void,
): Promise<DiscoverResult> {
  const items: DiscoverItem[] = [];
  const errors: Record<string, string> = {};
  const snapshot = (): DiscoverResult => ({ items: [...items].sort(byNewest), errors: { ...errors } });
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const s = sources[next++];
      const r = await loadOne(s, force);
      if (r.error && r.items.length === 0) errors[s.id] = r.error;
      for (const it of r.items) items.push({ ...it, sourceId: s.id, sourceName: s.name });
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
