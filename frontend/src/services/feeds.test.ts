import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchPageHtml = vi.fn();
vi.mock('./pageFetcher', () => ({ fetchPageHtml: (url: string) => fetchPageHtml(url) }));

import { loadDiscover, peekDiscover, resetDiscoverCache } from './feeds';
import type { FeedSource } from '../lib/feedSources';

const rss = (title: string, date: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>${title}</title><link>https://x.test/${title}</link><pubDate>${date}</pubDate></item></channel></rss>`;

const A: FeedSource = { id: 'a', name: 'A', feedUrl: 'https://a.test/feed' };
const B: FeedSource = { id: 'b', name: 'B', feedUrl: 'https://b.test/feed' };
const KEY = 'smartchef.discover.cache';

let store: Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  });
  fetchPageHtml.mockReset();
  resetDiscoverCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loadDiscover cache behaviour', () => {
  it('fetches every uncached source and reports progress', async () => {
    fetchPageHtml.mockImplementation(async (url: string) => rss(url.includes('a.') ? 'pasta' : 'soup', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    const updates: Array<[number | undefined, number | undefined, number]> = [];
    const final = await loadDiscover([A, B], false, (p) => updates.push([p.done, p.total, p.items.length]));
    expect(fetchPageHtml).toHaveBeenCalledTimes(2);
    expect(final.items.map((i) => i.title).sort()).toEqual(['pasta', 'soup']);
    expect(updates[updates.length - 1]).toEqual([2, 2, 2]);
  });

  it('shows the cached copy first and does not refetch a fresh one', async () => {
    fetchPageHtml.mockResolvedValue(rss('pasta', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A]);
    fetchPageHtml.mockClear();

    const seen: number[] = [];
    await loadDiscover([A], false, (p) => seen.push(p.items.length));
    expect(fetchPageHtml).not.toHaveBeenCalled();
    expect(seen[0]).toBe(1);
  });

  it('paints a stale copy before the network answers, then refreshes it', async () => {
    fetchPageHtml.mockResolvedValue(rss('old', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A]);
    vi.setSystemTime(new Date('2026-10-12T11:00:00Z')); // an hour later: stale, still usable

    let release!: (v: string) => void;
    fetchPageHtml.mockReturnValue(new Promise<string>((r) => { release = r; }));
    const seen: string[][] = [];
    const run = loadDiscover([A], false, (p) => seen.push(p.items.map((i) => i.title)));
    expect(seen).toEqual([['old']]); // before the fetch resolved
    release(rss('new', 'Mon, 12 Oct 2026 10:30:00 GMT'));
    const final = await run;
    expect(final.items.map((i) => i.title)).toEqual(['new']);
  });

  it('shares one request between two loads that overlap', async () => {
    let release!: (v: string) => void;
    fetchPageHtml.mockReturnValue(new Promise<string>((r) => { release = r; }));
    const first = loadDiscover([A]);
    const second = loadDiscover([A], true);
    release(rss('pasta', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await Promise.all([first, second]);
    expect(fetchPageHtml).toHaveBeenCalledTimes(1);
  });

  it('refetches everything on force', async () => {
    fetchPageHtml.mockResolvedValue(rss('pasta', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A, B]);
    fetchPageHtml.mockClear();
    await loadDiscover([A, B], true);
    expect(fetchPageHtml).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the stale copy, with no error, when a refresh fails', async () => {
    fetchPageHtml.mockResolvedValue(rss('kept', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A]);
    fetchPageHtml.mockRejectedValue(new Error('offline'));
    const final = await loadDiscover([A], true);
    expect(final.items.map((i) => i.title)).toEqual(['kept']);
    expect(final.errors).toEqual({});
  });

  it('fetches sources with nothing cached before refreshing cached ones', async () => {
    fetchPageHtml.mockResolvedValue(rss('x', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A]);
    fetchPageHtml.mockClear();
    const order: string[] = [];
    fetchPageHtml.mockImplementation(async (url: string) => { order.push(url); return rss('y', 'Mon, 12 Oct 2026 08:00:00 GMT'); });
    // CONCURRENCY is 3, so all start together; the queue order is what we assert.
    await loadDiscover([A, B], true);
    expect(order[0]).toBe(B.feedUrl);
  });
});

describe('peekDiscover and persistence', () => {
  it('returns null with nothing cached, and survives a restart via localStorage', async () => {
    expect(peekDiscover([A])).toBeNull();
    fetchPageHtml.mockResolvedValue(rss('pasta', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([A]);
    vi.advanceTimersByTime(500); // the debounced save
    expect(JSON.parse(store[KEY])[A.feedUrl].items).toHaveLength(1);

    resetDiscoverCache(); // a new app start: memory empty, disk kept
    expect(peekDiscover([A])?.items.map((i) => i.title)).toEqual(['pasta']);
    expect(peekDiscover([B])).toBeNull();
  });

  it('ignores copies older than a week and prunes them on save', async () => {
    store[KEY] = JSON.stringify({
      [A.feedUrl]: { at: Date.now() - 8 * 24 * 60 * 60_000, items: [{ title: 'ancient', link: 'l' }] },
    });
    expect(peekDiscover([A])).toBeNull();
    fetchPageHtml.mockResolvedValue(rss('fresh', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    await loadDiscover([B]);
    vi.advanceTimersByTime(500);
    expect(Object.keys(JSON.parse(store[KEY]))).toEqual([B.feedUrl]);
  });

  it('tolerates a blocked localStorage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } });
    resetDiscoverCache();
    fetchPageHtml.mockResolvedValue(rss('pasta', 'Mon, 12 Oct 2026 08:00:00 GMT'));
    const final = await loadDiscover([A]);
    vi.advanceTimersByTime(500);
    expect(final.items).toHaveLength(1);
  });
});
