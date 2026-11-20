// ════════════════════════════════════════════════════════════════════════
// SmartChef — searching the user's recipe sites by query
//
// Discover reads each site's feed, which holds only its newest posts. This
// asks the sites themselves: "pasta" goes to every saved site's own search,
// and what comes back is checked to really be a recipe before it is shown.
//
// Sites search in different ways, and most publish how. Tried in order, the
// first that answers is remembered for that site:
//   1. a search address the user typed for the site ("…/cerca?q={q}");
//   2. the one the site declares on its home page: schema.org SearchAction
//      or an OpenSearch descriptor;
//   3. WordPress, which answers /wp-json/wp/v2/search with JSON and
//      /?s=…&feed=rss2 with a feed;
//   4. the common results-page addresses (/search?q=, /?s=, /cerca?q=…).
// A results page is HTML; the recipe links on it are told apart from menus,
// tags and galleries by staying on the site and naming what was searched.
//
// Pure string work, no DOMParser (the test runner has no DOM). The fetching
// is in services/siteSearch.ts.
// ════════════════════════════════════════════════════════════════════════

export type SearchKind = 'html' | 'feed' | 'wpjson';

/** One way of asking a site: an address with `{q}` where the words go, and
 *  what kind of answer it gives. */
export interface SearchStrategy {
  kind: SearchKind;
  template: string;
}

export const QUERY_TOKEN = '{q}';

/** The address to fetch for `query`. */
export function fillTemplate(template: string, query: string): string {
  return template.split(QUERY_TOKEN).join(encodeURIComponent(query.trim()));
}

/** A search address the user typed: http(s), with `{q}` in it. Anything else
 *  is not one (returns null), so a typo cannot send every query to a page
 *  that ignores it. */
export function normalizeSearchTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t.includes(QUERY_TOKEN)) return null;
  try {
    const u = new URL(t.split(QUERY_TOKEN).join('x'));
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

// ── Where the site is ───────────────────────────────────────────────────

/** The site a feed belongs to. Usually the feed's own origin, but an
 *  aggregator's feed (Dotdash Meredith serves several sites from one API
 *  host) links to the real site: the origin most of its items link to wins.
 *  A feed under a path (sbs.com.au/food/rss) keeps that path. */
export function siteBaseFor(feedUrl: string, itemLinks: string[]): string | null {
  let feed: URL;
  try { feed = new URL(feedUrl); } catch { return null; }
  const counts = new Map<string, number>();
  for (const link of itemLinks) {
    try { const o = new URL(link).origin; counts.set(o, (counts.get(o) ?? 0) + 1); } catch { /* skip */ }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const origin = top ?? feed.origin;
  if (origin !== feed.origin) return origin;
  // The first path segment of a feed that is not the site's root feed:
  // /food/rss -> /food. A plain /feed, /rss or /rss2.xml stays the root.
  const first = feed.pathname.split('/').filter(Boolean)[0] ?? '';
  const isFeedName = /^(feed|feeds|rss|rss2|atom)(\.xml)?$/i.test(first) || /\.(xml|rss)$/i.test(first);
  return first && !isFeedName ? `${origin}/${first}` : origin;
}

// ── What a home page declares ───────────────────────────────────────────

const decodeAttr = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x2F;/gi, '/');

/** The search address a page's schema.org SearchAction gives
 *  ("https://site/search?q={search_term_string}"), with `{q}` in it. */
export function searchActionTemplates(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /"@type"\s*:\s*"SearchAction"([\s\S]{0,600}?)(?:"query-input"|\}\s*\])/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1];
    const target = /"target"\s*:\s*(?:"([^"]+)"|\{[^}]*?"urlTemplate"\s*:\s*"([^"]+)")/i.exec(body);
    const raw = target?.[1] ?? target?.[2];
    if (!raw) continue;
    const param = /\{([a-z_]+)\}/i.exec(raw)?.[1];
    if (!param) continue;
    try {
      const filled = new URL(raw.replace(/\\\//g, '/').replace(`{${param}}`, 'QUERYTOKEN'), baseUrl).href;
      out.push(filled.replace('QUERYTOKEN', QUERY_TOKEN));
    } catch { /* skip */ }
  }
  return [...new Set(out)];
}

/** The address of a page's OpenSearch descriptor, if it links one. */
export function openSearchDescriptorUrl(html: string, baseUrl: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?search/i.test(tag) || !/opensearchdescription/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { return new URL(decodeAttr(href), baseUrl).href; } catch { /* skip */ }
  }
  return null;
}

/** The HTML results address an OpenSearch descriptor declares. */
export function openSearchTemplate(xml: string, baseUrl: string): string | null {
  for (const m of xml.matchAll(/<Url\b[^>]*>/gi)) {
    const tag = m[0];
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    if (!/text\/html/i.test(type)) continue;
    const template = /template\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!template || !template.includes('{searchTerms}')) continue;
    try {
      const filled = new URL(decodeAttr(template).replace('{searchTerms}', 'QUERYTOKEN').replace(/\{[a-z:]+\?\}/gi, ''), baseUrl).href;
      return filled.replace('QUERYTOKEN', QUERY_TOKEN);
    } catch { /* skip */ }
  }
  return null;
}

/** The ways worth trying for a site, the declared ones first. */
export function candidateStrategies(base: string, declared: string[]): SearchStrategy[] {
  const root = base.replace(/\/+$/, '');
  let origin = root;
  try { origin = new URL(root).origin; } catch { /* keep */ }
  const html = (template: string): SearchStrategy => ({ kind: 'html', template });
  const list: SearchStrategy[] = [
    ...declared.map(html),
    { kind: 'wpjson', template: `${origin}/wp-json/wp/v2/search?search=${QUERY_TOKEN}&per_page=20&type=post` },
    { kind: 'feed', template: `${origin}/?s=${QUERY_TOKEN}&feed=rss2` },
    html(`${root}/search?q=${QUERY_TOKEN}`),
    html(`${root}/?s=${QUERY_TOKEN}`),
    html(`${root}/search/?q=${QUERY_TOKEN}`),
    html(`${root}/cerca?q=${QUERY_TOKEN}`),
    html(`${root}/buscar?q=${QUERY_TOKEN}`),
    html(`${root}/recherche?q=${QUERY_TOKEN}`),
  ];
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.template) ? false : (seen.add(s.template), true)));
}

// ── Reading the answers ─────────────────────────────────────────────────

/** Lowercase, accents off, words of three letters or more. */
export function queryWords(query: string): string[] {
  return [...new Set(query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** How many of the words searched a text names (accents and case aside). */
export function matchScore(text: string, words: string[]): number {
  const haystack = fold(text);
  return words.filter((w) => haystack.includes(w)).length;
}

/** The hits worth opening, best first. When some name every word searched
 *  ("zuppa di cipolle"), the ones naming only some ("zuppa inglese") go;
 *  otherwise they are kept, ranked. A hit naming none stays last: the site's
 *  own search may have matched its text, which a title does not show. */
export function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const words = queryWords(query);
  if (words.length === 0) return hits;
  const scored = hits.map((hit, i) => ({ hit, i, score: matchScore(`${hit.url} ${hit.title ?? ''}`, words) }));
  const best = Math.max(0, ...scored.map((s) => s.score));
  const kept = best === words.length && words.length > 1 ? scored.filter((s) => s.score === best) : scored;
  return kept.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.hit);
}

// Path segments of pages that are not one recipe: lists, galleries,
// articles, the site's own furniture.
const NOT_A_RECIPE = new Set([
  'search', 'cerca', 'ricerca', 'buscar', 'recherche', 'tag', 'tags', 'category', 'categories', 'categoria', 'categorie', 'categoria-receta',
  'page', 'pagina', 'author', 'autore', 'autor', 'auteur', 'gallery', 'galleries', 'galleria', 'slideshow', 'story', 'stories', 'article', 'articles',
  'articolo', 'news', 'notizie', 'video', 'videos', 'collection', 'collections', 'collezione', 'shop', 'store', 'account', 'login', 'newsletter', 'about',
  'chi-siamo', 'privacy', 'cookie', 'cookies', 'contact', 'contatti', 'feed', 'rss', 'wp-content', 'wp-admin', 'wp-json', 'cdn-cgi', 'subscribe',
  'topic', 'topics', 'menus', 'how-to', 'guide', 'guides', 'review', 'reviews', 'travel', 'podcast', 'podcasts',
]);
const RECIPE_HINT = /\/(recipe|recipes|ricetta|ricette|receta|recetas|recette|recettes|rezept|rezepte)\//i;

export interface SearchHit { url: string; title: string | null }

/** The links of a results page that could be recipes: on the site, deep
 *  enough to be one page, not a list or the site's furniture, and naming one
 *  of the words searched (in the address or the link text). Page order is
 *  kept, links that look like recipe pages first. */
export function resultLinksFromHtml(html: string, pageUrl: string, base: string, query: string): SearchHit[] {
  const words = queryWords(query);
  let origin: string;
  let basePath = '';
  try {
    const b = new URL(base);
    origin = b.origin;
    basePath = b.pathname.replace(/\/+$/, '');
  } catch { return []; }
  const page = (() => { try { return new URL(pageUrl); } catch { return null; } })();
  const seen = new Set<string>();
  const strong: SearchHit[] = [];
  const weak: SearchHit[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,600}?)<\/a>/gi)) {
    const href = /\shref\s*=\s*["']([^"'#]+)/i.exec(m[1])?.[1];
    if (!href) continue;
    let u: URL;
    try { u = new URL(decodeAttr(href), pageUrl); } catch { continue; }
    if (u.origin !== origin || u.search) continue;
    if (basePath && !u.pathname.startsWith(basePath)) continue;
    const path = u.pathname.replace(/\/+$/, '');
    if (page && path === page.pathname.replace(/\/+$/, '')) continue;
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((s) => NOT_A_RECIPE.has(s.toLowerCase()))) continue;
    const last = segments[segments.length - 1];
    // A recipe page's address ends in a slug; a section ("/recipes") does not.
    if (!/[a-z].*-|\d{3,}/i.test(last)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
    const haystack = fold(`${path} ${text}`);
    if (words.length && !words.some((w) => haystack.includes(w))) continue;
    const url = `${u.origin}${u.pathname}`;
    if (seen.has(url)) {
      // A card often links its picture first and its title after: keep the title.
      const hit = [...strong, ...weak].find((h) => h.url === url);
      if (hit && !hit.title && text) hit.title = text.slice(0, 160);
      continue;
    }
    seen.add(url);
    (RECIPE_HINT.test(`${u.pathname}/`) ? strong : weak).push({ url, title: text ? text.slice(0, 160) : null });
  }
  return [...strong, ...weak];
}

/** The posts WordPress's search API answered with. */
export function resultLinksFromWpJson(text: string, base: string): SearchHit[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(data)) return [];
  let origin = '';
  try { origin = new URL(base).origin; } catch { return []; }
  const out: SearchHit[] = [];
  for (const row of data) {
    const r = row as { url?: unknown; title?: unknown };
    if (typeof r.url !== 'string') continue;
    try { if (new URL(r.url).origin !== origin) continue; } catch { continue; }
    const title = typeof r.title === 'string' ? r.title.replace(/&#0?38;|&amp;/g, '&').replace(/&#8217;|&#0?39;/g, "'").replace(/<[^>]+>/g, '').trim() : null;
    out.push({ url: r.url, title: title || null });
  }
  return out;
}
