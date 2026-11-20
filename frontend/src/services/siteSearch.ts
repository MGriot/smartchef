// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Search the sites": a query sent to every saved recipe site
//
// For each site: find where it lives (lib/siteSearch.ts's siteBaseFor), try
// its ways of searching until one answers (remembered per site, so the next
// query goes straight there), then open the first few results and keep the
// ones that publish a recipe (schema.org Recipe, the same check the import
// makes). Results reach the page as each one is confirmed.
//
// Fetching goes through fetchPageHtml, so it works wherever import works:
// the native bridge on Android and the desktop app, the server otherwise.
// ════════════════════════════════════════════════════════════════════════

import { fetchPageHtml, extractPageImage } from './pageFetcher';
import { extractRecipeFromHtml } from './recipeStructuredData';
import { peekDiscover } from './feeds';
import { parseFeed, looksLikeFeed } from '../lib/feedParser';
import type { FeedSource } from '../lib/feedSources';
import {
  candidateStrategies, fillTemplate, normalizeSearchTemplate, openSearchDescriptorUrl, openSearchTemplate,
  matchScore, queryWords, rankHits, resultLinksFromHtml, resultLinksFromWpJson, searchActionTemplates, siteBaseFor,
  type SearchHit, type SearchStrategy,
} from '../lib/siteSearch';

export interface SiteRecipe {
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  image: string | null;
  totalMin: number | null;
  servings: number | null;
  /** How many of the words searched its title names: the order results are shown in. */
  score: number;
}

export type SiteStatus =
  | { state: 'searching' }
  | { state: 'done'; found: number }
  /** No way of searching this site answered. */
  | { state: 'unsearchable' }
  /** The site refused or could not be reached. */
  | { state: 'failed'; error: string };

export interface SiteSearchProgress {
  results: SiteRecipe[];
  status: Record<string, SiteStatus>;
}

/** Results opened per site to check they are recipes. */
const CHECK_PER_SITE = 6;
/** Pages fetched at once, across all sites: each is parsed on the UI thread,
 *  and on Android every byte crosses the plugin bridge. */
const CONCURRENCY = 4;
const STRATEGY_KEY = 'smartchef.siteSearch.strategies';
/** A site found to have no usable search is asked again after this long. */
const RETRY_UNSEARCHABLE_MS = 7 * 24 * 60 * 60_000;

type Remembered = { base: string; strategy: SearchStrategy | null; at: number };

function remembered(): Record<string, Remembered> {
  try { return JSON.parse(localStorage.getItem(STRATEGY_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function remember(id: string, entry: Remembered) {
  try {
    const all = remembered();
    all[id] = entry;
    localStorage.setItem(STRATEGY_KEY, JSON.stringify(all));
  } catch { /* a per-device convenience: fine to lose */ }
}

export function forgetSiteSearch(id?: string) {
  try {
    if (!id) { localStorage.removeItem(STRATEGY_KEY); return; }
    const all = remembered();
    delete all[id];
    localStorage.setItem(STRATEGY_KEY, JSON.stringify(all));
  } catch { /* nothing to forget */ }
}

// A small shared queue, so ten sites times six result pages never means
// sixty requests at once.
function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T,>(job: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try { return await job(); } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

async function siteBase(source: FeedSource, fetchPage: (url: string) => Promise<string>): Promise<string | null> {
  const cached = peekDiscover([source])?.items.map((i) => i.link) ?? [];
  if (cached.length) return siteBaseFor(source.feedUrl, cached);
  try {
    const xml = await fetchPage(source.feedUrl);
    return siteBaseFor(source.feedUrl, parseFeed(xml, 20).items.map((i) => i.link));
  } catch {
    return siteBaseFor(source.feedUrl, []);
  }
}

/** The ways the home page declares (SearchAction, OpenSearch). */
async function declaredTemplates(base: string, fetchPage: (url: string) => Promise<string>): Promise<string[]> {
  let home = '';
  try { home = await fetchPage(`${base}/`); } catch { return []; }
  const out = searchActionTemplates(home, `${base}/`);
  const descriptor = openSearchDescriptorUrl(home, `${base}/`);
  if (descriptor) {
    try {
      const template = openSearchTemplate(await fetchPage(descriptor), descriptor);
      if (template) out.push(template);
    } catch { /* the declared page may still work */ }
  }
  return out;
}

/** The results one strategy gives, or null when it is not a way this site searches. */
async function ask(strategy: SearchStrategy, base: string, query: string, fetchPage: (url: string) => Promise<string>): Promise<SearchHit[] | null> {
  const url = fillTemplate(strategy.template, query);
  const text = await fetchPage(url);
  if (strategy.kind === 'wpjson') {
    const trimmed = text.trimStart();
    return trimmed.startsWith('[') ? resultLinksFromWpJson(trimmed, base) : null;
  }
  if (strategy.kind === 'feed') {
    if (!looksLikeFeed(text)) return null;
    return parseFeed(text, 20).items.map((i) => ({ url: i.link, title: i.title || null }));
  }
  // A results page names the query somewhere (the search box, the heading);
  // a page that does not is a home page or an error the site served instead.
  const hits = resultLinksFromHtml(text, url, base, query);
  return hits.length ? hits : null;
}

/** Searches one site: the hits, or a status saying why there are none. */
async function searchSite(
  source: FeedSource,
  query: string,
  fetchPage: (url: string) => Promise<string>,
): Promise<{ hits: SearchHit[] } | { status: SiteStatus }> {
  const manual = normalizeSearchTemplate(source.searchUrl);
  const known = remembered()[source.id];
  const base = known?.base ?? (await siteBase(source, fetchPage));
  if (!base) return { status: { state: 'unsearchable' } };

  if (manual) {
    try {
      return { hits: (await ask({ kind: 'html', template: manual }, base, query, fetchPage)) ?? [] };
    } catch (err) {
      return { status: { state: 'failed', error: err instanceof Error ? err.message : String(err) } };
    }
  }

  if (known && !known.strategy && Date.now() - known.at < RETRY_UNSEARCHABLE_MS) return { status: { state: 'unsearchable' } };
  if (known?.strategy) {
    try {
      const hits = await ask(known.strategy, base, query, fetchPage);
      // No results for this query is an answer; only a wrong kind of page
      // means the remembered way stopped working.
      if (hits) return { hits };
    } catch { /* fall through to finding a way again */ }
  }

  let lastError: string | null = null;
  for (const strategy of candidateStrategies(base, await declaredTemplates(base, fetchPage))) {
    try {
      const hits = await ask(strategy, base, query, fetchPage);
      if (hits) {
        remember(source.id, { base, strategy, at: Date.now() });
        return { hits };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  // Every way failed outright (blocked, offline): say so, and do not
  // remember the site as unsearchable for what may be a passing problem.
  if (lastError && /\b(40[1-3]|429|5\d\d)\b|network|timed? ?out|fetch failed|failed to fetch|refused|ENOTFOUND|ECONN/i.test(lastError)) {
    return { status: { state: 'failed', error: lastError } };
  }
  remember(source.id, { base, strategy: null, at: Date.now() });
  return { status: { state: 'unsearchable' } };
}

/** Opens a hit and turns it into a result, or null when it is not a recipe. */
async function checkHit(source: FeedSource, hit: SearchHit, words: string[], fetchPage: (url: string) => Promise<string>): Promise<SiteRecipe | null> {
  let html: string;
  try { html = await fetchPage(hit.url); } catch { return null; }
  const recipe = extractRecipeFromHtml(html, hit.url);
  if (!recipe || recipe.ingredients.length === 0) return null;
  const total = (recipe.prepTimeMin ?? 0) + (recipe.cookTimeMin ?? 0) + (recipe.restTimeMin ?? 0);
  let image = extractPageImage(hit.url, html);
  if (!image && recipe.imageUrl) {
    try { image = new URL(recipe.imageUrl, hit.url).href; } catch { image = null; }
  }
  const title = recipe.title && recipe.title !== 'Untitled recipe' ? recipe.title : hit.title ?? hit.url;
  return {
    sourceId: source.id,
    sourceName: source.name,
    url: hit.url,
    title,
    score: matchScore(`${title} ${hit.url}`, words),
    image,
    totalMin: total > 0 ? total : null,
    servings: recipe.servings ?? null,
  };
}

/** Sends `query` to every source, handing the results so far to `onUpdate`
 *  as they are confirmed. `isCurrent` lets the page abandon a search the
 *  user replaced: once it says false, nothing more is fetched or reported. */
export async function searchSites(
  sources: FeedSource[],
  query: string,
  onUpdate: (progress: SiteSearchProgress) => void,
  isCurrent: () => boolean = () => true,
  fetchPage: (url: string) => Promise<string> = fetchPageHtml,
): Promise<SiteSearchProgress> {
  const q = query.trim();
  const progress: SiteSearchProgress = { results: [], status: Object.fromEntries(sources.map((s) => [s.id, { state: 'searching' } as SiteStatus])) };
  if (!q) return progress;
  const words = queryWords(q);
  const run = limiter(CONCURRENCY);
  const limited = (url: string) => run(() => (isCurrent() ? fetchPage(url) : Promise.reject(new Error('cancelled'))));
  const emit = () => { if (isCurrent()) onUpdate({ results: [...progress.results], status: { ...progress.status } }); };
  emit();

  await Promise.all(sources.map(async (source) => {
    const found = await searchSite(source, q, limited).catch((err) => ({ status: { state: 'failed', error: String(err) } as SiteStatus }));
    if (!isCurrent()) return;
    if ('status' in found) {
      progress.status[source.id] = found.status;
      emit();
      return;
    }
    const seen = new Set(progress.results.map((r) => r.url));
    const hits = rankHits(found.hits.filter((h) => !seen.has(h.url)), q).slice(0, CHECK_PER_SITE);
    let count = 0;
    await Promise.all(hits.map(async (hit) => {
      const recipe = await checkHit(source, hit, words, limited);
      if (!recipe || !isCurrent() || progress.results.some((r) => r.url === recipe.url)) return;
      progress.results.push(recipe);
      // Best matches first; the order the sites answered in breaks ties.
      progress.results.sort((a, b) => b.score - a.score);
      count++;
      emit();
    }));
    progress.status[source.id] = { state: 'done', found: count };
    emit();
  }));
  return progress;
}
