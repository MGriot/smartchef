// ════════════════════════════════════════════════════════════════════════
// SmartChef — schema.org Recipe extraction (no AI)
//
// Most recipe sites publish their recipe as machine-readable JSON-LD in a
// <script type="application/ld+json"> block, because Google's rich results
// require it. Reading that is instant and exact. Until now every URL import
// went the other way: llm.parser.ts's fetchUrlContent() stripped the tags
// off the page with regexes, truncated the remainder to 6 000 characters
// and handed it to a language model — minutes of CPU inference per import,
// and anything past the truncation silently lost.
//
// This runs first. The LLM path is unchanged and still handles blogs and
// prose that carry no structured data.
//
// ── Why this lives in the frontend, and both modes call it ──────────────
// Runtime code cannot live in shared/: the backend's "@shared/*" tsconfig
// path is a compile-time construct only — a runtime import emits
// require("@shared/...") verbatim, which has no resolver in the built
// image (verified). Rather than keep two copies in step forever, the
// extractor lives here and both modes feed it HTML:
//   - standalone: fetched through the Electron/Android HTTP bridge
//   - server mode: fetched by POST /api/recipes/fetch-page, which keeps
//     the SSRF guard server-side where it belongs
// so there is exactly one implementation and one set of tests.
//
// ── Deliberately JSON-LD only ──────────────────────────────────────────
// Microdata (itemprop="recipeIngredient") would need a real DOM, which
// isn't available in every context this runs in, and a regex approximation
// of one is the kind of thing that half-works forever. Sites without
// JSON-LD fall through to the LLM, which is what it is for.
// ════════════════════════════════════════════════════════════════════════

import { parseAmount } from '../lib/ingredientAmount';
import type { TemplateParseResult, TemplateParseIngredient, TemplateParseStep } from './recipeTemplateParser';

/** Pulls the contents of every <script type="application/ld+json"> block.
 *  Attribute order and quoting vary between sites, hence the loose
 *  attribute match rather than an exact string. */
function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]?.trim()) blocks.push(m[1].trim());
  }
  return blocks;
}

function isRecipeNode(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== 'object') return false;
  const t = (node as Record<string, unknown>)['@type'];
  if (typeof t === 'string') return t.toLowerCase() === 'recipe';
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && x.toLowerCase() === 'recipe');
  return false;
}

/** Walks a parsed JSON-LD document for the first Recipe node. Sites nest it
 *  in every imaginable way: a bare object, a top-level array, an @graph, or
 *  buried under a WebPage's mainEntity. */
function findRecipeNode(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  if (isRecipeNode(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    if (key in obj) {
      const found = findRecipeNode(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** schema.org fields are string | string[] | {...} depending on the site.
 *  Everything below funnels through these two so no call site has to care. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = firstString(item);
      if (s) return s;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // {"@type":"ImageObject","url":"..."} and {"name":"..."} both appear
    return firstString(obj.url ?? obj.name ?? obj.text);
  }
  return undefined;
}

/** For keyword-ish fields, where a single comma-joined string is as common
 *  as a real array: "vegetarian, quick, italian". */
function stringList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringList(item));
  }
  const s = firstString(value);
  return s ? [s] : [];
}

/** For recipeIngredient, which must NOT be comma-split: a comma inside an
 *  ingredient line separates the name from its note ("1 celery stick,
 *  finely chopped"), not one ingredient from the next. Splitting it turned
 *  that single line into two ingredients — "celery stick" and an orphaned
 *  "finely chopped" — on real pages. */
function stringItems(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringItems(item));
  }
  const s = firstString(value);
  return s ? [s] : [];
}

/** ISO-8601 durations ("PT1H30M") → minutes. Days are included because a
 *  few slow-cook recipes really do use P1D. */
export function isoDurationToMinutes(value: unknown): number | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;
  const m = raw.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return undefined;
  const [, d, h, min, sec] = m;
  const total =
    (d ? parseFloat(d) * 1440 : 0) +
    (h ? parseFloat(h) * 60 : 0) +
    (min ? parseFloat(min) : 0) +
    (sec ? parseFloat(sec) / 60 : 0);
  return total > 0 ? Math.round(total) : undefined;
}

/** recipeYield is "4", 4, "4 servings", "Serves 4", or ["4","4 servings"]. */
export function parseYield(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const raw = firstString(candidate);
    if (!raw) continue;
    const m = raw.match(/\d+(?:[.,]\d+)?/);
    if (m) {
      const n = Math.round(parseFloat(m[0].replace(',', '.')));
      if (n > 0) return n;
    }
  }
  return undefined;
}

/** Ingredient lines arrive as free prose from any site — "200 g plain
 *  flour, sifted", "2 large eggs", "Salt to taste". This is best-effort by
 *  design: the Import screen's review step exists precisely so a wrong
 *  guess is corrected before anything is saved, and a bare name is a much
 *  better outcome than dropping the line. */
export function parseIngredientLine(raw: string): TemplateParseIngredient | null {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return null;

  // Leading amount: digits, fractions ("1/2"), unicode vulgar fractions, or
  // a mixed number ("1 1/2"). parseAmount() is the codebase's single
  // amount-reading implementation — see lib/ingredientAmount.ts.
  const amountMatch = line.match(/^((?:\d+\s+)?\d+\s*\/\s*\d+|[¼-¾⅐-⅞]|\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!amountMatch) return { name: stripNotes(line).name, notes: stripNotes(line).notes };

  const [, amountRaw, rest] = amountMatch;
  const quantity = parseAmount(amountRaw);

  // A unit is a short alphabetic token immediately after the amount. Kept
  // deliberately narrow: matching too eagerly turns "2 eggs" into 2 of unit
  // "eggs", which is worse than leaving the unit blank.
  const unitMatch = rest.match(/^([a-zA-Zà-ÿ]{1,14}\.?)\s+(.+)$/);
  let unit: string | undefined;
  let remainder = rest;
  if (unitMatch && KNOWN_UNITS.has(unitMatch[1].toLowerCase().replace(/\.$/, ''))) {
    unit = unitMatch[1].replace(/\.$/, '');
    remainder = unitMatch[2];
  }

  const { name, notes } = stripNotes(remainder);
  return {
    name: name || line,
    quantity,
    quantityText: amountRaw.trim(),
    unit,
    notes,
  };
}

/** Pulls the notes out of an ingredient's text, in the three shapes real
 *  pages use, all of which can appear on one line:
 *
 *    "2.5 pounds (1.1kg) mixed tomatoes, cut into pieces (about 6 cups)"
 *                ^leading aside        ^comma note     ^trailing note
 *
 *  The leading parenthetical is a metric/imperial equivalent of the amount
 *  just consumed (US sites do this constantly) — it belongs to neither the
 *  name nor the notes, so it is dropped rather than left glued to the front
 *  of the ingredient name.
 */
function stripNotes(text: string): { name: string; notes?: string } {
  let rest = text.trim();
  const notes: string[] = [];

  const leadingAside = rest.match(/^\(([^)]*)\)\s*(.+)$/);
  if (leadingAside) rest = leadingAside[2].trim();

  const trailing = rest.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (trailing && trailing[1].trim()) {
    rest = trailing[1].trim();
    if (trailing[2].trim()) notes.push(trailing[2].trim());
  }

  const comma = rest.indexOf(',');
  if (comma > 0) {
    const after = rest.slice(comma + 1).trim();
    rest = rest.slice(0, comma).trim();
    if (after) notes.unshift(after);
  }

  return { name: rest, notes: notes.length ? notes.join('; ') : undefined };
}

// Only tokens that are unambiguously units. Anything absent here stays part
// of the ingredient name, which the review step can fix — the reverse
// (a name swallowed as a unit) is invisible and much harder to spot. Long
// forms are listed alongside abbreviations because real pages write
// "2.5 pounds tomatoes" as often as "2.5 lb".
const KNOWN_UNITS = new Set([
  // mass
  'g', 'gr', 'gram', 'grams', 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'mg',
  'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  // volume
  'ml', 'cl', 'dl', 'l', 'lt', 'litre', 'litres', 'liter', 'liters',
  'tsp', 'tsps', 'teaspoon', 'teaspoons',
  'tbsp', 'tbsps', 'tbs', 'tablespoon', 'tablespoons',
  'cup', 'cups', 'pint', 'pints', 'quart', 'quarts', 'gallon', 'gallons', 'fl',
  // countable / imprecise
  'pinch', 'pinches', 'dash', 'dashes', 'clove', 'cloves', 'slice', 'slices',
  'sprig', 'sprigs', 'stick', 'sticks', 'can', 'cans', 'tin', 'tins', 'jar', 'jars',
  // it
  'grammi', 'chilo', 'chili', 'cucchiaio', 'cucchiai', 'cucchiaino', 'cucchiaini',
  'tazza', 'tazze', 'pizzico', 'pizzichi', 'spicchio', 'spicchi', 'fetta', 'fette',
  'litro', 'litri', 'bicchiere', 'bicchieri',
  // fr
  'cuillère', 'cuillere', 'cuillères', 'cuilleres', 'tasse', 'tasses',
  'pincée', 'pincee', 'gousse', 'gousses', 'tranche', 'tranches',
  // es
  'cucharada', 'cucharadas', 'cucharadita', 'cucharaditas', 'taza', 'tazas',
  'pizca', 'pizcas', 'diente', 'dientes', 'rebanada', 'rebanadas',
]);

/** recipeInstructions is a string, an array of strings, an array of
 *  HowToStep, or an array of HowToSection each holding its own steps. */
function parseInstructions(value: unknown): TemplateParseStep[] {
  const steps: TemplateParseStep[] = [];

  const pushText = (text: string | undefined, title?: string) => {
    const clean = text?.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    steps.push({ stepNumber: steps.length + 1, description: clean, title });
  };

  const walk = (node: unknown, sectionTitle?: string, depth = 0) => {
    if (depth > 4 || !node) return;

    if (typeof node === 'string') {
      // A single blob of prose with numbered or newline-separated steps is
      // common; splitting it beats one giant step.
      const parts = node.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) parts.forEach((p) => pushText(p.replace(/^\d+[.)]\s*/, ''), sectionTitle));
      else pushText(node, sectionTitle);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, sectionTitle, depth + 1));
      return;
    }

    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const type = firstString(obj['@type'])?.toLowerCase();
      if (type === 'howtosection') {
        const title = firstString(obj.name);
        walk(obj.itemListElement ?? obj.steps, title, depth + 1);
        return;
      }
      // HowToStep, or anything else carrying text
      pushText(firstString(obj.text ?? obj.description ?? obj.name), sectionTitle);
    }
  };

  walk(value);
  return steps;
}

/** Strips tags from schema.org fields that are allowed to contain HTML
 *  (description especially). */
function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

export interface StructuredExtraction extends TemplateParseResult {
  /** Cover image URL from the page, when it published one. */
  imageUrl?: string;
}

/**
 * Reads a schema.org Recipe out of a page's JSON-LD.
 *
 * Returns `null` when the page has no usable structured recipe — the
 * caller then falls back to the LLM path, unchanged. A node with no
 * ingredients AND no steps counts as unusable: some sites emit a stub
 * Recipe node for breadcrumbs, and importing that would produce an empty
 * recipe rather than an honest failure.
 */
export function extractRecipeFromHtml(html: string, sourceUrl?: string): StructuredExtraction | null {
  if (!html) return null;

  for (const block of jsonLdBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue; // one malformed block shouldn't stop the others
    }

    const node = findRecipeNode(parsed);
    if (!node) continue;

    const ingredients = stringItems(node.recipeIngredient ?? node.ingredients)
      .map(parseIngredientLine)
      .filter((i): i is TemplateParseIngredient => i !== null);
    const steps = parseInstructions(node.recipeInstructions);

    if (ingredients.length === 0 && steps.length === 0) continue;

    const warnings: string[] = [];
    if (ingredients.length === 0) warnings.push('The page listed no ingredients.');
    if (steps.length === 0) warnings.push('The page listed no instructions.');

    const title = stripHtml(firstString(node.name)) ?? 'Untitled recipe';

    const prepTimeMin = isoDurationToMinutes(node.prepTime);
    const cookTimeMin = isoDurationToMinutes(node.cookTime);
    const totalTimeMin = isoDurationToMinutes(node.totalTime);

    return {
      title,
      description: stripHtml(firstString(node.description)),
      language: firstString(node.inLanguage)?.slice(0, 2).toLowerCase(),
      servings: parseYield(node.recipeYield),
      prepTimeMin,
      // A site that publishes only totalTime still knows something worth
      // keeping — record it as cook time rather than dropping it. Never
      // overrides a real cookTime, and never double-counts a prepTime the
      // total already includes.
      cookTimeMin: cookTimeMin ?? (prepTimeMin === undefined ? totalTimeMin : undefined),
      restTimeMin: undefined,
      difficulty: undefined,
      tags: [
        ...stringList(node.recipeCategory),
        ...stringList(node.recipeCuisine),
        ...stringList(node.keywords),
      ]
        .map((t) => t.trim())
        .filter((t, i, all) => t.length > 0 && t.length <= 40 && all.indexOf(t) === i)
        .slice(0, 12),
      tools: [],
      storageInstructions: null,
      tips: null,
      ingredients,
      steps,
      warnings,
      sourceUrl,
      imageUrl: firstString(node.image),
    };
  }

  return null;
}
