// ════════════════════════════════════════════════════════════════════════
// SmartChef — Ingredient amount parsing & repair
//
// Recipe sources write amounts as fractions far more often than as
// decimals ("½ cipolla", "1/2 onion", "¼ tazza"), and neither import path
// understood them:
//
//   - recipeTemplateParser.ts's parseFirstNumber() matched /[\d]+/ on the
//     captured amount, so "1/2" produced quantity 1 — double the real
//     amount, silently.
//   - The AI path had it worse. The model split "½ carota" into
//     quantity: 1 and notes: "/2", so the recipe both doubled the amount
//     AND carried a nonsense note that showed up in the UI and in exports
//     as "1.5 Carrot, /2". Confirmed against the user's own library: every
//     occurrence is an integer quantity plus a stranded "/N" in notes
//     (Spezzatino di cinghiale: Carrot, Onion; Korean Fried chicken:
//     Soy Sauce, Rice Vinegar, Sugar, Water, Cashews).
//
// This module is the one place both paths now go through — see
// parseIngredientLine() in recipeTemplateParser.ts and beginReview() in
// pages/RecipeImport.tsx, which is the shared funnel for the local parser
// and the AI response alike.
// ════════════════════════════════════════════════════════════════════════

/** Unicode vulgar fractions. A source that writes "½" rather than "1/2"
 *  used to yield no number at all (the digit regex never matched), so the
 *  amount was dropped entirely rather than merely halved. */
const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅐': 1 / 7, '⅛': 0.125, '⅜': 0.375,
  '⅝': 0.625, '⅞': 0.875, '⅑': 1 / 9, '⅒': 0.1,
};

const VULGAR_CHARS = Object.keys(VULGAR_FRACTIONS).join('');

/** Rounded to 4 decimals so 1/3 stores as 0.3333 rather than a value whose
 *  decimal expansion leaks into every rendered amount. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Parses the leading amount of a free-text quantity.
 *
 * Handles, in order of precedence: mixed numbers ("1 1/2", "1½"), bare
 * fractions ("3/4"), vulgar fractions ("½"), and plain decimals with
 * either separator ("1.5", "1,5"). Returns undefined when there's no
 * number at all.
 *
 * A range ("3-4 eggs") yields its first value — the same best-effort
 * choice the parser already made, since an import draft is reviewed by
 * hand before it's saved.
 */
export function parseAmount(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const s = String(text).trim();
  if (!s) return undefined;

  // "1 1/2" / "1-1/2" — whole part plus a fraction.
  const mixed = s.match(/^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)/);
  if (mixed) {
    const denominator = Number(mixed[3]);
    if (denominator !== 0) return round(Number(mixed[1]) + Number(mixed[2]) / denominator);
  }

  // "1½" — whole part immediately followed by a vulgar fraction.
  const mixedVulgar = s.match(new RegExp(`^(\\d+)\\s*([${VULGAR_CHARS}])`));
  if (mixedVulgar) return round(Number(mixedVulgar[1]) + VULGAR_FRACTIONS[mixedVulgar[2]]);

  // "3/4".
  const fraction = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (denominator !== 0) return round(Number(fraction[1]) / denominator);
  }

  // A leading vulgar fraction on its own.
  const vulgar = s.match(new RegExp(`^([${VULGAR_CHARS}])`));
  if (vulgar) return round(VULGAR_FRACTIONS[vulgar[1]]);

  const decimal = s.match(/\d+(?:[.,]\d+)?/);
  if (decimal) return round(parseFloat(decimal[0].replace(',', '.')));

  return undefined;
}

export interface IngredientAmount {
  quantity?: number | null;
  quantityText?: string | null;
  notes?: string | null;
}

/** A standalone "/4" — a denominator whose numerator was torn off and
 *  parsed as the quantity. Bounded to 1-2 digits and required to be
 *  delimited so a genuine note mentioning a date or a ratio
 *  ("cook 1/2 hour") isn't mistaken for one. */
const STRANDED_DENOMINATOR = /(^|[\s·•\-–—,;(])\/(\d{1,2})(?=$|[\s·•\-–—,;)])/;

/** Trailing/leading separator debris left behind after removing a token. */
function tidyNotes(notes: string): string | null {
  const cleaned = notes
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*([·•])\s*([·•])\s*/g, ' $1 ')
    .replace(/^[\s·•\-–—,;]+/, '')
    .replace(/[\s·•\-–—,;]+$/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Repairs an ingredient amount that an importer split badly, and fills in
 * a missing numeric quantity from its own free text.
 *
 * The repair is deliberately narrow: it fires only when the quantity is a
 * positive integer AND the notes carry a stranded "/N", which together
 * are unambiguous — an integer numerator and a delimited bare denominator
 * are two halves of one fraction, not a note anybody wrote on purpose.
 * Anything less clear-cut is left exactly as imported, since a wrong
 * "repair" of a real note is worse than the odd stray token.
 */
export function repairIngredientAmount(input: IngredientAmount): IngredientAmount {
  let { quantity, quantityText, notes } = input;

  if (typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 0 && notes) {
    const stranded = notes.match(STRANDED_DENOMINATOR);
    if (stranded) {
      const denominator = Number(stranded[2]);
      if (denominator > 0) {
        quantity = round(quantity / denominator);
        notes = tidyNotes(notes.replace(STRANDED_DENOMINATOR, '$1'));
      }
    }
  }

  // No numeric amount, but the free text has one — "½ cucchiaino" comes
  // through the AI path as quantityText with a null quantity, and without
  // this the ingredient scales as if it had no amount at all.
  if ((quantity === null || quantity === undefined) && quantityText) {
    const parsed = parseAmount(quantityText);
    if (parsed !== undefined) quantity = parsed;
  }

  return { quantity, quantityText, notes };
}
