// ════════════════════════════════════════════════════════════════════════
// SmartChef — The Markdown subset recipe text understands
//
// Descriptions, steps, notes and tips are typed into plain textareas, and
// people already write "**non** mescolare" or a "- " list there out of
// habit. This reads that subset into a small tree that
// components/MarkdownText.tsx renders as React elements — never as HTML,
// so nothing a recipe (or a synced/shared/imported one) contains can inject
// markup or script.
//
// Deliberately small, and in-house rather than a CommonMark library: the
// Electron build is Chromium 114 and recipe text needs only this much —
//
//   blocks:  paragraphs (single newlines kept as line breaks, the way the
//            text was typed), "#"–"####" headings, "-"/"*"/"+" and "1."
//            lists, "> " quotes, "---" rules;
//   inline:  **bold** / __bold__, *italic* / _italic_, ~~struck~~, `code`,
//            [text](https://…) and bare http(s) links.
//
// An underscore only counts at a word boundary, so snake_case and
// "q.b._extra" stay text. Anything that isn't one of the above is text,
// exactly as written.
// ════════════════════════════════════════════════════════════════════════

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { type: 'quote'; lines: Inline[][] }
  | { type: 'rule' };

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/y;

/** Parses inline markup. Unclosed markers are left as the text they are. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ type: 'text', text }); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#>+\-.!]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (m && SAFE_HREF.test(m[2])) {
        flush();
        out.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    if (ch === 'h' && (rest.startsWith('http://') || rest.startsWith('https://'))) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(src);
      const prev = src[i - 1];
      if (m && (!prev || !/[\p{L}\p{N}]/u.test(prev))) {
        flush();
        out.push({ type: 'link', href: m[0], children: [{ type: 'text', text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    const pair = (marker: string, type: 'strong' | 'em' | 'del', underscore = false): boolean => {
      if (!rest.startsWith(marker)) return false;
      const after = src[i + marker.length];
      if (!after || /\s/.test(after)) return false;
      if (underscore && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])) return false;
      let from = i + marker.length;
      while (from < src.length) {
        let end = src.indexOf(marker, from);
        if (end < 0) return false;
        // "***" closing "**molto *adagio***": the bold closes on the run's
        // last two stars, leaving the first to close the italic inside.
        if (marker.length === 2) while (src[end + 2] === marker[0]) end++;
        const before = src[end - 1];
        const next = src[end + marker.length];
        const closes = end > i + marker.length && !/\s/.test(before)
          && (!underscore || !next || !/[\p{L}\p{N}]/u.test(next))
          // "**" must not be read as the closer of a single "*".
          && !(marker === '*' && (src[end + 1] === '*' || before === '*'));
        if (closes) {
          flush();
          out.push({ type, children: parseInline(src.slice(i + marker.length, end)) });
          i = end + marker.length;
          return true;
        }
        from = end + marker.length;
      }
      return false;
    };
    if ((ch === '*' && (pair('**', 'strong') || pair('*', 'em')))
      || (ch === '_' && (pair('__', 'strong', true) || pair('_', 'em', true)))
      || (ch === '~' && pair('~~', 'del'))) continue;

    text += ch;
    i++;
  }
  flush();
  return out;
}

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Parses a text field into blocks. */
export function parseMarkdown(src: string | null | undefined): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: Inline[][] | null = null;
  const endPara = () => { if (para) { blocks.push({ type: 'paragraph', lines: para }); para = null; } };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim()) { endPara(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      blocks.push({ type: 'heading', level: heading[1].length as 1 | 2 | 3 | 4, children: parseInline(heading[2].trim()) });
      continue;
    }
    if (RULE.test(line)) { endPara(); blocks.push({ type: 'rule' }); continue; }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      endPara();
      const isOrdered = !!ordered;
      const items: Inline[][] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      for (; n < lines.length; n++) {
        const m = isOrdered ? ORDERED.exec(lines[n]) : BULLET.exec(lines[n]);
        if (m) { items.push(parseInline((isOrdered ? m[2] : m[1]).trim())); continue; }
        // An indented line continues the item above it.
        if (items.length && /^\s{2,}\S/.test(lines[n])) {
          items[items.length - 1].push({ type: 'text', text: ' ' }, ...parseInline(lines[n].trim()));
          continue;
        }
        n--;
        break;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      endPara();
      const quoted: Inline[][] = [];
      for (; n < lines.length; n++) {
        const m = QUOTE.exec(lines[n]);
        if (!m) { n--; break; }
        quoted.push(parseInline(m[1]));
      }
      blocks.push({ type: 'quote', lines: quoted });
      continue;
    }

    if (!para) para = [];
    para.push(parseInline(line));
  }
  endPara();
  return blocks;
}

function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.text : inlineText(n.children))).join('');
}

/** The text with its markup taken off, for a one-line preview (a card's
 *  clamped description) or anywhere markup can't render. */
export function stripMarkdown(src: string | null | undefined): string {
  return parseMarkdown(src).map((b) => {
    switch (b.type) {
      case 'paragraph': case 'quote': return b.lines.map(inlineText).join(' ');
      case 'heading': return inlineText(b.children);
      case 'list': return b.items.map(inlineText).join(' · ');
      case 'rule': return '';
    }
  }).filter(Boolean).join(' ');
}

/** True when the text uses any markup at all — a plain text can keep
 *  rendering through its old, cheaper path. */
export function hasMarkdown(src: string | null | undefined): boolean {
  return parseMarkdown(src).some((b) =>
    b.type !== 'paragraph' || b.lines.some((line) => line.some((n) => n.type !== 'text')));
}
