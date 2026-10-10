// ════════════════════════════════════════════════════════════════════════
// SmartChef — finding a name in a step's prose
//
// Import turns the first mention of an ingredient, tool or technique in a
// step into an inline {{ing:N}} / {{tool:id}} / {{tech:id}} reference. The
// name the model (or the library) gives is rarely letter-for-letter what the
// prose says: "Uova" against "un uovo", "Farina 00" against "la farina",
// "Sbattere" against "sbatti". So a name is matched by its stem, with a short
// ending allowed, and always on a whole word — "forno" never links inside
// "fornaio". Pure, so it is testable without the import page.
// ════════════════════════════════════════════════════════════════════════

export type NameKind = 'noun' | 'verb';

/** Same length as the input, accents removed and lower-cased, so an index
 *  found in the folded text is the same index in the original. */
function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += (s[i].normalize('NFD')[0] ?? s[i]).toLowerCase();
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LINK_STOPWORDS = new Set([
  'il', 'lo', 'la', 'le', 'gli', 'un', 'uno', 'una', 'di', 'del', 'della', 'dei', 'delle', 'da', 'in', 'con', 'per', 'al', 'alla',
  'the', 'of', 'and', 'with', 'for', 'de', 'du', 'des', 'el', 'los', 'las', 'en', 'et', 'y', 'e', 'a', 'an',
]);

/** The part of a word that stays the same across its plural, feminine or
 *  conjugated forms, plus how many letters may follow it. */
function stemOf(word: string, kind: NameKind): { stem: string; tail: string } {
  const w = word;
  if (w.length < 4) return { stem: w, tail: kind === 'noun' && w.length === 3 ? 's?' : '' };
  if (kind === 'verb') {
    const stripped = w.replace(/(are|ere|ire|ar|er|ir|re)$/, '');
    const stem = stripped.length >= 3 ? stripped : /[aeiou]$/.test(w) ? w.slice(0, -1) : w;
    return stem.length >= 3 ? { stem, tail: '[a-z]{0,4}' } : { stem: w, tail: '' };
  }
  let stem = w;
  if (stem.endsWith('s') && !stem.endsWith('ss') && stem.length >= 5) stem = stem.slice(0, -1);
  if (/[aeiou]$/.test(stem) && stem.length >= 4) stem = stem.slice(0, -1);
  return { stem, tail: '(?:[aeiou]|es|s)?' };
}

/** Every wording worth trying for one name, longest first: the name as given,
 *  without digits and parentheses ("Farina 00" → "Farina"), and its first
 *  significant word ("Olio extravergine" → "Olio"). */
export function nameVariants(name: string): string[] {
  const full = name.trim();
  const cleaned = full.replace(/\([^)]*\)/g, ' ').replace(/\d+([.,]\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
  const words = fold(cleaned).split(/[^a-z0-9]+/).filter((w) => w && !LINK_STOPWORDS.has(w));
  const out = [full, cleaned];
  if (words.length > 1 && words[0].length >= 4) out.push(words[0]);
  return [...new Set(out.filter((n) => fold(n).replace(/[^a-z0-9]/g, '').length >= 3))].sort((a, b) => b.length - a.length);
}

function patternFor(variant: string, kind: NameKind): RegExp | null {
  const words = fold(variant).split(/[^a-z0-9]+/).filter((w) => w && !LINK_STOPWORDS.has(w));
  if (!words.length) return null;
  const parts = words.map((w) => {
    const { stem, tail } = stemOf(w, kind);
    return escapeRe(stem) + tail;
  });
  return new RegExp(String.raw`(?<![a-z0-9])` + parts.join(String.raw`[^a-z0-9]+(?:(?:il|lo|la|le|un|una|di|del|della|in|nel|nella|al|alla|a|da|de|the|of|and|with)[^a-z0-9]+)?`) + String.raw`(?![a-z0-9])`, 'g');
}

/** Spans of {{…}} references already in the text, which a match must not
 *  land inside ("{{ing:3}}" contains the letters "ing"). */
function tokenSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(/\{\{[^}]*\}\}/g)].map((m) => [m.index!, m.index! + m[0].length]);
}

/** The first whole-word mention of any of `names` in `text`, or null. Names
 *  are tried longest first, so "stand mixer" wins over "mixer". */
export function findMention(text: string, names: string[], kind: NameKind): { start: number; end: number } | null {
  if (!text) return null;
  const folded = fold(text);
  const spans = tokenSpans(text);
  const variants = [...new Set(names.flatMap(nameVariants))].sort((a, b) => b.length - a.length);
  for (const variant of variants) {
    const re = patternFor(variant, kind);
    if (!re) continue;
    for (const m of folded.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!spans.some(([s, e]) => start < e && end > s)) return { start, end };
    }
  }
  return null;
}
