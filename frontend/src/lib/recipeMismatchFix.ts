// ════════════════════════════════════════════════════════════════════════
// SmartChef — settling an ingredient list that disagrees with its steps
//
// When the AI check finds that the steps name ingredients the list does not
// have (lib/recipeConsistency.ts), the user is asked which side to believe:
//
//   'steps'        the steps are right → make the ingredient list match them:
//                  add what they name, drop the rows they never use;
//   'ingredients'  the list is right → rewrite only the steps that contradict
//                  it, or remove a step that exists just to make something the
//                  list already provides (a dough, when the list has bought
//                  pastry).
//
// Both are a second, smaller model call whose answer comes back as ordinary
// reviewable changes (lib/recipeCheck.ts's CheckChange), checked here before
// the user ever sees them:
//
//   - an ingredient to add must be one the mismatch named, and carry a quote
//     of a step that really names it;
//   - an amount the steps do not state is kept but marked as an estimate, so
//     the review can say so and nobody mistakes it for the recipe's own data;
//   - a rewritten step may not bring in a number, or an ingredient from the
//     other side, that the original did not have, and may not smuggle in a
//     {{token}};
//   - only steps and rows the mismatch pointed at can be touched.
//
// Pure functions, like the rest of the check, so the rules are testable
// without a model.
// ════════════════════════════════════════════════════════════════════════

import { findMention } from './nameMatch';
import { normalizeName } from './stepRefs';
import { isListed, type IngredientMismatch } from './recipeConsistency';
import {
  fmt, ingredientLabel, normText, num, numberSupportedBy, numbersIn, plainStepText, resolveUnit, str,
  type CheckCatalog, type CheckChange, type CheckDraft,
} from './recipeCheck';

/** Which side of the disagreement the user chose to believe. */
export type MismatchSide = 'steps' | 'ingredients';

export interface MismatchFixResult {
  changes: CheckChange[];
  /** Units the model used that match nothing in the library. */
  unmatched: string[];
}

// ── What the model is shown ─────────────────────────────────────────────

export function buildFixRequest(side: MismatchSide, draft: CheckDraft, cat: CheckCatalog, mismatch: IngredientMismatch) {
  const ingredients = draft.ingredients ?? [];
  return {
    recipe: { title: draft.title ?? '', servings: draft.servings ?? null },
    ingredients: ingredients.map((i, n) => ({
      i: n, name: ingredientLabel(i), quantity: i.quantity, quantityText: i.quantityText ?? null, unit: i.unitSymbol ?? null,
    })),
    steps: (draft.steps ?? []).map((s, n) => ({ i: n, title: s.title, text: plainStepText(s.description, ingredients, cat) })),
    missing: mismatch.unlisted,
    unused: mismatch.unused,
    affected: side === 'ingredients' ? [...new Set(mismatch.unlisted.map((u) => u.step))].sort((a, b) => a - b) : undefined,
  };
}

export function buildFixSystemPrompt(side: MismatchSide): string {
  const common = `You repair ONE recipe from a recipe-management app whose ingredient list does not match its steps. You receive its ingredients (each with an index "i"), its steps (each with an index "i" and plain text), "missing" (ingredients the steps name that the list does not have, each with the step index and the step's own words) and "unused" (list rows no step names). Write in the recipe's own language. Respond EXCLUSIVELY with JSON.`;
  if (side === 'steps') {
    return `${common}

The user decided the STEPS are right. Change the ingredient list so it matches what the steps say.

{"add":[{"name": string, "quantity": number|null, "unit": string|null, "evidence": string}], "remove":[number]}

- "add": one entry per "missing" ingredient (merge duplicates). "name" is the plain ingredient name in the recipe's language ("Burro", not "burro morbido a pezzetti"). "evidence" is the step's text copied CHARACTER FOR CHARACTER where it names the ingredient, at most 25 words.
- "quantity" and "unit": the amount the steps state for it, if they state one. If they do not, give a sensible amount for the whole recipe from its title, servings and the other rows' amounts; it will be shown to the user as an estimate. Use null for both when an amount makes no sense ("to taste"). "unit" is a unit symbol or name in the recipe's language ("g", "ml", "cucchiai"), null when "quantity" is null or the thing is counted.
- "remove": indexes taken ONLY from "unused" whose ingredient the steps plainly replace (a dough made from flour, butter and eggs replaces ready-made pastry). Leave a row in if any step could be using it. Never remove a row that is not in "unused".

{"add":[],"remove":[]}`;
  }
  return `${common}

The user decided the INGREDIENT LIST is right. Change only the steps that contradict it. "affected" holds the indexes of the steps that name ingredients the list lacks; you may only return those.

{"steps":[{"i": number, "action": "rewrite"|"remove", "text": string, "reason": string}]}

- "rewrite": the step's text rewritten so it uses only the listed ingredients — same language, voice, tense and length, and everything that does not contradict the list stays (times, temperatures, tools, amounts the text already gives). Do NOT add any number, time, temperature, tool or ingredient that neither the original text nor the list states. Do not use the words of the "missing" ingredients. "text" is the whole new step text. "reason": at most 20 words.
- "remove": ONLY when the step exists just to make or use the "missing" ingredients and a listed ingredient already provides the result (making dough from flour, butter and eggs, when the list has ready-made pastry). "text" is empty.
- When unsure, rewrite minimally instead of removing. Never touch a step outside "affected".

{"steps":[]}`;
}

// ── What comes back ─────────────────────────────────────────────────────

export function interpretFixResponse(
  side: MismatchSide,
  parsed: any,
  draft: CheckDraft,
  cat: CheckCatalog,
  mismatch: IngredientMismatch,
): MismatchFixResult {
  const ingredients = draft.ingredients ?? [];
  const steps = draft.steps ?? [];
  const labels = ingredients.map(ingredientLabel);
  const plainSteps = steps.map((s) => plainStepText(s.description, ingredients, cat));
  const changes: CheckChange[] = [];
  const unmatched: string[] = [];
  let seq = 0;
  const id = (p: string) => `${p}-${seq++}`;

  if (side === 'steps') {
    const corpus = normText(plainSteps.concat(steps.map((s) => s.title ?? '')).join(' \n '));
    const seen = new Set<string>();
    for (const row of (Array.isArray(parsed?.add) ? parsed.add : []).slice(0, 24)) {
      const name = str(row?.name);
      const evidence = str(row?.evidence);
      if (!name || !evidence || name.length > 80) continue;
      // Only what the mismatch named: the model may not grow the list.
      if (!mismatch.unlisted.some((u) => normalizeName(u.name) === normalizeName(name) || !!findMention(u.name, [name], 'noun') || !!findMention(name, [u.name], 'noun'))) continue;
      if (!corpus.includes(normText(evidence)) || !findMention(evidence, [name], 'noun')) continue;
      const key = normalizeName(name);
      if (!key || seen.has(key) || isListed(name, labels)) continue;
      seen.add(key);

      let quantity = num(row?.quantity);
      let unitId: string | null = null;
      let unitSymbol: string | null = null;
      const unitText = str(row?.unit);
      if (quantity != null && quantity > 100000) quantity = null;
      if (unitText) {
        const unit = resolveUnit(unitText, cat.units);
        if (unit) { unitId = unit.id; unitSymbol = unit.symbol; }
        else { unmatched.push(unitText); quantity = null; }
      }
      // An amount the step does not state is the model's guess, whatever it says.
      const estimated = quantity != null && !numberSupportedBy(quantity, evidence);
      changes.push({
        id: id('add'), group: 'ingredients', type: 'ingredientAdd', kind: 'fill',
        name, quantity, unitId, unitSymbol, estimated, after: quantity != null ? fmt(quantity, unitSymbol) : '',
        evidence,
      });
    }

    const unusedIdx = new Set(mismatch.unused.map((u) => u.index));
    for (const raw of Array.isArray(parsed?.remove) ? parsed.remove : []) {
      const index = Number.isInteger(raw) ? (raw as number) : -1;
      if (!unusedIdx.has(index) || !ingredients[index]) continue;
      if (changes.some((c) => c.type === 'ingredientRemove' && c.index === index)) continue;
      changes.push({ id: id('del'), group: 'ingredients', type: 'ingredientRemove', kind: 'fix', index, label: labels[index], evidence: '' });
    }
    return { changes, unmatched };
  }

  // The list is right: rewrite or drop the steps that contradict it.
  const affected = new Set(mismatch.unlisted.map((u) => u.step));
  // Every number this step may legitimately keep: the ones it already has,
  // plus the list's own amounts.
  const listNumbers = ingredients.flatMap((i) => (i.quantity != null ? [i.quantity] : []));
  const touched = new Set<number>();
  for (const row of (Array.isArray(parsed?.steps) ? parsed.steps : []).slice(0, 24)) {
    const index = Number.isInteger(row?.i) ? (row.i as number) : -1;
    const step = steps[index];
    if (!step || !affected.has(index) || touched.has(index)) continue;
    const reason = str(row?.reason) ?? '';
    const label = step.title || String(index + 1);

    if (row?.action === 'remove') {
      touched.add(index);
      changes.push({ id: id('rm'), group: 'steps', type: 'stepRemove', kind: 'fix', index, label, evidence: reason });
      continue;
    }
    if (row?.action !== 'rewrite') continue;
    const text = str(row?.text);
    const original = plainSteps[index];
    if (!text || text.includes('{{') || text === original) continue;
    // About as long as the step was: a rewrite is not a new recipe.
    if (original && (text.length < original.length * 0.4 || text.length > original.length * 2.5)) continue;
    // No number the step did not already have, and none the list lacks.
    const allowed = [...numbersIn(original), ...listNumbers];
    if (numbersIn(text).some((n) => !allowed.some((a) => Math.abs(a - n) <= 1e-6 + Math.abs(a) * 0.005))) continue;
    // None of the words of what the list lacks may remain.
    const missing = mismatch.unlisted.map((u) => u.name);
    if (missing.some((name) => findMention(text, [name], 'noun'))) continue;
    touched.add(index);
    changes.push({ id: id('rw'), group: 'steps', type: 'stepRewrite', kind: 'fix', index, text, before: original, after: text, evidence: reason });
  }
  return { changes, unmatched };
}
