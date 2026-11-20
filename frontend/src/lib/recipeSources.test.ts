import { describe, expect, it } from 'vitest';
import { hasSource, mergedSources, normalizeSourceUrl, parseSources, sourceLinks, unionSources } from './recipeSources';

describe('parseSources', () => {
  it('reads JSON text and arrays, dropping empty entries', () => {
    expect(parseSources('[{"type":"url","url":"https://a.it/x"},{"type":"book"}]')).toEqual([{ type: 'url', url: 'https://a.it/x' }]);
    expect(parseSources([{ type: 'book', label: ' Artusi ' }])).toEqual([{ type: 'book', label: 'Artusi' }]);
    expect(parseSources('not json')).toEqual([]);
    expect(parseSources(null)).toEqual([]);
  });

  it('repairs an unknown type from what the entry holds', () => {
    expect(parseSources([{ type: 'weird', url: 'https://a.it' }])[0].type).toBe('url');
    expect(parseSources([{ label: 'Nonna' }])[0].type).toBe('other');
  });
});

describe('normalizeSourceUrl', () => {
  it('treats scheme, www, trailing slash and fragment as the same page', () => {
    const a = normalizeSourceUrl('https://www.Example.com/ricette/zuppa/');
    expect(normalizeSourceUrl('http://example.com/ricette/zuppa#commenti')).toBe(a);
  });

  it('keeps the query string, which can name a different page', () => {
    expect(normalizeSourceUrl('https://a.it/r?id=1')).not.toBe(normalizeSourceUrl('https://a.it/r?id=2'));
  });
});

describe('unionSources', () => {
  it('keeps every source once, first occurrence first', () => {
    const out = unionSources(
      [{ type: 'url', label: 'Originale', url: 'https://a.it/zuppa' }],
      [{ type: 'url', url: 'http://www.a.it/zuppa/' }, { type: 'book', label: 'Artusi' }],
      [{ type: 'book', label: 'artusi' }, { type: 'video', url: 'https://v.it/1' }],
    );
    expect(out).toEqual([
      { type: 'url', label: 'Originale', url: 'https://a.it/zuppa' },
      { type: 'book', label: 'Artusi' },
      { type: 'video', url: 'https://v.it/1' },
    ]);
  });

  it('does not confuse a book and a note with the same label', () => {
    expect(unionSources([{ type: 'book', label: 'Nonna' }], [{ type: 'other', label: 'Nonna' }])).toHaveLength(2);
  });
});

describe('mergedSources', () => {
  it('folds both import pages into the list', () => {
    const out = mergedSources(
      { sources: '[{"type":"url","label":"Ricetta originale","url":"https://a.it/zuppa"}]', source_url: 'https://a.it/zuppa' },
      { sources: '[]', source_url: 'https://b.fr/soupe' },
    );
    expect(out.map((s) => s.url)).toEqual(['https://a.it/zuppa', 'https://b.fr/soupe']);
    expect(hasSource(out, { type: 'url', url: 'https://www.b.fr/soupe/' })).toBe(true);
  });
});

describe('sourceLinks', () => {
  it('lists the http(s) links only, each once', () => {
    expect(sourceLinks({
      source_url: 'https://a.it/zuppa',
      sources: [{ type: 'url', url: 'https://a.it/zuppa/' }, { type: 'book', label: 'Artusi' }, { type: 'video', url: 'https://v.it/1' }, { type: 'url', url: 'ftp://x' }],
    })).toEqual(['https://a.it/zuppa', 'https://v.it/1']);
  });
});
