// ════════════════════════════════════════════════════════════════════════
// SmartChef — the Discover view's list of feed sources
//
// A source is a site's RSS/Atom feed. The list is a synced setting
// (`discover.sources`), so this module imports nothing: the settings
// registry needs its validator before React mounts.
//
// Every default below was checked live to return a readable feed of recipe
// or food posts. Sites that publish no feed, or that block non-browser
// requests (Liquor.com, Food.com, Difford's Guide, Banco Fresco, Chef in
// Camicia, BBC Food), are deliberately absent — adding them by hand reports
// why instead of showing an empty list.
// ════════════════════════════════════════════════════════════════════════

export interface FeedSource {
  id: string;
  name: string;
  feedUrl: string;
}

export const DISCOVER_SOURCES = 'discover.sources';

const DDM = 'https://feeds-api.dotdashmeredith.com/v1/rss/google';

export const DEFAULT_FEED_SOURCES: FeedSource[] = [
  { id: 'seriouseats', name: 'Serious Eats', feedUrl: `${DDM}/ad57d421-0ff5-41e7-a5da-f2167b6d7f7a` },
  { id: 'allrecipes', name: 'Allrecipes', feedUrl: `${DDM}/afd5e9ea-c220-419e-9135-d8457772e240` },
  { id: 'simplyrecipes', name: 'Simply Recipes', feedUrl: `${DDM}/239d0eb0-7325-4400-8d4b-edad471df6c3` },
  { id: 'bonappetit', name: 'Bon Appétit', feedUrl: 'https://www.bonappetit.com/feed/recipes-rss-feed/rss' },
  { id: 'saveur', name: 'Saveur', feedUrl: 'https://www.saveur.com/feed/' },
  { id: 'bbcgoodfood', name: 'BBC Good Food', feedUrl: 'https://www.bbcgoodfood.com/rss' },
  { id: 'sbsfood', name: 'SBS Food', feedUrl: 'https://www.sbs.com.au/food/rss' },
  { id: 'lacucinaitaliana', name: 'La Cucina Italiana', feedUrl: 'https://www.lacucinaitaliana.it/feed/rss' },
  { id: 'directoalpaladar', name: 'Directo al Paladar', feedUrl: 'https://www.directoalpaladar.com/rss2.xml' },
  { id: 'mocktail', name: 'Mocktail.net', feedUrl: 'https://mocktail.net/feed/' },
  { id: 'imbibe', name: 'Imbibe', feedUrl: 'https://imbibemagazine.com/feed/' },
];

export const MAX_FEED_SOURCES = 40;

const isHttpUrl = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Validator for the synced setting. Anything that is not a list falls back
 *  to the defaults; entries that are not a named http(s) feed are dropped,
 *  and an empty list the user chose stays empty. */
export function parseFeedSources(raw: unknown): FeedSource[] {
  if (!Array.isArray(raw)) return DEFAULT_FEED_SOURCES;
  const seen = new Set<string>();
  const out: FeedSource[] = [];
  for (const row of raw) {
    const r = row as Partial<FeedSource> | null;
    if (!r || typeof r.id !== 'string' || !r.id.trim() || typeof r.name !== 'string' || !r.name.trim() || !isHttpUrl(r.feedUrl)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: r.name.trim().slice(0, 80), feedUrl: r.feedUrl });
    if (out.length >= MAX_FEED_SOURCES) break;
  }
  return out;
}

/** A stable id for a source the user adds: the feed's host plus a short hash
 *  of its URL, so two feeds from one site do not collide. */
export function feedSourceId(feedUrl: string): string {
  let h = 0;
  for (let i = 0; i < feedUrl.length; i++) h = (Math.imul(31, h) + feedUrl.charCodeAt(i)) | 0;
  let host = 'feed';
  try { host = new URL(feedUrl).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  return `${host}-${(h >>> 0).toString(36)}`;
}
