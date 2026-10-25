import { describe, it, expect } from 'vitest';
import { parseInline, parseMarkdown, stripMarkdown, hasMarkdown } from './markdown';

describe('parseInline', () => {
  it('reads bold, italic, strike and code', () => {
    expect(parseInline('**non** mescolare')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'non' }] },
      { type: 'text', text: ' mescolare' },
    ]);
    expect(parseInline('*adagio* e _lento_')).toEqual([
      { type: 'em', children: [{ type: 'text', text: 'adagio' }] },
      { type: 'text', text: ' e ' },
      { type: 'em', children: [{ type: 'text', text: 'lento' }] },
    ]);
    expect(parseInline('~~zucchero~~ `180°C`')).toEqual([
      { type: 'del', children: [{ type: 'text', text: 'zucchero' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: '180°C' },
    ]);
  });

  it('nests italic inside bold', () => {
    expect(parseInline('**molto *adagio***')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'molto ' }, { type: 'em', children: [{ type: 'text', text: 'adagio' }] }] },
    ]);
  });

  it('leaves snake_case, lone stars and unclosed markers as text', () => {
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', text: '2 * 3 = 6' }]);
    expect(parseInline('**aperto')).toEqual([{ type: 'text', text: '**aperto' }]);
  });

  it('links only to safe addresses', () => {
    expect(parseInline('[la ricetta](https://example.com/a)')).toEqual([
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'la ricetta' }] },
    ]);
    expect(parseInline('[x](javascript:alert(1))').some((n) => n.type === 'link')).toBe(false);
  });

  it('turns bare URLs into links without their trailing punctuation', () => {
    expect(parseInline('Vedi https://example.com/x.')).toEqual([
      { type: 'text', text: 'Vedi ' },
      { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'https://example.com/x' }] },
      { type: 'text', text: '.' },
    ]);
  });

  it('honours backslash escapes', () => {
    expect(parseInline('\\*non corsivo\\*')).toEqual([{ type: 'text', text: '*non corsivo*' }]);
  });
});

describe('parseMarkdown', () => {
  it('keeps single newlines as line breaks within a paragraph', () => {
    const blocks = parseMarkdown('riga uno\nriga due\n\naltro');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'paragraph', lines: [[{ text: 'riga uno' }], [{ text: 'riga due' }]] });
  });

  it('reads headings, lists, quotes and rules', () => {
    const blocks = parseMarkdown('## Impasto\n- farina\n- uova\n\n1. impasta\n2. riposa\n\n> consiglio\n\n---');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'list', 'quote', 'rule']);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ text: 'farina' }], [{ text: 'uova' }]] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 1 });
  });

  it('handles CRLF and empty input', () => {
    expect(parseMarkdown('a\r\nb')).toHaveLength(1);
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
  });
});

describe('stripMarkdown / hasMarkdown', () => {
  it('strips markup for previews', () => {
    expect(stripMarkdown('**Torta** della _nonna_\n\n- mele\n- farina')).toBe('Torta della nonna mele · farina');
  });

  it('tells plain text from marked-up text', () => {
    expect(hasMarkdown('solo testo\nsu due righe')).toBe(false);
    expect(hasMarkdown('con **grassetto**')).toBe(true);
    expect(hasMarkdown('- lista')).toBe(true);
  });
});
