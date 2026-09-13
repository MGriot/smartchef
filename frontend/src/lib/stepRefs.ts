// ════════════════════════════════════════════════════════════════════════
// SmartChef — Inline step-reference tokens
//
// A step description carries references to the recipe's own ingredients,
// the tool library and the technique library as tokens:
//
//   {{ing:<sortOrder>}}   {{tool:<toolId>}}   {{tech:<techniqueId>}}
//
// with an optional parameter string after a `|`. The parameter string is a
// `;`-separated list; a chunk shaped `key=value` is a directive, anything
// else is free text (which is what {{tech:...|10 min/180°C}} has always
// meant and still does).
//
// Two directives exist:
//
//   as=<text>   render this text instead of the entity's catalog name, so
//               a step can read "setaccia la farina" while still pointing
//               at "Farina di grano tipo 00". The options offered in the
//               editor come from the entity's synonyms — the alternate
//               names that were already being stored for search and had
//               nowhere to be used.
//   q=<text>    the amount this step uses. `q=` with an empty value means
//               "name only, no amount" — otherwise an ingredient reference
//               prints the amount the step consumes, which is not always
//               wanted mid-sentence.
//
// Why `q=` exists at all: the step's own stepIngredients row already
// records how much of an ingredient the step uses, and that is what the
// renderer prefers because it scales with the servings slider. But the
// token is also the thing the author reads and edits by hand, and a bare
// {{ing:10}} sitting next to a "500 g" picked in the insert popover looked
// (correctly) like the amount had been thrown away. The editor therefore
// writes the amount into the token as well and keeps it in step with later
// edits — see syncIngredientRefAmount().
// ════════════════════════════════════════════════════════════════════════

export type StepRefType = 'ing' | 'tool' | 'tech';

export interface StepRefParams {
  /** `as=` — label to render instead of the catalog name. */
  alias?: string;
  /** `q=` — amount text. An empty string means "render no amount at all",
   *  which is different from `undefined` ("no opinion, use the data"). */
  amount?: string;
  /** Anything that wasn't a `key=value` directive — technique details. */
  free?: string;
}

/** Matches one token and splits off its raw parameter string. */
export const STEP_REF_RE = /\{\{(ing|tool|tech):([^}|]+)(?:\|([^}]*))?\}\}/g;

const DIRECTIVE_RE = /^\s*(as|q)\s*=([\s\S]*)$/;

export function parseRefParams(raw?: string | null): StepRefParams {
  const out: StepRefParams = {};
  if (!raw) return out;
  const free: string[] = [];
  for (const chunk of raw.split(';')) {
    const m = DIRECTIVE_RE.exec(chunk);
    if (!m) {
      if (chunk.trim()) free.push(chunk.trim());
      continue;
    }
    if (m[1] === 'as') out.alias = m[2].trim();
    else out.amount = m[2].trim();
  }
  if (free.length > 0) out.free = free.join('; ');
  return out;
}

export function formatRefParams(params: StepRefParams): string {
  const parts: string[] = [];
  if (params.alias) parts.push(`as=${params.alias}`);
  // `amount: ''` is meaningful ("no amount") so this tests for undefined,
  // not for falsiness.
  if (params.amount !== undefined) parts.push(`q=${params.amount}`);
  if (params.free) parts.push(params.free);
  return parts.join(';');
}

export function buildRef(type: StepRefType, id: string | number, params: StepRefParams = {}): string {
  const tail = formatRefParams(params);
  return `{{${type}:${id}${tail ? `|${tail}` : ''}}}`;
}

/**
 * Rewrites the `q=` directive on every {{ing:<sortOrder>}} token in `text`.
 *
 * Called whenever the amount a step uses of an ingredient changes anywhere
 * other than the insert popover (the per-step ingredient list's % slider,
 * its exact-amount fields, unticking it entirely) so the token never keeps
 * claiming an amount the recipe no longer says. `amount === null` strips
 * the directive and lets the renderer fall back to the recipe's own data.
 *
 * A token whose `q=` is deliberately empty ("name only") is left alone:
 * that is an authoring choice about this sentence, not a stale copy of an
 * amount.
 */
export function syncIngredientRefAmount(text: string, sortOrder: number, amount: string | null): string {
  if (!text) return text;
  return text.replace(STEP_REF_RE, (whole, type: string, id: string, raw: string | undefined) => {
    if (type !== 'ing' || id.trim() !== String(sortOrder)) return whole;
    const params = parseRefParams(raw);
    if (params.amount === '') return whole;
    if (amount === null) delete params.amount;
    else params.amount = amount;
    return buildRef('ing', id.trim(), params);
  });
}

/** Shifts/drops {{ing:N}} references after an ingredient row is deleted —
 *  the text equivalent of what removeIngredient() does to stepIngredients.
 *  A reference to the deleted row itself is left pointing nowhere on
 *  purpose: silently deleting the word out of the middle of a sentence is
 *  worse than showing "[ingredient]" where the author can see it. */
export function reindexIngredientRefs(text: string, removedSortOrder: number): string {
  if (!text) return text;
  return text.replace(STEP_REF_RE, (whole, type: string, id: string, raw: string | undefined) => {
    if (type !== 'ing') return whole;
    const n = parseInt(id.trim(), 10);
    if (!Number.isFinite(n) || n <= removedSortOrder) return whole;
    return buildRef('ing', n - 1, parseRefParams(raw));
  });
}

// ── Per-step amounts ────────────────────────────────────────────────────
// A step's stepIngredients row says how much of a recipe ingredient that
// step uses, either as a fraction of the total or as an exact amount. Both
// the editor and every reader (view mode, kitchen mode, the editor's own
// preview) need the same two answers out of it — "how much does this step
// use" and "how much is left by the time we get here" — so the arithmetic
// lives here rather than three times over.

export interface StepIngredientRefLike {
  ingredientSortOrder: number;
  amountMode?: 'fraction' | 'absolute';
  portion: number;
  quantity?: number | null;
  unitSymbol?: string | null;
}

export interface StepLike {
  stepIngredients?: StepIngredientRefLike[] | null;
}

export interface IngredientTotalLike {
  sortOrder: number;
  quantity: number | null;
  unitSymbol?: string | null;
}

/**
 * How much of `ing` the step holding `ref` consumes, in the ingredient's
 * own unit — or null when that can't be said: the ingredient has no
 * numeric total to take a fraction of, or the step pinned an exact amount
 * in a different unit than the ingredient is measured in (150 ml of a
 * 500 g ingredient is not 150 g, and guessing would be worse than saying
 * nothing).
 */
export function stepIngredientConsumption(
  ref: StepIngredientRefLike,
  ing: IngredientTotalLike,
): number | null {
  if (ref.amountMode === 'absolute') {
    if (ref.quantity == null) return null;
    const refUnit = (ref.unitSymbol || '').trim().toLowerCase();
    const ingUnit = (ing.unitSymbol || '').trim().toLowerCase();
    if (refUnit && ingUnit && refUnit !== ingUnit) return null;
    return ref.quantity;
  }
  if (ing.quantity == null) return null;
  return ing.quantity * (ref.portion ?? 1);
}

/** What the recipe has left of `ing` once every step before `stepIndex`
 *  has taken its share. Null when the ingredient has no numeric total;
 *  never negative, since over-allocating is the author's business to see
 *  as zero-left rather than as a negative amount. */
export function remainingBeforeStep(
  steps: StepLike[],
  stepIndex: number,
  ing: IngredientTotalLike,
): number | null {
  if (ing.quantity == null) return null;
  let used = 0;
  for (let i = 0; i < stepIndex && i < steps.length; i++) {
    for (const ref of steps[i].stepIngredients ?? []) {
      if (ref.ingredientSortOrder !== ing.sortOrder) continue;
      used += stepIngredientConsumption(ref, ing) ?? 0;
    }
  }
  return Math.max(0, ing.quantity - used);
}
