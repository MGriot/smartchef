import { describe, it, expect } from 'vitest';
import { parseFeed, looksLikeFeed, discoverFeedLinks } from './feedParser';
import { parseFeedSources, DEFAULT_FEED_SOURCES } from './feedSources';

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Serious &amp; Eats</title><link>https://x.test/</link><atom:link href="https://x.test/feed" rel="self"/>
<item><title><![CDATA[Cacio e Pepe & more]]></title><link>https://x.test/cacio</link><pubDate>Fri, 09 Oct 2026 10:00:00 GMT</pubDate><media:thumbnail url="https://img.test/a.jpg"/></item>
<item><title>Older</title><link>https://x.test/older</link><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;&lt;img src="https://img.test/b.png"&gt;&lt;/p&gt;</description></item>
<item><title>No link</title></item>
<item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link rel="self" href="https://b.test/atom"/>
<entry><title>Hello</title><link rel="alternate" href="https://b.test/hello"/><updated>2026-10-01T08:00:00Z</updated><content type="html">&lt;img src="https://b.test/i.jpg"/&gt;</content></entry></feed>`;

describe('parseFeed', () => {
  it('reads RSS: decodes titles, keeps http links only, newest first, finds images', () => {
    const f = parseFeed(rss);
    expect(f.title).toBe('Serious & Eats');
    expect(f.items.map((i) => i.title)).toEqual(['Cacio e Pepe & more', 'Older']);
    expect(f.items[0]).toMatchObject({ link: 'https://x.test/cacio', image: 'https://img.test/a.jpg' });
    expect(f.items[1].image).toBe('https://img.test/b.png');
    expect(f.items[0].published).toBe('2026-10-09T10:00:00.000Z');
  });

  it('reads Atom with the alternate link rather than self', () => {
    const f = parseFeed(atom);
    expect(f.items).toEqual([{ title: 'Hello', link: 'https://b.test/hello', published: '2026-10-01T08:00:00.000Z', image: 'https://b.test/i.jpg' }]);
  });

  it('caps the item count and survives junk', () => {
    expect(parseFeed(rss, 1).items).toHaveLength(1);
    expect(parseFeed('<html>nope</html>').items).toEqual([]);
  });
});

describe('feed detection', () => {
  it('tells a feed from a page and finds advertised feeds', () => {
    expect(looksLikeFeed(rss)).toBe(true);
    expect(looksLikeFeed('<!doctype html><html></html>')).toBe(false);
    const html = '<head><link rel="alternate" type="application/rss+xml" href="/feed/rss"><link rel="stylesheet" href="/a.css"></head>';
    expect(discoverFeedLinks(html, 'https://site.test/page')).toEqual(['https://site.test/feed/rss']);
  });
});

describe('parseFeedSources', () => {
  it('falls back to the defaults when nothing valid is stored, keeps a deliberate empty list', () => {
    expect(parseFeedSources(null)).toBe(DEFAULT_FEED_SOURCES);
    expect(parseFeedSources([])).toEqual([]);
  });

  it('drops malformed, duplicate and non-http entries', () => {
    const good = { id: 'a', name: 'A', feedUrl: 'https://a.test/feed' };
    expect(parseFeedSources([good, good, { id: 'b', name: 'B', feedUrl: 'file:///etc/passwd' }, { id: 'c', name: '', feedUrl: 'https://c.test' }, 5])).toEqual([good]);
  });

  it('ships defaults that all validate', () => {
    expect(parseFeedSources(DEFAULT_FEED_SOURCES)).toHaveLength(DEFAULT_FEED_SOURCES.length);
  });
});
