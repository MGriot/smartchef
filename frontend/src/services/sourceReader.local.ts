// ════════════════════════════════════════════════════════════════════════
// SmartChef — reading a recipe's reference pages for the AI actions
//
// Fetches the links a recipe cites (its `sources` and the page it was
// imported from) and turns each into text for the model — see
// lib/sourcePages.ts for why. A page that cannot be read is reported, not
// fatal: the check or the merge goes on with the ones that could.
// ════════════════════════════════════════════════════════════════════════

import { fetchPageHtml, extractSocialCaption } from './pageFetcher';
import { extractRecipeFromHtml } from './recipeStructuredData';
import { htmlToPlainText } from './llmParser.local';
import { normalizeSourceUrl, sourceLinks } from '../lib/recipeSources';
import { pageRecipeToText, pickSourceLinks, SOURCE_PAGE_CHARS, type SourcePage } from '../lib/sourcePages';

const CONCURRENCY = 3;

// One dialog asks for the same pages several times (the first proposal,
// then every chat turn); a page is fetched once per app session.
const cache = new Map<string, Promise<SourcePage>>();

function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1].replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 160) : undefined;
}

async function readOne(url: string): Promise<SourcePage> {
  try {
    const html = await fetchPageHtml(url);
    const structured = extractRecipeFromHtml(html, url);
    if (structured) return { url, ok: true, title: structured.title, text: pageRecipeToText(structured) };
    const text = (extractSocialCaption(url, html) ?? htmlToPlainText(html)).slice(0, SOURCE_PAGE_CHARS);
    if (text.trim().length < 80) return { url, ok: false, text: '', error: 'empty' };
    return { url, ok: true, title: pageTitle(html), text };
  } catch (err) {
    return { url, ok: false, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reads `urls`, a few at a time, in the order given. */
export async function readSourcePages(urls: string[]): Promise<SourcePage[]> {
  const out: SourcePage[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) {
      const key = normalizeSourceUrl(urls[i]);
      let pending = cache.get(key);
      if (!pending) {
        pending = readOne(urls[i]);
        cache.set(key, pending);
        // A failure is not remembered: the next attempt may find the site up.
        void pending.then((page) => { if (!page.ok) cache.delete(key); });
      }
      out[i] = await pending;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

/** The reference pages of one or more recipes: each recipe's first links
 *  before anyone's further ones, a shared page once. */
export async function readRecipeSources(recipes: Array<{ sources?: unknown; source_url?: unknown }>): Promise<SourcePage[]> {
  const links = pickSourceLinks(recipes.map(sourceLinks), normalizeSourceUrl);
  return links.length ? readSourcePages(links) : [];
}

export function resetSourceReaderCache(): void {
  cache.clear();
}
