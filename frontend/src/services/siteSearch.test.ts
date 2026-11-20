// "Search the sites" against three made-up sites: one that declares its
// search on its home page, one that blocks the app, one with no search the
// app can read. No network: fetchPage is a table of pages.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./feeds', () => ({ peekDiscover: () => null }));
vi.mock('./pageFetcher', async (original) => ({
  ...(await original<typeof import('./pageFetcher')>()),
  fetchPageHtml: async () => { throw new Error('not used: the test passes its own fetchPage'); },
}));

const recipePage = (name: string, image = 'https://good.it/img.jpg') => `<html><head><meta property="og:image" content="${image}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe","name":"${name}","recipeYield":"4","prepTime":"PT10M","cookTime":"PT40M",
"recipeIngredient":["1 kg cipolle","150 g Emmentaler"],"recipeInstructions":[{"@type":"HowToStep","text":"Stufate."}]}</script></head><body></body></html>`;

const pages: Record<string, string> = {
  'https://good.it/feed/': '<rss><channel><item><title>x</title><link>https://good.it/ricetta/x-1/</link></item></channel></rss>',
  'https://good.it/': '<script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https://good.it/cerca?testo={search_term_string}","query-input":"required name=search_term_string"}}</script>',
  'https://good.it/cerca?testo=zuppa%20di%20cipolle': `
    <a href="/ricetta/zuppa-di-cipolle-gratinata/">Zuppa di cipolle gratinata</a>
    <a href="/ricetta/zuppa-inglese/">Zuppa inglese</a>
    <a href="/articolo/storia-della-zuppa-di-cipolle/">Storia</a>
    <a href="/ricetta/zuppa-di-cipolle-rosse/">Zuppa di cipolle rosse</a>
    <a href="/ricetta/cipolle-e-zuppa-non-ricetta/">Una pagina senza ricetta</a>`,
  'https://good.it/ricetta/zuppa-di-cipolle-gratinata/': recipePage('Zuppa di cipolle gratinata'),
  'https://good.it/ricetta/zuppa-di-cipolle-rosse/': recipePage('Zuppa di cipolle rosse'),
  'https://good.it/ricetta/zuppa-inglese/': recipePage('Zuppa inglese'),
  'https://good.it/ricetta/cipolle-e-zuppa-non-ricetta/': '<html><body>Niente ricetta qui</body></html>',
  'https://plain.it/feed/': '<rss><channel></channel></rss>',
  'https://plain.it/': '<html>home</html>',
};

const fetchPage = vi.fn(async (url: string) => {
  if (url.startsWith('https://blocked.com')) throw new Error('This site answered with HTTP 402');
  const page = pages[url];
  if (page === undefined) throw new Error('This site answered with HTTP 404');
  return page;
});

const sources = [
  { id: 'good', name: 'Good', feedUrl: 'https://good.it/feed/' },
  { id: 'blocked', name: 'Blocked', feedUrl: 'https://blocked.com/feed/' },
  { id: 'plain', name: 'Plain', feedUrl: 'https://plain.it/feed/' },
];

describe('searchSites', () => {
  it('finds recipes through the declared search, checks them, and says why the others gave none', async () => {
    const { searchSites } = await import('./siteSearch');
    const updates: number[] = [];
    const out = await searchSites(sources, 'zuppa di cipolle', (p) => updates.push(p.results.length), () => true, fetchPage);

    expect(out.results.map((r) => r.title).sort()).toEqual(['Zuppa di cipolle gratinata', 'Zuppa di cipolle rosse']);
    expect(out.results[0]).toMatchObject({ sourceId: 'good', sourceName: 'Good', totalMin: 50, servings: 4, image: 'https://good.it/img.jpg', score: 2 });
    // "Zuppa inglese" names only one of the words: not even opened.
    expect(fetchPage).not.toHaveBeenCalledWith('https://good.it/ricetta/zuppa-inglese/');
    expect(out.status).toEqual({
      good: { state: 'done', found: 2 },
      blocked: { state: 'failed', error: 'This site answered with HTTP 402' },
      plain: { state: 'unsearchable' },
    });
    // Results reached the page as they were confirmed, not all at the end.
    expect(updates).toContain(1);
  });

  it('uses the site\'s own search address when the user typed one', async () => {
    const { searchSites } = await import('./siteSearch');
    pages['https://plain.it/ricerca/zuppa%20di%20cipolle'] = '<a href="/ricette/zuppa-di-cipolle-al-forno">Zuppa di cipolle al forno</a>';
    pages['https://plain.it/ricette/zuppa-di-cipolle-al-forno'] = recipePage('Zuppa di cipolle al forno');
    const out = await searchSites([{ ...sources[2], searchUrl: 'https://plain.it/ricerca/{q}' }], 'zuppa di cipolle', () => {}, () => true, fetchPage);
    expect(out.results.map((r) => r.url)).toEqual(['https://plain.it/ricette/zuppa-di-cipolle-al-forno']);
  });

  it('stops fetching once the search was replaced', async () => {
    const { searchSites } = await import('./siteSearch');
    fetchPage.mockClear();
    let current = true;
    const out = await searchSites(sources, 'zuppa di cipolle', () => { current = false; }, () => current, fetchPage);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
  });
});
