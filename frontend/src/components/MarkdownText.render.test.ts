import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownText from './MarkdownText';
import RenderStepText from './RenderStepText';

const md = (text: string) => renderToStaticMarkup(createElement(MarkdownText, { text }));

describe('MarkdownText', () => {
  it('renders the subset as elements and keeps line breaks', () => {
    expect(md('**Non** mescolare\ntroppo\n\n- uno\n- due'))
      .toBe('<div class="sc-md"><p><strong>Non</strong> mescolare<br/>troppo</p><ul><li>uno</li><li>due</li></ul></div>');
  });

  it('never lets HTML in the text through', () => {
    const html = md('<img src=x onerror=alert(1)> **ok**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('opens links in a new window', () => {
    expect(md('[fonte](https://example.com)')).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">fonte</a>');
  });
});

describe('RenderStepText with Markdown', () => {
  it('expands references inside formatted text, and an alias never becomes markup', () => {
    const html = renderToStaticMarkup(createElement(RenderStepText, {
      text: '**Aggiungi** {{ing:0|as=_burro_}} e mescola',
      ingredients: [{ sortOrder: 0, name: 'Burro', quantity: '50 g' }],
      tools: [],
      techniques: [],
    }));
    expect(html).toContain('<strong>Aggiungi</strong>');
    expect(html).toContain('50 g _burro_');
    expect(html).not.toContain('<em>');
  });
});
