import { describe, expect, it } from 'vitest';
import {
  candidateStrategies, fillTemplate, normalizeSearchTemplate, openSearchDescriptorUrl, openSearchTemplate,
  queryWords, rankHits, resultLinksFromHtml, resultLinksFromWpJson, searchActionTemplates, siteBaseFor,
} from './siteSearch';

describe('templates', () => {
  it('fills the words in, encoded', () => {
    expect(fillTemplate('https://a.it/cerca?q={q}', ' pasta e fagioli ')).toBe('https://a.it/cerca?q=pasta%20e%20fagioli');
  });

  it('accepts only an http(s) address with {q} in it', () => {
    expect(normalizeSearchTemplate(' https://a.it/cerca?q={q} ')).toBe('https://a.it/cerca?q={q}');
    expect(normalizeSearchTemplate('https://a.it/cerca')).toBeNull();
    expect(normalizeSearchTemplate('ftp://a.it/?q={q}')).toBeNull();
    expect(normalizeSearchTemplate(5)).toBeNull();
  });
});

describe('siteBaseFor', () => {
  it('uses the site an aggregator feed links to', () => {
    expect(siteBaseFor('https://feeds-api.dotdashmeredith.com/v1/rss/google/abc', [
      'https://www.seriouseats.com/a-recipe', 'https://www.seriouseats.com/b-recipe', 'https://other.com/x',
    ])).toBe('https://www.seriouseats.com');
  });

  it('keeps a path a site lives under, but not a feed name', () => {
    expect(siteBaseFor('https://www.sbs.com.au/food/rss', ['https://www.sbs.com.au/food/recipe/x'])).toBe('https://www.sbs.com.au/food');
    expect(siteBaseFor('https://www.lacucinaitaliana.it/feed/rss', [])).toBe('https://www.lacucinaitaliana.it');
    expect(siteBaseFor('https://www.directoalpaladar.com/rss2.xml', [])).toBe('https://www.directoalpaladar.com');
  });
});

describe('what a home page declares', () => {
  it('reads a schema.org SearchAction', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https:\\/\\/www.lacucinaitaliana.it\\/search?q={search_term_string}","query-input":"required name=search_term_string"}}</script>`;
    expect(searchActionTemplates(html, 'https://www.lacucinaitaliana.it/')).toEqual(['https://www.lacucinaitaliana.it/search?q={q}']);
  });

  it('reads the urlTemplate form', () => {
    const html = `{"@type": "SearchAction", "target": {"@type": "EntryPoint", "urlTemplate": "/?s={query}"}, "query-input": "required name=query"}`;
    expect(searchActionTemplates(html, 'https://mocktail.net/')).toEqual(['https://mocktail.net/?s={q}']);
  });

  it('reads an OpenSearch descriptor', () => {
    expect(openSearchDescriptorUrl('<link rel="search" type="application/opensearchdescription+xml" href="/opensearch.xml" title="x">', 'https://a.it/')).toBe('https://a.it/opensearch.xml');
    const xml = `<OpenSearchDescription><Url type="application/rss+xml" template="https://a.it/rss?q={searchTerms}"/><Url type="text/html" template="https://a.it/cerca?testo={searchTerms}&amp;p={startPage?}"/></OpenSearchDescription>`;
    expect(openSearchTemplate(xml, 'https://a.it/')).toBe('https://a.it/cerca?testo={q}&p=');
  });

  it('tries the declared ways first, each address once', () => {
    const list = candidateStrategies('https://www.sbs.com.au/food', ['https://www.sbs.com.au/food/search?q={q}']);
    expect(list[0]).toEqual({ kind: 'html', template: 'https://www.sbs.com.au/food/search?q={q}' });
    expect(list.map((s) => s.kind).slice(1, 3)).toEqual(['wpjson', 'feed']);
    expect(list[1].template.startsWith('https://www.sbs.com.au/wp-json/')).toBe(true);
    expect(new Set(list.map((s) => s.template)).size).toBe(list.length);
  });
});

describe('resultLinksFromHtml', () => {
  const page = `
    <nav><a href="/recipes">Recipes</a><a href="/search?q=pasta&page=2">Next</a><a href="/tag/pasta-recipes">Pasta tag</a></nav>
    <a href="/recipe/creamy-miso-mushroom-pasta"><img src="x.jpg"></a>
    <a href="/recipe/creamy-miso-mushroom-pasta"><h3>Creamy Miso Mushroom Pasta</h3></a>
    <a href="https://www.bonappetit.com/gallery/best-pasta-recipes">31 Pasta Recipes</a>
    <a href="/story/pasta-girl-fall">Pasta girl fall</a>
    <a href="/fresh-tomato-sauce-for-pasta">Salsa</a>
    <a href="/chicken-salad-with-grapes">Chicken salad</a>
    <a href="https://elsewhere.com/recipe/pasta-bake">Elsewhere</a>
    <a href="/recipe/epi-syn-pasta-salad-recipe#reviews">Easy Pasta Salad</a>`;

  it('keeps recipe pages on the site that name the words searched', () => {
    expect(resultLinksFromHtml(page, 'https://www.bonappetit.com/search?q=pasta', 'https://www.bonappetit.com', 'pasta')).toEqual([
      { url: 'https://www.bonappetit.com/recipe/creamy-miso-mushroom-pasta', title: 'Creamy Miso Mushroom Pasta' },
      { url: 'https://www.bonappetit.com/recipe/epi-syn-pasta-salad-recipe', title: 'Easy Pasta Salad' },
      { url: 'https://www.bonappetit.com/fresh-tomato-sauce-for-pasta', title: 'Salsa' },
    ]);
  });

  it('matches words without their accents', () => {
    const html = '<a href="/ricetta/primi/pasta-alla-norma-3/">Pasta alla Norma</a><a href="/ricetta/creme-brulee/">Crème brûlée</a>';
    expect(resultLinksFromHtml(html, 'https://www.lacucinaitaliana.it/search/?q=x', 'https://www.lacucinaitaliana.it', 'crème').map((h) => h.url))
      .toEqual(['https://www.lacucinaitaliana.it/ricetta/creme-brulee/']);
  });

  it('stays under the path the site lives in', () => {
    const html = '<a href="/food/recipe/pasta-bake-123">Pasta bake</a><a href="/news/pasta-prices-rise-2026">Prices</a><a href="/sport/pasta-party-abc">Party</a>';
    expect(resultLinksFromHtml(html, 'https://www.sbs.com.au/food/search?q=pasta', 'https://www.sbs.com.au/food', 'pasta').map((h) => h.url))
      .toEqual(['https://www.sbs.com.au/food/recipe/pasta-bake-123']);
  });
});

describe('resultLinksFromWpJson', () => {
  it('reads the posts on the site', () => {
    const json = JSON.stringify([
      { id: 1, title: 'Blueberry Lime Mocktail', url: 'https://mocktail.net/blueberry-lime-mocktail/' },
      { id: 2, title: 'Around the World &#038; back', url: 'https://mocktail.net/around/' },
      { id: 3, title: 'Elsewhere', url: 'https://other.net/x/' },
    ]);
    expect(resultLinksFromWpJson(json, 'https://mocktail.net')).toEqual([
      { url: 'https://mocktail.net/blueberry-lime-mocktail/', title: 'Blueberry Lime Mocktail' },
      { url: 'https://mocktail.net/around/', title: 'Around the World & back' },
    ]);
    expect(resultLinksFromWpJson('<html>', 'https://mocktail.net')).toEqual([]);
  });
});

describe('queryWords', () => {
  it('folds accents and drops short words', () => {
    expect(queryWords('Pasta e Fagioli, crème')).toEqual(['pasta', 'fagioli', 'creme']);
  });
});

describe('rankHits', () => {
  const hits = [
    { url: 'https://b.com/recipe/zuppa-inglese', title: 'Zuppa Inglese' },
    { url: 'https://b.com/recipe/onion-soup', title: 'Zuppa di cipolle gratinata' },
    { url: 'https://b.com/recipe/smoothie', title: 'Tropical smoothie' },
  ];

  it('keeps only the hits naming every word, when there are some', () => {
    expect(rankHits(hits, 'zuppa di cipolle').map((h) => h.title)).toEqual(['Zuppa di cipolle gratinata']);
  });

  it('otherwise ranks them, keeping the ones the site matched on its text last', () => {
    expect(rankHits(hits, 'zuppa').map((h) => h.title)).toEqual(['Zuppa Inglese', 'Zuppa di cipolle gratinata', 'Tropical smoothie']);
    expect(rankHits(hits, 'cipolle rosse').map((h) => h.title)).toEqual(['Zuppa di cipolle gratinata', 'Zuppa Inglese', 'Tropical smoothie']);
  });
});
