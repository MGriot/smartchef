// ════════════════════════════════════════════════════════════════════════
// SmartChef — reading an RSS 2.0 / Atom feed
//
// Pure string work, no DOMParser, so it runs the same in the app and under
// the test runner (which has no DOM). Feeds are small, flat and
// machine-written; the few patterns below cover what the supported sites
// really publish (checked against live responses).
// ════════════════════════════════════════════════════════════════════════

export interface FeedItem {
  title: string;
  link: string;
  /** ISO string, or null when the feed gave none (or gave junk). */
  published: string | null;
  image: string | null;
}

export interface ParsedFeed {
  title: string | null;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

const safeChar = (code: number) => {
  try { return String.fromCodePoint(code); } catch { return ''; }
};

/** Inner text of the first `<tag>`, CDATA unwrapped and entities decoded. */
function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return null;
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(m[1]);
}

const plain = (s: string | null) => (s ? decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '');

function attr(tagSource: string, name: string): string | null {
  const m = tagSource.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? '') : null;
}

const httpOnly = (u: string | null): string | null => {
  if (!u) return null;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : null;
};

function linkOf(block: string): string | null {
  // Atom: <link rel="alternate" href="…"/> (rel defaults to alternate).
  const atom = [...block.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((l) => /\shref\s*=/.test(l) && (!/\srel\s*=/.test(l) || /\srel\s*=\s*["']alternate["']/i.test(l)));
  if (atom.length) return httpOnly(attr(atom[0], 'href'));
  // RSS: <link>…</link>
  return httpOnly(tagText(block, 'link')?.trim() ?? null) ?? httpOnly(tagText(block, 'guid')?.trim() ?? null);
}

function imageOf(block: string): string | null {
  for (const m of block.matchAll(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi)) {
    const url = httpOnly(attr(m[0], 'url'));
    const type = attr(m[0], 'type') ?? '';
    const medium = attr(m[0], 'medium') ?? '';
    if (url && (!type || type.startsWith('image') || medium === 'image' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) return url;
  }
  const html = tagText(block, 'content:encoded') ?? tagText(block, 'description') ?? tagText(block, 'summary') ?? tagText(block, 'content') ?? '';
  const img = decode(html).match(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return httpOnly(img?.[1] ?? null);
}

function dateOf(block: string): string | null {
  const raw = tagText(block, 'pubDate') ?? tagText(block, 'published') ?? tagText(block, 'updated') ?? tagText(block, 'dc:date');
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Newest first when the feed carries dates; feed order otherwise. */
export function parseFeed(xml: string, limit = 60): ParsedFeed {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const head = xml.slice(0, blocks.length ? xml.indexOf(blocks[0]) : xml.length);
  const items: FeedItem[] = [];
  for (const b of blocks) {
    const title = plain(tagText(b, 'title'));
    const link = linkOf(b);
    if (!title || !link) continue;
    items.push({ title, link, published: dateOf(b), image: imageOf(b) });
  }
  const dated = items.some((i) => i.published);
  if (dated) items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return { title: plain(tagText(head, 'title')) || null, items: items.slice(0, limit) };
}

/** True when the text is a feed (has items/entries, or a feed/channel root). */
export function looksLikeFeed(text: string): boolean {
  const head = text.slice(0, 2000);
  return /<(rss|feed|rdf:RDF)\b/i.test(head) || /<channel\b/i.test(head);
}

/** The feed URLs a page advertises with `<link rel="alternate" type="application/rss+xml">`. */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\srel\s*=\s*["']?alternate/i.test(tag) || !/type\s*=\s*["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try { out.push(new URL(href, baseUrl).toString()); } catch { /* skip a malformed href */ }
  }
  return [...new Set(out)];
}
