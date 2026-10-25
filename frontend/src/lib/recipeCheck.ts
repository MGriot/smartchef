// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Check with AI" for the recipe editor
//
// The model is asked to audit a recipe using ONLY what the recipe already
// says. Everything it proposes comes back with a verbatim quote of the
// recipe as evidence, and this module throws away whatever it cannot prove:
//
//   - the quote must really occur in the recipe's own text;
//   - the number proposed must really occur in the quote (an hour counts
//     for 60 minutes, a kilo for 1000 g);
//   - a spelling fix must be a small edit of words really in the text, and may
//     not touch a digit; an ingredient amount is only corrected when it looks
//     like a slip of the pen and the recipe never uses it in portions.
//
// Step prose is never rewritten here beyond typo fixes. Two things do touch
// the steps, each as its own reviewable change: a "link" turns words the step
// already contains into an inline {{ing}}/{{tool}}/{{tech}} reference (the
// model quotes the words, code checks they are in the step), and the
// ingredient/steps mismatch flow in lib/recipeMismatchFix.ts, which the user
// starts by choosing which side of the disagreement to believe.
// What survives is a list of discrete changes the user goes through and ticks;
// nothing touches the draft until applyCheckChanges() is called with the
// ones they kept. Pure functions throughout, so the "never invent" rules are
// testable without a model or a page.
// ════════════════════════════════════════════════════════════════════════

import { STEP_REF_RE, buildRef, linkIngredientsInText, normalizeName, parseRefParams, reindexIngredientRefs, type StepIngredientRefLike } from './stepRefs';
import { findMention } from './nameMatch';
import { linkEntitiesInText, ingredientsNamedInText } from './importLinking';
import { findUnusedIngredients, interpretMismatch, type IngredientMismatch } from './recipeConsistency';
import { matchUnitId } from './fuzzyMatch';
import { isCountryCode } from './countries';
import { editDistance } from './wordDiff';

// ── Shapes ──────────────────────────────────────────────────────────────

export interface CheckNamedEntity {
  id: string;
  name: string;
  translated_name?: string | null;
  synonyms?: string[];
  icon?: string | null;
}

export interface CheckUnit { id: string; symbol: string; name: string }

export interface CheckCatalog {
  tools: CheckNamedEntity[];
  techniques: CheckNamedEntity[];
  units: CheckUnit[];
  tagNames: string[];
}

export interface CheckDraftIngredient {
  sortOrder: number;
  ingredientName: string;
  subRecipeTitle?: string | null;
  quantity: number | null;
  quantityText?: string | null;
  unitId: string | null;
  unitSymbol?: string | null;
  notes: string | null;
}

export interface CheckDraftStep {
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: string[];
  techniqueIds: string[];
  notes: string | null;
  stepIngredients: Array<StepIngredientRefLike & { unitId?: string | null }>;
}

export interface CheckDraft {
  title?: string;
  description?: string | null;
  tips?: string | null;
  storage_instructions?: string | null;
  source_url?: string | null;
  servings?: number;
  prep_time_min?: number;
  cook_time_min?: number;
  rest_time_min?: number;
  yield_amount?: number | null;
  yield_unit_id?: string | null;
  tags?: string[];
  regions?: string[];
  ingredients?: CheckDraftIngredient[];
  steps?: CheckDraftStep[];
  tools?: CheckNamedEntity[];
  techniques?: CheckNamedEntity[];
  sources?: CheckSource[];
}

export interface CheckSource { type: 'url' | 'book' | 'video' | 'other'; label?: string; url?: string }

export type CheckGroup = 'text' | 'ingredients' | 'steps' | 'links' | 'fields' | 'tags' | 'regions' | 'sources';

export type TextTarget = 'title' | 'description' | 'tips' | 'storage' | 'ingredientName' | 'stepTitle' | 'stepText';

interface ChangeBase {
  id: string;
  group: CheckGroup;
  /** `fix` replaces a value the recipe already had; `fill` supplies a missing one. */
  kind: 'fix' | 'fill';
  /** The recipe's own words that justify the change. */
  evidence: string;
}

export type CheckChange =
  | (ChangeBase & {
      type: 'textFix'; target: TextTarget; index: number | null;
      /** The few words as written, and as corrected. */
      from: string; to: string;
      /** The same words with a little of their surroundings, for the red/green diff. */
      before: string; after: string;
    })
  | (ChangeBase & { type: 'ingredientQty'; index: number; label: string; quantity: number; unitId: string | null; unitSymbol: string | null; before: string; after: string })
  | (ChangeBase & { type: 'stepDuration'; index: number; durationMin: number; before: string; after: string })
  | (ChangeBase & { type: 'field'; field: 'servings' | 'prep_time_min' | 'cook_time_min' | 'rest_time_min'; value: number; before: string; after: string })
  | (ChangeBase & { type: 'yield'; amount: number; unitId: string; unitSymbol: string; before: string; after: string })
  | (ChangeBase & { type: 'tag'; name: string })
  | (ChangeBase & { type: 'region'; country: string | null; place: string | null; label: string })
  /** Words the step already holds, turned into an inline reference. `from` is
   *  those words as written; `targetId` is an ingredient's index (as text) or a
   *  tool/technique id. */
  | (ChangeBase & { type: 'link'; index: number; linkKind: 'ing' | 'tool' | 'tech'; targetId: string; label: string; from: string })
  // The four below come from the ingredient/steps mismatch flow
  // (lib/recipeMismatchFix.ts): the user picked a side, these make the other
  // side agree with it.
  | (ChangeBase & {
      type: 'ingredientAdd'; name: string; quantity: number | null; unitId: string | null; unitSymbol: string | null;
      /** The amount is the model's estimate: the steps do not state it. */
      estimated: boolean; after: string;
    })
  | (ChangeBase & { type: 'ingredientRemove'; index: number; label: string })
  | (ChangeBase & { type: 'stepRewrite'; index: number; text: string; before: string; after: string })
  | (ChangeBase & { type: 'stepRemove'; index: number; label: string })
  // The three below come from "Merge text with AI" (lib/recipeMerge.ts):
  // information a pasted text has and the recipe lacks.
  | (ChangeBase & { type: 'stepAdd'; title: string | null; text: string; durationMin: number | null; after: string })
  | (ChangeBase & { type: 'textAppend'; target: 'description' | 'tips' | 'storage'; text: string; before: string; after: string })
  | (ChangeBase & { type: 'sourceAdd'; source: CheckSource; label: string });

export interface CheckResult {
  changes: CheckChange[];
  /** The model's own notes on inconsistencies it could not settle. */
  warnings: string[];
  /** Names the model used that match nothing in the library (tools, techniques, units). */
  unmatched: string[];
  /** The steps name ingredients the list lacks. When set, the user is asked
   *  which side to believe (see lib/recipeMismatchFix.ts). */
  mismatch?: IngredientMismatch | null;
}

// ── Reading the recipe ──────────────────────────────────────────────────

export const labelOf = (e: CheckNamedEntity) => e.translated_name || e.name;
export const ingredientLabel = (i: CheckDraftIngredient) => i.ingredientName || i.subRecipeTitle || '';

/** A step's prose with every {{…}} token replaced by the words it renders as,
 *  so the model (and the evidence check) read what the cook reads. */
export function plainStepText(text: string, ingredients: CheckDraftIngredient[], cat: Pick<CheckCatalog, 'tools' | 'techniques'>): string {
  return (text || '').replace(STEP_REF_RE, (_w, type: string, id: string, raw?: string) => {
    const params = parseRefParams(raw);
    const bare = id.trim();
    let name = '';
    if (type === 'ing') name = ingredientLabel(ingredients[parseInt(bare, 10)] ?? ({} as CheckDraftIngredient));
    else if (type === 'tool') { const e = cat.tools.find((t) => t.id === bare); name = e ? labelOf(e) : ''; }
    else { const e = cat.techniques.find((t) => t.id === bare); name = e ? labelOf(e) : ''; }
    const label = params.alias || name;
    return type === 'ing' && params.amount ? `${params.amount} ${label}` : label;
  });
}

function ingredientLine(i: CheckDraftIngredient): string {
  return [i.quantity != null ? String(i.quantity) : i.quantityText, i.unitSymbol, ingredientLabel(i), i.notes].filter(Boolean).join(' ');
}

/** Everything the recipe says, as one normalized string to look quotes up in. */
function corpusOf(draft: CheckDraft, cat: CheckCatalog): string {
  const ingredients = draft.ingredients ?? [];
  const parts = [
    draft.title, draft.description, draft.tips, draft.storage_instructions, draft.source_url,
    ...ingredients.map(ingredientLine),
    ...(draft.steps ?? []).flatMap((s) => [s.title, plainStepText(s.description, ingredients, cat), s.notes]),
  ];
  return normText(parts.filter(Boolean).join(' \n '));
}

export function normText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

export function numbersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/(\d+)?\s*([½¼¾⅓⅔⅛])|\d+(?:[.,]\d+)?/g)) {
    if (m[2]) out.push((m[1] ? Number(m[1]) : 0) + FRACTIONS[m[2]]);
    else out.push(Number(m[0].replace(',', '.')));
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 + Math.abs(b) * 0.005;

/** True when `value` is a number the quote actually states — as written, or
 *  as the minutes of an hour count / the grams of a kilo / the ml of a litre. */
export function numberSupportedBy(value: number, evidence: string): boolean {
  return numbersIn(evidence).some((n) => [n, n * 60, n * 1000, n / 1000].some((c) => close(value, c)));
}

/** The evidence is accepted only if it is a real, non-trivial quote. */
function evidenceHolds(evidence: unknown, corpus: string): evidence is string {
  if (typeof evidence !== 'string') return false;
  const q = normText(evidence);
  return q.length >= 3 && corpus.includes(q);
}

// ── What the model is shown ─────────────────────────────────────────────

export function buildCheckRequest(draft: CheckDraft, cat: CheckCatalog) {
  const ingredients = draft.ingredients ?? [];
  return {
    recipe: {
      title: draft.title ?? '',
      description: draft.description ?? null,
      tips: draft.tips ?? null,
      storage: draft.storage_instructions ?? null,
      sourceUrl: draft.source_url ?? null,
      servings: draft.servings ?? null,
      prepTimeMin: draft.prep_time_min || null,
      cookTimeMin: draft.cook_time_min || null,
      restTimeMin: draft.rest_time_min || null,
      yield: draft.yield_amount ? { amount: draft.yield_amount, unit: cat.units.find((u) => u.id === draft.yield_unit_id)?.symbol ?? null } : null,
      tags: draft.tags ?? [],
      regions: draft.regions ?? [],
    },
    ingredients: ingredients.map((i, n) => ({
      i: n,
      name: ingredientLabel(i),
      quantity: i.quantity,
      quantityText: i.quantityText ?? null,
      unit: i.unitSymbol ?? null,
      notes: i.notes,
    })),
    steps: (draft.steps ?? []).map((s, n) => ({
      i: n,
      title: s.title,
      text: plainStepText(s.description, ingredients, cat),
      // Words of this step that are already inline references, so the model
      // does not propose linking them again.
      linked: linkedLabels(s.description, ingredients, cat),
      durationMin: s.durationMin,
      notes: s.notes,
    })),
    // What a step's words can be linked to besides the ingredient list.
    catalog: { tools: cat.tools.map(labelOf), techniques: cat.techniques.map(labelOf) },
  };
}

/** The words of a step that are inline references already, as they read. */
function linkedLabels(text: string, ingredients: CheckDraftIngredient[], cat: Pick<CheckCatalog, 'tools' | 'techniques'>): string[] {
  const out: string[] = [];
  (text || '').replace(STEP_REF_RE, (whole) => {
    out.push(plainStepText(whole, ingredients, cat));
    return whole;
  });
  return [...new Set(out.filter(Boolean))];
}

/** Every wording a library entity may appear under in prose. */
export function entityNames(e: CheckNamedEntity): string[] {
  return [e.name, e.translated_name, ...(e.synonyms ?? [])].filter((n): n is string => !!n && !!n.trim());
}

export function buildCheckSystemPrompt(cat: CheckCatalog): string {
  const list = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)');
  return `You audit ONE recipe from a recipe-management app. You receive its fields, its ingredient list (each with an index "i"), and its steps (each with an index "i" and plain text).

ABSOLUTE RULE — NEVER INVENT DATA. Use only what the recipe itself literally says. Do not use cooking knowledge to supply typical quantities, times, servings, yields, tags or places. If the recipe does not state it, return null / leave it out. A smaller correct answer is always better than a larger guessed one. If you are unsure, return nothing.

Every proposal (except "typos", "links" and "mismatch", which carry their own "quote") MUST carry "evidence": a quote copied CHARACTER FOR CHARACTER from the recipe (title, description, tips, storage, an ingredient line, a step text or title), at most 25 words, that states the fact. Proposals without an exact quote are discarded automatically. Every number you propose must appear in its quote.

Do this, in order:
1. "typos": spelling and typing mistakes only (misspelt words, doubled letters, missing accents or apostrophes, a missing or extra space, wrong capital letter). {"target": "title"|"description"|"tips"|"storage"|"ingredientName"|"stepTitle"|"stepText", "i": ingredient/step index or null, "before": the mistaken words copied exactly (1 to 4 words), "after": the same words corrected}. NEVER reword, rephrase, translate, change a number or unit, change style, or fix grammar that is merely informal. Keep the author's language and voice. The text stays exactly as it is apart from the mistaken word itself.
2. "ingredients": correct an ingredient's quantity ONLY when it is plainly a slip of the pen: the recipe states the whole amount of that very ingredient elsewhere (e.g. a step says "add 200 g of flour" while the list says 20 or nothing). {"i", "quantity": number, "unit": string|null, "evidence"}. Never use a partial amount ("half the sugar", "the rest of the butter", an amount used in just one stage). Do not change the unit of a row that already has one. Do not touch rows that are consistent.
3. "steps": [{"i", "durationMin": number, "evidence": string}] — minutes, ONLY when the step text states a duration ("cook 20 minutes", "rest 1 hour" → 60).
4. "servings", "prepTimeMin", "cookTimeMin", "restTimeMin": each {"value": number, "evidence": string} or null. Only when the recipe states it ("serves 4", "bake 30 minutes"). Do not add up or estimate.
5. "yield": {"amount": number, "unit": string, "evidence": string} or null — the finished quantity, only when stated ("makes 12 cookies", "about 1 litre").
6. "tags": [{"name": string, "evidence": string}] — only attributes the recipe states or plainly names (e.g. the title says "vegan", an ingredient list shows no meat only if the text says vegetarian). Tags describe the DISH (course, cuisine, occasion, season, main cooking method, diet), never an ingredient — no "Tomato", "Beef", "Basil". Prefer existing tags: ${list(cat.tagNames)}. Max 5.
7. "regions": [{"country": ISO 3166-1 alpha-2 or null, "place": string|null, "evidence": string}] — only a place the recipe's text, title or source URL names as the dish's origin ("alla romana", "Sicilian", a .it recipe-site domain is NOT enough).
8. "links": [{"i": step index, "kind": "ing"|"tool"|"tech", "target": the ingredient's index "i" (a number) for "ing", or the name EXACTLY as written in the catalog lists below for "tool"/"tech", "quote": the words copied CHARACTER FOR CHARACTER from that step's text, 1 to 4 words}] — every place a step's text names an ingredient of the list, a tool or a cooking technique of the catalogs that is not already linked. Each step has "linked": the words already linked there; never repeat those. One entry per thing per step (its first mention). Only things the text literally names — never one it merely implies. Catalog tools: ${list(cat.tools.map(labelOf))}. Catalog techniques: ${list(cat.techniques.map(labelOf))}.
9. "mismatch": does the ingredient list describe the same recipe as the steps? {"unlisted": [{"name": the ingredient as the step calls it, "step": step index, "quote": the step's own words naming it, copied CHARACTER FOR CHARACTER, at most 12 words}], "summary": one short sentence in the recipe's language} — ONLY ingredients (not tools, not plain water or ice) that a step names or uses and the ingredient list does not have, in any wording ("burro" matches "Burro morbido"; a step that says "the dough" is not a missing ingredient). null when nothing is missing. Do not guess: if the steps could be using a listed ingredient under another name, leave it out.
10. "warnings": short notes on other inconsistencies you noticed but could not resolve from the text. Do not repeat what "mismatch" already says. Write them in the recipe's language.

Respond EXCLUSIVELY with JSON:
{"typos":[],"ingredients":[],"steps":[],"servings":null,"prepTimeMin":null,"cookTimeMin":null,"restTimeMin":null,"yield":null,"tags":[],"regions":[],"links":[],"mismatch":null,"warnings":[]}`;
}

// ── What comes back ─────────────────────────────────────────────────────

export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** An ingredient counts as mentioned when its whole name, or any word of it
 *  long enough to be meaningful, is in the step's text. */
function ingredientMentioned(textNorm: string, ing: CheckDraftIngredient): boolean {
  const key = normalizeName(ingredientLabel(ing));
  if (!key) return false;
  const words = new Set(textNorm.split(' '));
  return ` ${textNorm} `.includes(` ${key} `) || key.split(' ').some((w) => w.length >= 4 && words.has(w));
}

/** Resolves a unit wording to a library unit, strictly. matchUnitId() is made
 *  for import, where a wrong guess is reviewed row by row, and its alias
 *  table matches on substrings ("dozzine" contains the "n" of "n." and lands
 *  on pieces). Here an unrecognised unit is dropped, never guessed. */
export function resolveUnit(text: string | null | undefined, units: CheckUnit[]): CheckUnit | undefined {
  const key = normText(text ?? '');
  if (!key) return undefined;
  const direct = units.find((u) => normText(u.symbol) === key || normText(u.name) === key);
  if (direct) return direct;
  const viaAlias = units.find((u) => u.id === matchUnitId(text ?? undefined, units));
  const head = key.slice(0, 4);
  return viaAlias && key.length >= 4 && normText(viaAlias.name).startsWith(head) ? viaAlias : undefined;
}

export const fmt = (qty: number | null | undefined, unit?: string | null) =>
  qty == null ? '—' : `${qty % 1 === 0 ? qty : Number(qty.toFixed(2))}${unit ? ` ${unit}` : ''}`;

const TEXT_TARGETS: TextTarget[] = ['title', 'description', 'tips', 'storage', 'ingredientName', 'stepTitle', 'stepText'];

/** Words that mark an amount as a share of the whole, in the app's languages. */
const PARTIAL_WORDS = new Set([
  'half', 'third', 'quarter', 'rest', 'remaining', 'remainder', 'portion', 'some',
  'mezzo', 'mezza', 'meta', 'terzo', 'quarto', 'resto', 'restante', 'rimanente', 'meta',
  'mitad', 'tercio', 'cuarto', 'resto', 'restante',
  'moitie', 'tiers', 'reste', 'restant',
]);

const digitsOf = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];

/** A spelling fix: the same few words with a couple of letters changed. It may
 *  not touch a number, add or drop a word's worth of text, or reword. */
export function isTypoFix(from: string, to: string): boolean {
  if (!from.trim() || !to.trim() || from === to) return false;
  if (from.includes('{{') || to.includes('{{') || /[\r\n]/.test(from + to)) return false;
  if (digitsOf(from).join('|') !== digitsOf(to).join('|')) return false;
  const words = from.trim().split(/\s+/).length;
  if (words > 4 || to.trim().split(/\s+/).length > words + 1) return false;
  const a = from.replace(/\s+/g, '');
  const b = to.replace(/\s+/g, '');
  return editDistance(a, b) <= Math.min(3, 2 * words);
}

/** True when `next` could be `prev` mistyped: a digit dropped, doubled, swapped
 *  or misplaced, or the decimal point slid. */
export function isDigitSlip(prev: number, next: number): boolean {
  if (prev === next) return false;
  const ratio = next / prev;
  if ([10, 100, 0.1, 0.01].some((r) => Math.abs(ratio - r) < 1e-9)) return true;
  const a = String(prev).replace('.', '');
  const b = String(next).replace('.', '');
  return editDistance(a, b) <= 1 || [...a].sort().join('') === [...b].sort().join('');
}

/**
 * Turns the model's raw answer into changes the recipe can really support.
 * `parsed` is whatever JSON the model produced — nothing in it is trusted.
 */
export function interpretCheckResponse(parsed: any, draft: CheckDraft, cat: CheckCatalog): CheckResult {
  const changes: CheckChange[] = [];
  const warnings: string[] = Array.isArray(parsed?.warnings) ? parsed.warnings.map(str).filter((w: string | null): w is string => !!w).slice(0, 8) : [];
  const unmatched: string[] = [];
  const corpus = corpusOf(draft, cat);
  const ingredients = draft.ingredients ?? [];
  const steps = draft.steps ?? [];
  let seq = 0;
  const id = (p: string) => `${p}-${seq++}`;

  // 1 ── Typos: a few words swapped for the same words spelt right
  const fieldText = (target: TextTarget, index: number | null): string | null => {
    switch (target) {
      case 'title': return draft.title ?? null;
      case 'description': return draft.description ?? null;
      case 'tips': return draft.tips ?? null;
      case 'storage': return draft.storage_instructions ?? null;
      case 'ingredientName': return index != null && ingredients[index] ? (ingredients[index].ingredientName || null) : null;
      case 'stepTitle': return index != null ? steps[index]?.title ?? null : null;
      case 'stepText': return index != null ? steps[index]?.description ?? null : null;
    }
  };
  const seenFix = new Set<string>();
  for (const row of (Array.isArray(parsed?.typos) ? parsed.typos : []).slice(0, 40)) {
    const target = row?.target as TextTarget;
    const index = Number.isInteger(row?.i) ? (row.i as number) : null;
    const from = typeof row?.before === 'string' ? row.before : '';
    const to = typeof row?.after === 'string' ? row.after : '';
    if (!TEXT_TARGETS.includes(target) || !isTypoFix(from, to)) continue;
    const raw = fieldText(target, index);
    // The mistaken words must be in the field exactly once (and never inside a
    // {{token}}), so the swap lands where the model meant it.
    if (!raw || raw.split(from).length !== 2 || from.includes('{{')) continue;
    const key = `${target}:${index}:${from}`;
    if (seenFix.has(key)) continue;
    seenFix.add(key);
    // The diff is shown on what the cook reads: tokens resolved to their words.
    const plain = target === 'stepText' ? plainStepText(raw, ingredients, cat) : raw;
    const at = plain.indexOf(from);
    if (at < 0) continue;
    const start = Math.max(0, plain.lastIndexOf(' ', Math.max(0, at - 24)));
    const endAt = at + from.length;
    const stop = plain.indexOf(' ', Math.min(plain.length, endAt + 24));
    const lead = (start > 0 ? '… ' : '') + plain.slice(start, at).trimStart();
    const tail = plain.slice(endAt, stop < 0 ? plain.length : stop) + (stop < 0 ? '' : ' …');
    changes.push({
      id: id('typo'), group: 'text', type: 'textFix', kind: 'fix', target, index, from, to,
      before: lead + from + tail, after: lead + to + tail, evidence: from,
    });
  }

  // 2 ── Ingredient quantities: only a plain slip of the pen
  const stepTexts = steps.map((s) => normText(plainStepText(`${s.title ?? ''} ${s.description}`, ingredients, cat)));
  for (const row of Array.isArray(parsed?.ingredients) ? parsed.ingredients : []) {
    const index = Number.isInteger(row?.i) ? row.i : -1;
    const ing = ingredients[index];
    const quantity = num(row?.quantity);
    if (!ing || quantity == null || !evidenceHolds(row.evidence, corpus) || !numberSupportedBy(quantity, row.evidence)) continue;
    // A quote about some other ingredient cannot justify this row's amount.
    const evidenceNorm = normText(row.evidence);
    if (!ingredientMentioned(evidenceNorm, ing)) continue;
    // "half the sugar", "the rest of the butter": a share, not the amount.
    if (evidenceNorm.split(' ').some((w) => PARTIAL_WORDS.has(w))) continue;
    // Stated with a number in several steps → it is split across them.
    if (stepTexts.filter((t) => /\d/.test(t) && ingredientMentioned(t, ing)).length >= 2) continue;

    let unitId = ing.unitId;
    let unitSymbol = ing.unitSymbol ?? null;
    const unitText = str(row.unit);
    if (unitText) {
      const unit = resolveUnit(unitText, cat.units);
      if (!unit) { unmatched.push(unitText); continue; }
      // A row that already has a unit keeps it; only a missing unit is filled.
      if (ing.unitId && unit.id !== ing.unitId) continue;
      unitId = unit.id;
      unitSymbol = unit.symbol;
    }
    if (ing.quantity === quantity && (ing.unitId ?? null) === (unitId ?? null)) continue;
    // Correcting a number that was already there needs it to look like a slip.
    if (ing.quantity != null && !isDigitSlip(ing.quantity, quantity)) continue;
    changes.push({
      id: id('ing'), group: 'ingredients', type: 'ingredientQty', index, label: ingredientLabel(ing),
      kind: ing.quantity == null ? 'fill' : 'fix',
      quantity, unitId, unitSymbol,
      before: fmt(ing.quantity, ing.unitSymbol), after: fmt(quantity, unitSymbol),
      evidence: row.evidence.trim(),
    });
  }

  // 2b ── Step durations (the step's prose itself is never touched here)
  for (const row of Array.isArray(parsed?.steps) ? parsed.steps : []) {
    const index = Number.isInteger(row?.i) ? row.i : -1;
    const step = steps[index];
    const minutes = num(row?.durationMin);
    if (step && minutes != null && evidenceHolds(row.evidence, corpus) && numberSupportedBy(minutes, row.evidence) && step.durationMin !== minutes) {
      changes.push({
        id: id('dur'), group: 'steps', type: 'stepDuration', index, durationMin: minutes,
        kind: step.durationMin ? 'fix' : 'fill',
        before: step.durationMin ? `${step.durationMin} min` : '—', after: `${minutes} min`,
        evidence: row.evidence.trim(),
      });
    }
  }

  // 3 ── Portions and times
  const fields: Array<['servings' | 'prep_time_min' | 'cook_time_min' | 'rest_time_min', string]> = [
    ['servings', 'servings'], ['prep_time_min', 'prepTimeMin'], ['cook_time_min', 'cookTimeMin'], ['rest_time_min', 'restTimeMin'],
  ];
  for (const [field, key] of fields) {
    const entry = parsed?.[key];
    const value = num(entry?.value);
    if (value == null || !evidenceHolds(entry?.evidence, corpus) || !numberSupportedBy(value, entry.evidence)) continue;
    const current = draft[field] ?? 0;
    if (current === value) continue;
    changes.push({
      id: id('field'), group: 'fields', type: 'field', field, value, kind: current ? 'fix' : 'fill',
      before: current ? String(current) : '—', after: String(value), evidence: entry.evidence.trim(),
    });
  }

  // 4 ── Yield
  const y = parsed?.yield;
  const yAmount = num(y?.amount);
  if (yAmount != null && evidenceHolds(y?.evidence, corpus) && numberSupportedBy(yAmount, y.evidence)) {
    const unit = resolveUnit(str(y.unit), cat.units);
    const currentUnit = cat.units.find((u) => u.id === draft.yield_unit_id);
    if (!unit) { if (str(y.unit)) unmatched.push(String(y.unit)); }
    else if (!(draft.yield_amount === yAmount && draft.yield_unit_id === unit.id)) {
      changes.push({
        id: id('yield'), group: 'fields', type: 'yield', amount: yAmount, unitId: unit.id, unitSymbol: unit.symbol,
        kind: draft.yield_amount ? 'fix' : 'fill',
        before: draft.yield_amount ? fmt(draft.yield_amount, currentUnit?.symbol) : '—', after: fmt(yAmount, unit.symbol),
        evidence: y.evidence.trim(),
      });
    }
  }

  // 5 ── Tags
  const haveTags = new Set((draft.tags ?? []).map((t) => t.toLowerCase()));
  const byLower = new Map(cat.tagNames.map((t) => [t.toLowerCase(), t]));
  for (const t of (Array.isArray(parsed?.tags) ? parsed.tags : []).slice(0, 5)) {
    const raw = str(t?.name);
    if (!raw || !evidenceHolds(t.evidence, corpus)) continue;
    const name = byLower.get(raw.toLowerCase()) ?? raw;
    if (haveTags.has(name.toLowerCase())) continue;
    haveTags.add(name.toLowerCase());
    changes.push({ id: id('tag'), group: 'tags', type: 'tag', kind: 'fill', name, evidence: t.evidence.trim() });
  }

  // 6 ── Regions
  const haveRegions = new Set((draft.regions ?? []).map((r) => r.toLowerCase()));
  for (const r of Array.isArray(parsed?.regions) ? parsed.regions : []) {
    const code = str(r?.country)?.toUpperCase() ?? null;
    const country = code && code.length === 2 && isCountryCode(code) ? code : null;
    const place = str(r?.place);
    if ((!country && !place) || !evidenceHolds(r.evidence, corpus)) continue;
    if ((place && haveRegions.has(place.toLowerCase())) || (!place && country && haveRegions.has(country.toLowerCase()))) continue;
    if (place) haveRegions.add(place.toLowerCase());
    changes.push({ id: id('region'), group: 'regions', type: 'region', kind: 'fill', country, place, label: [place, country].filter(Boolean).join(' · '), evidence: r.evidence.trim() });
  }

  // 7 ── Links: words a step already holds, turned into inline references.
  // The model only quotes; the quote must be in the step's own text (outside
  // any existing token) and must really be a wording of what it points at.
  const seenLinks = new Set<string>();
  const entityOf = (list: CheckNamedEntity[], name: string) => {
    const key = normalizeName(name);
    return key ? list.find((e) => entityNames(e).some((n) => normalizeName(n) === key)) : undefined;
  };
  for (const row of (Array.isArray(parsed?.links) ? parsed.links : []).slice(0, 60)) {
    const index = Number.isInteger(row?.i) ? (row.i as number) : -1;
    const step = steps[index];
    const quote = str(row?.quote);
    const kind = row?.kind;
    if (!step || !quote || (kind !== 'ing' && kind !== 'tool' && kind !== 'tech')) continue;

    let targetId: string;
    let names: string[];
    let label: string;
    if (kind === 'ing') {
      const at = Number.isInteger(row?.target) ? (row.target as number) : typeof row?.target === 'string' && /^\d+$/.test(row.target) ? Number(row.target) : -1;
      const ing = ingredients[at];
      if (!ing) continue;
      targetId = String(at);
      label = ingredientLabel(ing);
      names = [label];
    } else {
      const name = str(row?.target);
      const entity = name ? entityOf(kind === 'tool' ? cat.tools : cat.techniques, name) : undefined;
      if (!entity) { if (name) unmatched.push(name); continue; }
      targetId = entity.id;
      label = labelOf(entity);
      names = entityNames(entity);
    }
    const nameKind = kind === 'tech' ? 'verb' : 'noun';
    // The quote has to be a wording of its target, not an unrelated phrase.
    if (!findMention(quote, names, nameKind)) continue;
    const hit = findMention(step.description, [quote], nameKind);
    if (!hit) continue;
    // Already an inline reference to this very thing in the step.
    if (new RegExp(String.raw`\{\{${kind}:${targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[|}]`).test(step.description)) continue;
    const key = `${index}:${kind}:${targetId}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    const from = step.description.slice(hit.start, hit.end);
    changes.push({
      id: id('link'), group: 'links', type: 'link', kind: 'fill', index, linkKind: kind, targetId, label, from,
      evidence: plainStepText(step.description, ingredients, cat),
    });
  }

  // 8 ── Does the ingredient list describe the same recipe as the steps?
  const labels = ingredients.map(ingredientLabel);
  const plainSteps = steps.map((s) => plainStepText(`${s.title ?? ''} ${s.description}`.trim(), ingredients, cat));
  const linkedRows = new Set<number>();
  steps.forEach((s) => {
    (s.stepIngredients ?? []).forEach((r) => linkedRows.add(r.ingredientSortOrder));
    for (const m of (s.description || '').matchAll(/\{\{ing:(\d+)[|}]/g)) linkedRows.add(Number(m[1]));
  });
  const unused = findUnusedIngredients(labels, plainSteps, linkedRows);
  const mismatch = interpretMismatch(parsed?.mismatch, labels, plainSteps, unused);

  return { changes, warnings: [...new Set(warnings)], unmatched: [...new Set(unmatched)], mismatch };
}

// ── Applying the ones the user kept ─────────────────────────────────────

/** What the page resolves before applying, because it needs the network. */
export interface ResolvedApplyInput {
  /** Region labels and coordinates need a geocoder. */
  regions?: string[];
  regionCoords?: Record<string, unknown>;
  /** The library ingredient behind each `ingredientAdd`, by change id. An add
   *  with no entry here is skipped: a row cannot be saved without one. */
  ingredients?: Record<string, { ingredientId: string; ingredientName: string }>;
}

/** Puts back the inline references a rewritten step lost: ingredients its new
 *  text names, and the tools and techniques it already listed. */
function relinkStep(step: any, ingredients: CheckDraftIngredient[], draft: CheckDraft): void {
  const rows = ingredients.map((i) => ({ name: ingredientLabel(i) }));
  const refs: StepIngredientRefLike[] = [...(step.stepIngredients ?? [])];
  const have = new Set(refs.map((r) => r.ingredientSortOrder));
  for (const at of ingredientsNamedInText(step.description, rows, have)) {
    refs.push({ ingredientSortOrder: at, amountMode: 'fraction', portion: 1 });
  }
  step.stepIngredients = refs;
  step.description = linkIngredientsInText(step.description, refs, rows);
  const targets = (list: CheckNamedEntity[] | undefined, ids: string[]) =>
    (list ?? []).filter((e) => ids.includes(e.id)).map((e) => ({ id: e.id, names: entityNames(e) }));
  step.description = linkEntitiesInText(step.description, 'tool', targets(draft.tools, step.toolIds ?? []));
  step.description = linkEntitiesInText(step.description, 'tech', targets(draft.techniques, step.techniqueIds ?? []));
}

/** Deletes ingredient row `at` the way the editor does: the references that
 *  pointed at it become the plain words they read as, and the ones above it
 *  move down by one. */
function removeIngredientRow(ingredients: any[], steps: any[], at: number): void {
  const label = ingredientLabel(ingredients[at]);
  for (const s of steps) {
    s.description = (s.description ?? '').replace(STEP_REF_RE, (whole: string, type: string, rid: string, raw?: string) =>
      type === 'ing' && rid.trim() === String(at) ? (parseRefParams(raw).alias || label) : whole);
    s.description = reindexIngredientRefs(s.description, at);
    s.stepIngredients = (s.stepIngredients ?? [])
      .filter((r: StepIngredientRefLike) => r.ingredientSortOrder !== at)
      .map((r: StepIngredientRefLike) => (r.ingredientSortOrder > at ? { ...r, ingredientSortOrder: r.ingredientSortOrder - 1 } : r));
  }
  ingredients.splice(at, 1);
  ingredients.forEach((row, i) => {
    row.sortOrder = i;
    if (typeof row.substituteFor === 'number') row.substituteFor = row.substituteFor === at ? null : row.substituteFor > at ? row.substituteFor - 1 : row.substituteFor;
  });
}

/** Returns a new draft with `changes` applied. Region and new-ingredient
 *  changes are carried by `resolved` (they need a geocoder or the library,
 *  which are async and belong to the page); everything else is derived from
 *  the change. Order matters: row and step indexes in the changes were taken
 *  from the draft as it is now, so edits in place come first and the
 *  removals, which shift indexes, come last. */
export function applyCheckChanges<T extends CheckDraft>(draft: T, changes: CheckChange[], resolved?: ResolvedApplyInput): T {
  const next: any = { ...draft };
  const steps: any[] = (draft.steps ?? []).map((s) => ({ ...s, stepIngredients: [...(s.stepIngredients ?? [])] }));
  const ingredients: any[] = (draft.ingredients ?? []).map((i) => ({ ...i }));
  const tags = [...(draft.tags ?? [])];

  for (const c of changes) {
    switch (c.type) {
      case 'textFix': {
        const swap = (text: string | null | undefined) => (text && text.split(c.from).length === 2 ? text.replace(c.from, () => c.to) : text);
        if (c.target === 'title') next.title = swap(next.title);
        else if (c.target === 'description') next.description = swap(next.description);
        else if (c.target === 'tips') next.tips = swap(next.tips);
        else if (c.target === 'storage') next.storage_instructions = swap(next.storage_instructions);
        else if (c.target === 'ingredientName' && c.index != null && ingredients[c.index]) ingredients[c.index].ingredientName = swap(ingredients[c.index].ingredientName);
        else if (c.target === 'stepTitle' && c.index != null && steps[c.index]) steps[c.index].title = swap(steps[c.index].title);
        else if (c.target === 'stepText' && c.index != null && steps[c.index]) steps[c.index].description = swap(steps[c.index].description);
        break;
      }
      case 'ingredientQty':
        if (ingredients[c.index]) ingredients[c.index] = { ...ingredients[c.index], quantity: c.quantity, quantityText: null, unitId: c.unitId, unitSymbol: c.unitSymbol };
        break;
      case 'stepDuration':
        if (steps[c.index]) steps[c.index].durationMin = c.durationMin;
        break;
      case 'field': next[c.field] = c.value; break;
      case 'yield': next.yield_amount = c.amount; next.yield_unit_id = c.unitId; next.yield_unit_symbol = c.unitSymbol; break;
      case 'tag': if (!tags.some((t) => t.toLowerCase() === c.name.toLowerCase())) tags.push(c.name); break;
      case 'link': {
        const step = steps[c.index];
        if (!step) break;
        const hit = findMention(step.description, [c.from], c.linkKind === 'tech' ? 'verb' : 'noun');
        if (!hit) break;
        const words = step.description.slice(hit.start, hit.end);
        // The author's own words stay on the page; the reference only adds
        // the link. An alias is dropped when it is just the entity's name.
        const alias = normalizeName(words) === normalizeName(c.label) ? undefined : words;
        step.description = step.description.slice(0, hit.start) + buildRef(c.linkKind, c.targetId, alias ? { alias } : {}) + step.description.slice(hit.end);
        if (c.linkKind === 'ing') {
          const at = Number(c.targetId);
          if (!step.stepIngredients.some((r: StepIngredientRefLike) => r.ingredientSortOrder === at)) {
            step.stepIngredients.push({ ingredientSortOrder: at, amountMode: 'fraction', portion: 1 });
          }
        } else {
          const key = c.linkKind === 'tool' ? 'toolIds' : 'techniqueIds';
          const list: string[] = step[key] ?? [];
          if (!list.includes(c.targetId)) step[key] = [...list, c.targetId];
        }
        break;
      }
      case 'textAppend': {
        const key = c.target === 'storage' ? 'storage_instructions' : c.target;
        const current = (next[key] ?? '').trim();
        next[key] = current ? `${current}\n\n${c.text}` : c.text;
        break;
      }
      case 'region': case 'ingredientAdd': case 'ingredientRemove': case 'stepRewrite': case 'stepRemove':
      case 'stepAdd': case 'sourceAdd': break;
    }
  }

  // Rows are added at the end, so no existing index moves.
  for (const c of changes) {
    if (c.type !== 'ingredientAdd') continue;
    const lib = resolved?.ingredients?.[c.id];
    if (!lib) continue;
    ingredients.push({
      id: '', sortOrder: ingredients.length, ingredientId: lib.ingredientId, ingredientName: lib.ingredientName,
      quantity: c.quantity, quantityText: null, unitId: c.unitId, unitSymbol: c.unitSymbol,
      isOptional: false, notes: '', groupName: null,
    });
  }

  for (const c of changes) {
    if (c.type === 'stepRewrite' && steps[c.index]) {
      steps[c.index].description = c.text;
      relinkStep(steps[c.index], ingredients, draft);
    }
  }

  // New steps go at the end, after the rewrites, and are linked like one.
  for (const c of changes) {
    if (c.type !== 'stepAdd') continue;
    const step = {
      id: '', stepNumber: steps.length + 1, title: c.title ?? '', description: c.text, durationMin: c.durationMin,
      toolIds: [], techniqueIds: [], notes: '', imageUrl: null, stepIngredients: [], translations: [],
    };
    relinkStep(step, ingredients, draft);
    steps.push(step);
  }

  const sources = [...(draft.sources ?? [])];
  for (const c of changes) {
    if (c.type !== 'sourceAdd') continue;
    const dup = sources.some((s) => (c.source.url && s.url === c.source.url) || (!c.source.url && !!s.label && s.label.toLowerCase() === (c.source.label ?? '').toLowerCase()));
    if (!dup) sources.push(c.source);
  }
  if (changes.some((c) => c.type === 'sourceAdd')) next.sources = sources;

  // Removals shift indexes: highest first, so the ones still to come hold.
  for (const at of changes.flatMap((c) => (c.type === 'ingredientRemove' ? [c.index] : [])).sort((a, b) => b - a)) {
    if (ingredients[at]) removeIngredientRow(ingredients, steps, at);
  }
  const removedSteps = new Set(changes.flatMap((c) => (c.type === 'stepRemove' ? [c.index] : [])));
  const keptSteps = removedSteps.size
    ? steps.filter((_, i) => !removedSteps.has(i)).map((s, i) => ({ ...s, stepNumber: i + 1 }))
    : steps;

  next.steps = keptSteps;
  next.ingredients = ingredients;
  next.tags = tags;
  if (resolved?.regions && changes.some((c) => c.type === 'region')) {
    const have = new Set((draft.regions ?? []).map((r) => r.toLowerCase()));
    next.regions = [...(draft.regions ?? []), ...resolved.regions.filter((r) => !have.has(r.toLowerCase()))];
    next.region_coords = { ...((draft as any).region_coords ?? {}), ...(resolved.regionCoords ?? {}) };
  }
  return next as T;
}
