// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Merge text with AI" for the recipe editor
//
// The user pastes a text about the recipe they are editing — a comment from
// a friend, the same dish from another site, the notes on the back of a
// card — and the model proposes what that text adds: missing ingredients or
// amounts, missing steps, extra detail for a step, times, servings, tips,
// dish tags, places, and the sources the text names.
//
// The rules are the mirror image of "Check with AI" (lib/recipeCheck.ts):
// there the recipe is the only truth; here the PASTED TEXT is. Every
// proposal quotes the pasted text, and this module drops whatever it cannot
// prove against it:
//
//   - the quote must really occur in the pasted text;
//   - every number proposed must be in the quote (an hour counts for 60
//     minutes, a kilo for 1000 g), and a new or rewritten step may only use
//     numbers the pasted text or the step itself already has;
//   - a rewritten step must keep most of what it said (it is enriched, not
//     replaced), and nothing is ever removed — the merge only adds and fills;
//   - a source URL must be written in the pasted text, character for
//     character.
//
// What survives comes back as the same reviewable CheckChange list, so the
// review dialog and applyCheckChanges() handle it unchanged. Pure, so the
// rules are testable without a model.
// ════════════════════════════════════════════════════════════════════════

import { isListed } from './recipeConsistency';
import { isCountryCode } from './countries';
import {
  buildCheckRequest, fmt, ingredientLabel, normText, num, numberSupportedBy, numbersIn, plainStepText, resolveUnit, str,
  type CheckCatalog, type CheckChange, type CheckDraft, type CheckResult, type CheckSource,
} from './recipeCheck';

/** Long enough for a full recipe page; anything beyond is cut, not sent. */
export const MAX_PASTED_CHARS = 20_000;
const MAX_TAGS = 5;

export function buildMergeRequest(draft: CheckDraft, pasted: string, cat: CheckCatalog) {
  const base = buildCheckRequest(draft, cat);
  return {
    recipe: base.recipe,
    ingredients: base.ingredients,
    steps: base.steps.map(({ linked: _linked, ...s }) => s),
    sources: (draft.sources ?? []).map((s) => ({ type: s.type, label: s.label ?? null, url: s.url ?? null })),
    newText: pasted.slice(0, MAX_PASTED_CHARS),
  };
}

export function buildMergeSystemPrompt(cat: CheckCatalog): string {
  const list = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)');
  return `You merge new information into ONE recipe of a recipe-management app. You receive the recipe as it is now (its fields, its ingredients each with an index "i", its steps each with an index "i") and "newText": a text the user pasted about the same dish.

Propose ONLY what "newText" adds to the recipe or states more precisely. ABSOLUTE RULES:
- The ONLY source of new facts is "newText". Never use cooking knowledge to fill gaps. If "newText" does not say it, leave it out.
- Never remove anything. Never contradict the recipe unless "newText" plainly states the recipe's value is different.
- Write everything in the RECIPE's language (translate from "newText" if it is in another language), in the recipe's style.
- Every proposal carries "evidence": a quote copied CHARACTER FOR CHARACTER from "newText" (not from the recipe), at most 30 words, that states the fact. Proposals without an exact quote are discarded. Every number you propose must appear in its quote.

Return:
1. "ingredients": [{"i": index of the existing row it completes, or null for a NEW ingredient, "name": plain ingredient name, "quantity": number|null, "unit": string|null, "evidence"}] — new ingredients "newText" uses that the list lacks, or the amount of an existing row that has none or a different one stated by "newText".
2. "steps": [{"i": index of the step it enriches, or null for a NEW step, "title": string|null, "text": the whole step text, "durationMin": number|null, "evidence"}] — for an existing step, its text rewritten to include the extra detail from "newText" (temperatures, times, tricks), keeping everything it already says; for a new step, a stage of the preparation the recipe lacks. Plain text, no {{ }} tokens.
3. "servings", "prepTimeMin", "cookTimeMin", "restTimeMin": each {"value": number, "evidence"} or null — only when "newText" states it and it differs from the recipe.
4. "yield": {"amount": number, "unit": string, "evidence"} or null.
5. "texts": [{"target": "description"|"tips"|"storage", "text": string, "evidence"}] — a short paragraph to ADD: background on the dish, tips and variations, how to keep it. Not repeating what the recipe already says.
6. "tags": [{"name": string, "evidence"}] — tags describe the DISH (course, cuisine, occasion, season, main cooking method, diet), NEVER an ingredient. Prefer existing tags: ${list(cat.tagNames)}. At most ${MAX_TAGS}.
7. "regions": [{"country": ISO 3166-1 alpha-2 or null, "place": string|null, "evidence"}] — only a place "newText" names as the dish's origin.
8. "sources": [{"type": "url"|"book"|"video"|"other", "label": string|null, "url": string|null, "evidence"}] — every source "newText" names for the recipe: a web address copied EXACTLY as written, a book (title and author as "label"), a video, a person or a magazine. Not the recipe's existing sources.
9. "warnings": short notes, in the recipe's language, on things "newText" says that conflict with the recipe and you did not propose.

Respond EXCLUSIVELY with JSON:
{"ingredients":[],"steps":[],"servings":null,"prepTimeMin":null,"cookTimeMin":null,"restTimeMin":null,"yield":null,"texts":[],"tags":[],"regions":[],"sources":[],"warnings":[]}`;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const SOURCE_TYPES = new Set(['url', 'book', 'video', 'other']);

export function interpretMergeResponse(parsed: any, draft: CheckDraft, pasted: string, cat: CheckCatalog): CheckResult {
  const changes: CheckChange[] = [];
  const unmatched: string[] = [];
  const warnings: string[] = Array.isArray(parsed?.warnings) ? parsed.warnings.map(str).filter((w: string | null): w is string => !!w).slice(0, 8) : [];
  const corpus = normText(pasted);
  const pastedNumbers = numbersIn(pasted);
  const ingredients = draft.ingredients ?? [];
  const steps = draft.steps ?? [];
  const labels = ingredients.map(ingredientLabel);
  let seq = 0;
  const id = (p: string) => `merge-${p}-${seq++}`;

  const quoted = (evidence: unknown): evidence is string => {
    if (typeof evidence !== 'string') return false;
    const q = normText(evidence);
    return q.length >= 3 && corpus.includes(q);
  };
  const inPasted = (n: number) => pastedNumbers.some((p) => Math.abs(p - n) <= 1e-6 + Math.abs(p) * 0.005);

  // 1 ── Ingredients: new rows, or an amount for a row
  const added = new Set<string>();
  for (const row of (Array.isArray(parsed?.ingredients) ? parsed.ingredients : []).slice(0, 40)) {
    const evidence = str(row?.evidence);
    if (!quoted(evidence)) continue;
    let quantity = num(row?.quantity);
    if (quantity != null && (quantity > 100000 || !numberSupportedBy(quantity, evidence))) quantity = null;
    let unitId: string | null = null;
    let unitSymbol: string | null = null;
    const unitText = str(row?.unit);
    if (unitText && quantity != null) {
      const unit = resolveUnit(unitText, cat.units);
      if (unit) { unitId = unit.id; unitSymbol = unit.symbol; }
      else { unmatched.push(unitText); quantity = null; }
    }

    const at = Number.isInteger(row?.i) ? (row.i as number) : null;
    if (at !== null && ingredients[at]) {
      const ing = ingredients[at];
      if (quantity == null) continue;
      const same = ing.quantity != null && Math.abs(ing.quantity - quantity) < 1e-6 && (ing.unitId ?? null) === unitId;
      if (same) continue;
      changes.push({
        id: id('qty'), group: 'ingredients', type: 'ingredientQty', kind: ing.quantity == null ? 'fill' : 'fix',
        index: at, label: labels[at], quantity, unitId, unitSymbol,
        before: fmt(ing.quantity, ing.unitSymbol), after: fmt(quantity, unitSymbol), evidence,
      });
      continue;
    }

    const name = str(row?.name);
    if (!name || name.length > 80) continue;
    const key = name.toLowerCase();
    if (added.has(key) || isListed(name, labels)) continue;
    added.add(key);
    changes.push({
      id: id('add'), group: 'ingredients', type: 'ingredientAdd', kind: 'fill',
      name, quantity, unitId, unitSymbol, estimated: false, after: quantity != null ? fmt(quantity, unitSymbol) : '', evidence,
    });
  }

  // 2 ── Steps: enrich one, or add a stage the recipe lacks
  const touched = new Set<number>();
  for (const row of (Array.isArray(parsed?.steps) ? parsed.steps : []).slice(0, 30)) {
    const evidence = str(row?.evidence);
    const text = str(row?.text);
    if (!quoted(evidence) || !text || text.includes('{{') || text.length > 4000) continue;
    const durationRaw = num(row?.durationMin);
    const durationMin = durationRaw != null && durationRaw <= 24 * 60 && numberSupportedBy(durationRaw, evidence) ? Math.round(durationRaw) : null;
    const at = Number.isInteger(row?.i) ? (row.i as number) : null;

    if (at !== null && steps[at]) {
      if (touched.has(at)) continue;
      const original = plainStepText(steps[at].description, ingredients, cat);
      if (normText(text) === normText(original)) continue;
      // Enriched, not replaced: it keeps most of what it said.
      if (original && text.length < original.length * 0.8) continue;
      const allowed = [...numbersIn(original)];
      if (numbersIn(text).some((n) => !inPasted(n) && !allowed.some((a) => Math.abs(a - n) <= 1e-6 + Math.abs(a) * 0.005))) continue;
      touched.add(at);
      changes.push({ id: id('rw'), group: 'steps', type: 'stepRewrite', kind: 'fix', index: at, text, before: original, after: text, evidence });
      if (durationMin != null && steps[at].durationMin !== durationMin) {
        changes.push({
          id: id('dur'), group: 'steps', type: 'stepDuration', kind: steps[at].durationMin ? 'fix' : 'fill', index: at, durationMin,
          before: steps[at].durationMin ? `${steps[at].durationMin} min` : '—', after: `${durationMin} min`, evidence,
        });
      }
      continue;
    }

    if (numbersIn(text).some((n) => !inPasted(n))) continue;
    const title = str(row?.title);
    changes.push({ id: id('step'), group: 'steps', type: 'stepAdd', kind: 'fill', title, text, durationMin, after: title ? `${title} — ${text}` : text, evidence });
  }

  // 3 ── Servings and times
  const fields: Array<['servings' | 'prep_time_min' | 'cook_time_min' | 'rest_time_min', string]> = [
    ['servings', 'servings'], ['prep_time_min', 'prepTimeMin'], ['cook_time_min', 'cookTimeMin'], ['rest_time_min', 'restTimeMin'],
  ];
  for (const [field, key] of fields) {
    const entry = parsed?.[key];
    const value = num(entry?.value);
    const evidence = str(entry?.evidence);
    if (value == null || !quoted(evidence) || !numberSupportedBy(value, evidence) || value > 10000) continue;
    const current = draft[field] ?? null;
    if (current === value) continue;
    changes.push({
      id: id('field'), group: 'fields', type: 'field', kind: current ? 'fix' : 'fill', field, value: Math.round(value),
      before: current ? String(current) : '—', after: String(Math.round(value)), evidence,
    });
  }

  // 4 ── Yield
  const y = parsed?.yield;
  const yAmount = num(y?.amount);
  const yEvidence = str(y?.evidence);
  if (yAmount != null && quoted(yEvidence) && numberSupportedBy(yAmount, yEvidence)) {
    const unit = resolveUnit(str(y?.unit), cat.units);
    if (unit && !(draft.yield_amount === yAmount && draft.yield_unit_id === unit.id)) {
      const currentUnit = cat.units.find((u) => u.id === draft.yield_unit_id);
      changes.push({
        id: id('yield'), group: 'fields', type: 'yield', kind: draft.yield_amount ? 'fix' : 'fill', amount: yAmount, unitId: unit.id, unitSymbol: unit.symbol,
        before: draft.yield_amount ? fmt(draft.yield_amount, currentUnit?.symbol) : '—', after: fmt(yAmount, unit.symbol), evidence: yEvidence,
      });
    } else if (!unit && str(y?.unit)) unmatched.push(str(y?.unit)!);
  }

  // 5 ── Description, tips, storage: a paragraph to add
  const currentText = { description: draft.description, tips: draft.tips, storage: draft.storage_instructions };
  for (const row of (Array.isArray(parsed?.texts) ? parsed.texts : []).slice(0, 6)) {
    const target = row?.target;
    const text = str(row?.text);
    const evidence = str(row?.evidence);
    if ((target !== 'description' && target !== 'tips' && target !== 'storage') || !text || text.length > 3000 || !quoted(evidence)) continue;
    if (numbersIn(text).some((n) => !inPasted(n))) continue;
    const before = (currentText[target as keyof typeof currentText] ?? '').trim();
    if (before && normText(before).includes(normText(text))) continue;
    changes.push({
      id: id('text'), group: 'text', type: 'textAppend', kind: before ? 'fix' : 'fill', target, text,
      before: before || '—', after: before ? `${before}\n\n${text}` : text, evidence,
    });
  }

  // 6 ── Dish tags
  const haveTags = new Set((draft.tags ?? []).map((t) => t.toLowerCase()));
  const byLower = new Map(cat.tagNames.map((t) => [t.toLowerCase(), t]));
  let tagCount = 0;
  for (const row of Array.isArray(parsed?.tags) ? parsed.tags : []) {
    if (tagCount >= MAX_TAGS) break;
    const raw = str(row?.name);
    const evidence = str(row?.evidence);
    if (!raw || raw.length > 40 || !quoted(evidence)) continue;
    // A tag that is just one of the recipe's own ingredients is not a dish tag.
    if (labels.some((l) => l.toLowerCase() === raw.toLowerCase())) continue;
    const name = byLower.get(raw.toLowerCase()) ?? raw;
    if (haveTags.has(name.toLowerCase())) continue;
    haveTags.add(name.toLowerCase());
    tagCount++;
    changes.push({ id: id('tag'), group: 'tags', type: 'tag', kind: 'fill', name, evidence });
  }

  // 7 ── Regions
  const haveRegions = new Set((draft.regions ?? []).map((r) => r.toLowerCase()));
  for (const r of Array.isArray(parsed?.regions) ? parsed.regions : []) {
    const code = str(r?.country)?.toUpperCase() ?? null;
    const country = code && code.length === 2 && isCountryCode(code) ? code : null;
    const place = str(r?.place);
    const evidence = str(r?.evidence);
    if ((!country && !place) || !quoted(evidence)) continue;
    if ((place && haveRegions.has(place.toLowerCase())) || (!place && country && haveRegions.has(country.toLowerCase()))) continue;
    if (place) haveRegions.add(place.toLowerCase());
    changes.push({ id: id('region'), group: 'regions', type: 'region', kind: 'fill', country, place, label: [place, country].filter(Boolean).join(' · '), evidence });
  }

  // 8 ── Sources
  const pastedUrls = new Set((pasted.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')));
  const haveUrls = new Set([...(draft.sources ?? []).map((s) => s.url).filter(Boolean), draft.source_url].filter(Boolean) as string[]);
  const haveLabels = new Set((draft.sources ?? []).map((s) => (s.label ?? '').toLowerCase()).filter(Boolean));
  const proposedUrls = new Set<string>();
  const addSource = (source: CheckSource, evidence: string) => {
    if (source.url) {
      if (haveUrls.has(source.url) || proposedUrls.has(source.url)) return;
      proposedUrls.add(source.url);
    } else if (!source.label || haveLabels.has(source.label.toLowerCase())) return;
    if (source.label) haveLabels.add(source.label.toLowerCase());
    changes.push({ id: id('src'), group: 'sources', type: 'sourceAdd', kind: 'fill', source, label: source.label || source.url || '', evidence });
  };
  for (const row of (Array.isArray(parsed?.sources) ? parsed.sources : []).slice(0, 10)) {
    const type = SOURCE_TYPES.has(row?.type) ? (row.type as CheckSource['type']) : 'other';
    const url = str(row?.url)?.replace(/[.,;:!?]+$/, '') ?? null;
    const label = str(row?.label)?.slice(0, 200) ?? null;
    const evidence = str(row?.evidence) ?? '';
    if (url) {
      // Only a web address the text really contains — never one the model recalls.
      if (!pastedUrls.has(url)) continue;
      addSource({ type: type === 'other' || type === 'book' ? 'url' : type, url, ...(label ? { label } : {}) }, evidence || url);
    } else if (label && quoted(evidence)) {
      addSource({ type, label }, evidence);
    }
  }
  // A link in the text the model left out is still a source the user pasted.
  for (const url of pastedUrls) addSource({ type: /youtu\.?be|vimeo|tiktok|instagram/i.test(url) ? 'video' : 'url', url }, url);

  return { changes, warnings: [...new Set(warnings)], unmatched: [...new Set(unmatched)], mismatch: null };
}
