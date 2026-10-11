// ════════════════════════════════════════════════════════════════════════
// SmartChef — do the ingredient list and the steps tell the same recipe?
//
// A recipe can end up with an ingredient list that belongs to one version of
// the dish and steps that belong to another: two recipes merged, one written
// from raw ingredients and the other from a bought one that skips a step
// ("pasta sfoglia" against "farina, burro, uova"). Nothing in the editor said
// so, and the AI check could only mutter it as a free-text note.
//
// This is the detection half, kept pure so it is testable without a model:
//
//   - which ingredient rows no step uses or names (found by code, no model);
//   - which ingredients the steps name that the list does not have (the model
//     proposes them, each with a quote, and code throws away what it cannot
//     verify — same rule as every other proposal in lib/recipeCheck.ts).
//
// The user is only asked which side to believe when the steps name something
// the list lacks; unused rows alone stay a note, since an ingredient can be
// used without being named ("the rest", "everything above").
// ════════════════════════════════════════════════════════════════════════

import { findMention } from './nameMatch';
import { normalizeName } from './stepRefs';

export interface MismatchUnused {
  index: number;
  label: string;
}

export interface MismatchUnlisted {
  /** The ingredient as the steps call it. */
  name: string;
  /** Index of the step that names it. */
  step: number;
  /** The step's own words, verbatim. */
  quote: string;
}

export interface IngredientMismatch {
  /** List rows no step links to or names. */
  unused: MismatchUnused[];
  /** Ingredients the steps name that the list does not have. */
  unlisted: MismatchUnlisted[];
  /** The model's one-line description of the disagreement, if it gave one. */
  summary: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Row indexes no step uses: no `stepIngredients` link, and the ingredient's
 *  name is nowhere in any step's text (tokens already read as their words). */
export function findUnusedIngredients(
  labels: string[],
  stepTexts: string[],
  linkedRows: Set<number>,
): MismatchUnused[] {
  const out: MismatchUnused[] = [];
  labels.forEach((label, index) => {
    if (!label.trim() || linkedRows.has(index)) return;
    if (stepTexts.some((text) => findMention(text, [label], 'noun'))) return;
    out.push({ index, label });
  });
  return out;
}

/** True when `name` is already one of the list's ingredients, loosely: the
 *  same words, or one name containing the other ("burro" / "burro morbido"). */
export function isListed(name: string, labels: string[]): boolean {
  const key = normalizeName(name);
  if (!key) return true;
  return labels.some((label) => {
    const k = normalizeName(label);
    return !!k && (k === key || k.includes(key) || key.includes(k) || !!findMention(name, [label], 'noun'));
  });
}

/**
 * Turns the model's `mismatch` answer into what can be proven. `stepTexts` are
 * the steps as the cook reads them; a proposal survives only if its quote is
 * really in the step it names, the quote really holds the ingredient's name,
 * and the list really lacks it.
 */
export function interpretMismatch(
  raw: any,
  labels: string[],
  stepTexts: string[],
  unused: MismatchUnused[],
): IngredientMismatch | null {
  const normalized = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const unlisted: MismatchUnlisted[] = [];
  const seen = new Set<string>();

  for (const row of (Array.isArray(raw?.unlisted) ? raw.unlisted : []).slice(0, 16)) {
    const name = str(row?.name);
    const quote = str(row?.quote);
    const step = Number.isInteger(row?.step) ? (row.step as number) : -1;
    if (!name || !quote || name.length > 80 || !stepTexts[step]) continue;
    if (!normalized(stepTexts[step]).includes(normalized(quote))) continue;
    if (!findMention(quote, [name], 'noun')) continue;
    if (isListed(name, labels)) continue;
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unlisted.push({ name, step, quote });
  }

  if (unlisted.length === 0) return null;
  return { unused, unlisted, summary: str(raw?.summary) };
}
