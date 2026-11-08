import React from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';

interface MarkdownTextProps {
  text: string | null | undefined;
  className?: string;
  /** Spans of the text that are not Markdown at all — a step's {{ing:N}}
   *  references — and how to render each. They are set aside before parsing,
   *  so an alias with an underscore or a star in it can't become markup. */
  tokenRe?: RegExp;
  renderToken?: (token: string, key: number) => React.ReactNode;
}

const OPEN = '\uE000';
const CLOSE = '\uE001';
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

/**
 * Renders recipe text written with the Markdown subset of lib/markdown.ts —
 * as React elements, never as HTML, so nothing in the text can inject
 * markup. Plain text renders as it always did: line breaks kept.
 *
 * A block container (paragraphs, lists), so it goes inside a <div>, not a
 * <p>. Styles live under `.sc-md` in index.css.
 */
export default function MarkdownText({ text, className = '', tokenRe, renderToken }: MarkdownTextProps) {
  const tokens: string[] = [];
  let source = String(text ?? '');
  if (tokenRe && renderToken) {
    source = source.replace(new RegExp(tokenRe.source, tokenRe.flags.includes('g') ? tokenRe.flags : `${tokenRe.flags}g`), (match) => {
      tokens.push(match);
      return `${OPEN}${tokens.length - 1}${CLOSE}`;
    });
  }
  let key = 0;

  const textNode = (value: string): React.ReactNode => {
    if (!tokens.length || !value.includes(OPEN)) return value;
    const parts: React.ReactNode[] = [];
    let last = 0;
    for (const m of value.matchAll(PLACEHOLDER)) {
      if (m.index! > last) parts.push(value.slice(last, m.index));
      parts.push(renderToken!(tokens[Number(m[1])], key++));
      last = m.index! + m[0].length;
    }
    if (last < value.length) parts.push(value.slice(last));
    return parts;
  };

  const inline = (nodes: Inline[]): React.ReactNode[] => nodes.map((n) => {
    const k = key++;
    switch (n.type) {
      case 'text': return <React.Fragment key={k}>{textNode(n.text)}</React.Fragment>;
      case 'strong': return <strong key={k}>{inline(n.children)}</strong>;
      case 'em': return <em key={k}>{inline(n.children)}</em>;
      case 'del': return <del key={k}>{inline(n.children)}</del>;
      case 'code': return <code key={k}>{n.text}</code>;
      case 'link': return (
        <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {inline(n.children)}
        </a>
      );
    }
  });

  const lines = (rows: Inline[][]) => rows.map((row, i) => (
    <React.Fragment key={key++}>{i > 0 && <br />}{inline(row)}</React.Fragment>
  ));

  const block = (b: Block): React.ReactNode => {
    const k = key++;
    switch (b.type) {
      case 'paragraph': return <p key={k}>{lines(b.lines)}</p>;
      case 'heading': {
        // Recipe text lives under the page's own headings: # is a section
        // title inside a card, not a second page title.
        const Tag = (['h3', 'h3', 'h4', 'h5'] as const)[b.level - 1];
        return <Tag key={k}>{inline(b.children)}</Tag>;
      }
      case 'list': return b.ordered
        ? <ol key={k} start={b.start}>{b.items.map((item) => <li key={key++}>{inline(item)}</li>)}</ol>
        : <ul key={k}>{b.items.map((item) => <li key={key++}>{inline(item)}</li>)}</ul>;
      case 'quote': return <blockquote key={k}>{lines(b.lines)}</blockquote>;
      case 'rule': return <hr key={k} />;
    }
  };

  return <div className={`sc-md ${className}`.trim()}>{parseMarkdown(source).map(block)}</div>;
}
