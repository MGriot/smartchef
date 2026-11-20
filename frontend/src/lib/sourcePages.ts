// ════════════════════════════════════════════════════════════════════════
// SmartChef — a recipe's reference pages, as text an AI can read
//
// "Check with AI" and the AI merge used to see a reference as a bare URL.
// The page behind it is where the recipe came from: it states the servings,
// the times and the amounts the saved recipe may have lost, and two saved
// copies of one dish usually differ exactly where their pages differ.
//
// This turns a fetched page into a compact, bounded text: the structured
// recipe when the page publishes one (schema.org), otherwise its plain
// text. Pure — the fetching is in services/sourceReader.local.ts.
// ════════════════════════════════════════════════════════════════════════

/** How much of one page is handed to the model. A structured recipe fits
 *  well inside it; a plain page is cut where the import parser cuts it. */
export const SOURCE_PAGE_CHARS = 6000;
/** Pages read for one recipe, and for one request (a merge of several). */
export const MAX_PAGES_PER_RECIPE = 4;
export const MAX_PAGES_PER_REQUEST = 8;

export interface SourcePage {
  url: string;
  /** False when the page could not be fetched or had nothing readable. */
  ok: boolean;
  title?: string;
  /** The page's recipe as text; '' when not ok. */
  text: string;
  /** Why it could not be read, in words for the user. */
  error?: string;
}

/** The subset of a parsed page recipe this needs (TemplateParseResult fits). */
export interface PageRecipe {
  title?: string;
  description?: string;
  servings?: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  ingredients: Array<{ name: string; quantity?: number; quantityText?: string; unit?: string; notes?: string; groupName?: string | null }>;
  steps: Array<{ title?: string; description: string; durationMin?: number }>;
}

const clip = (text: string, max = SOURCE_PAGE_CHARS) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A structured page recipe as the lines a cook would read. */
export function pageRecipeToText(r: PageRecipe): string {
  const lines: string[] = [];
  if (r.title) lines.push(r.title);
  if (r.description) lines.push(r.description);
  const facts = [
    r.servings ? `Servings: ${r.servings}` : null,
    r.prepTimeMin ? `Prep time: ${r.prepTimeMin} min` : null,
    r.cookTimeMin ? `Cook time: ${r.cookTimeMin} min` : null,
    r.restTimeMin ? `Rest time: ${r.restTimeMin} min` : null,
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (r.ingredients.length) {
    lines.push('Ingredients:');
    let group: string | null = null;
    for (const i of r.ingredients) {
      if ((i.groupName ?? null) !== group) {
        group = i.groupName ?? null;
        if (group) lines.push(`[${group}]`);
      }
      lines.push(`- ${[i.quantity != null ? String(i.quantity) : i.quantityText, i.unit, i.name, i.notes ? `(${i.notes})` : null].filter(Boolean).join(' ')}`);
    }
  }
  if (r.steps.length) {
    lines.push('Steps:');
    r.steps.forEach((s, n) => {
      lines.push(`${n + 1}. ${[s.title ? `${s.title}:` : null, s.description, s.durationMin ? `(${s.durationMin} min)` : null].filter(Boolean).join(' ')}`);
    });
  }
  return clip(lines.join('\n'));
}

/** The links to read for a request, in order: every recipe gets its first
 *  few before any recipe gets more, and a page two recipes share is read once. */
export function pickSourceLinks(perRecipe: string[][], normalize: (url: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let round = 0; round < MAX_PAGES_PER_RECIPE && out.length < MAX_PAGES_PER_REQUEST; round++) {
    for (const links of perRecipe) {
      const url = links[round];
      if (!url || out.length >= MAX_PAGES_PER_REQUEST) continue;
      const key = normalize(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}

/** What the model is shown: the readable pages only. */
export function sourcePagesForModel(pages: SourcePage[]): Array<{ url: string; title: string | null; text: string }> {
  return pages.filter((p) => p.ok && p.text).map((p) => ({ url: p.url, title: p.title ?? null, text: p.text }));
}

/** What the user is shown: which references were read, which were not. */
export function sourcesReadSummary(pages: SourcePage[]): Array<{ url: string; ok: boolean; title?: string; error?: string }> {
  return pages.map((p) => ({ url: p.url, ok: p.ok, ...(p.title ? { title: p.title } : {}), ...(p.error ? { error: p.error } : {}) }));
}
