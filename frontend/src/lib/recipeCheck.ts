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
//   - ingredients, tools and techniques are resolved against rows that
//     already exist, and a step is only linked to one its own text mentions.
//
// What survives is a list of discrete changes the user goes through and ticks;
// nothing touches the draft until applyCheckChanges() is called with the
// ones they kept. Pure functions throughout, so the "never invent" rules are
// testable without a model or a page.
// ════════════════════════════════════════════════════════════════════════

import {
  STEP_REF_RE, normalizeName, linkIngredientsInText, syncIngredientRefAmount, parseRefParams,
  type StepIngredientRefLike,
} from './stepRefs';
import { linkEntitiesInText } from './importLinking';
import { matchUnitId } from './fuzzyMatch';
import { isCountryCode } from './countries';

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
}

export type CheckGroup = 'ingredients' | 'steps' | 'fields' | 'tags' | 'regions';

interface ChangeBase {
  id: string;
  group: CheckGroup;
  /** `fix` replaces a value the recipe already had; `fill` supplies a missing one. */
  kind: 'fix' | 'fill';
  /** The recipe's own words that justify the change. */
  evidence: string;
}

export type CheckChange =
  | (ChangeBase & { type: 'ingredientQty'; index: number; label: string; quantity: number; unitId: string | null; unitSymbol: string | null; before: string; after: string })
  | (ChangeBase & { type: 'stepDuration'; index: number; durationMin: number; before: string; after: string })
  | (ChangeBase & {
      type: 'stepLinks'; index: number;
      description: string;
      stepIngredients: CheckDraftStep['stepIngredients'];
      toolIds: string[]; techniqueIds: string[];
      /** Entities the step gains, by display name, for the review list. */
      added: { ingredients: string[]; tools: string[]; techniques: string[] };
    })
  | (ChangeBase & { type: 'field'; field: 'servings' | 'prep_time_min' | 'cook_time_min' | 'rest_time_min'; value: number; before: string; after: string })
  | (ChangeBase & { type: 'yield'; amount: number; unitId: string; unitSymbol: string; before: string; after: string })
  | (ChangeBase & { type: 'tag'; name: string })
  | (ChangeBase & { type: 'region'; country: string | null; place: string | null; label: string });

export interface CheckResult {
  changes: CheckChange[];
  /** The model's own notes on inconsistencies it could not settle. */
  warnings: string[];
  /** Names the model used that match nothing in the library (tools, techniques, units). */
  unmatched: string[];
}

// ── Reading the recipe ──────────────────────────────────────────────────

const labelOf = (e: CheckNamedEntity) => e.translated_name || e.name;
const entityNames = (e: CheckNamedEntity) => [e.name, e.translated_name, ...(e.synonyms ?? [])].filter((n): n is string => !!n && n.trim().length >= 3);
const ingredientLabel = (i: CheckDraftIngredient) => i.ingredientName || i.subRecipeTitle || '';

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

function numbersIn(s: string): number[] {
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

const mentions = (haystack: string, name: string) => {
  const n = normText(name);
  return n.length >= 3 && ` ${haystack} `.includes(` ${n} `);
};

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
      durationMin: s.durationMin,
      notes: s.notes,
    })),
  };
}

export function buildCheckSystemPrompt(cat: CheckCatalog): string {
  const list = (names: string[]) => (names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)');
  return `You audit ONE recipe from a recipe-management app. You receive its fields, its ingredient list (each with an index "i"), and its steps (each with an index "i" and plain text).

ABSOLUTE RULE — NEVER INVENT DATA. Use only what the recipe itself literally says. Do not use cooking knowledge to supply typical quantities, times, servings, yields, tags or places. If the recipe does not state it, return null / leave it out. A smaller correct answer is always better than a larger guessed one.

Every proposal MUST carry "evidence": a quote copied CHARACTER FOR CHARACTER from the recipe (title, description, tips, storage, an ingredient line, a step text or title), at most 25 words, that states the fact. Proposals without an exact quote are discarded automatically. Every number you propose must appear in its quote.

Do this, in order:
1. "ingredients": fix an ingredient's quantity/unit ONLY when the recipe states a different or missing amount for it elsewhere (typically a step saying "add 200 g of flour" while the list says 20 or nothing). {"i", "quantity": number, "unit": string|null, "evidence"}. Do not touch rows that are already consistent. Never change the amount of an ingredient the recipe states only once.
2. "steps": for each step, list what it uses, read from ITS OWN text:
   - "ingredients": [{"name": EXACT name from the ingredient list, "quantity": number|null, "unit": string|null}] — quantity/unit only when the step text states an amount of that ingredient (e.g. "add half the sugar" with 100 g in the list gives 50). null otherwise.
   - "tools": names of kitchen tools the step text mentions, "techniques": cooking techniques the step text mentions. Prefer names from these existing lists: tools ${list(cat.tools.map(labelOf))}; techniques ${list(cat.techniques.map(labelOf))}. A name not in the lists is simply ignored.
   - "durationMin": minutes, ONLY when the step text states a duration ("cook 20 minutes", "rest 1 hour" → 60).
   - "evidence": the quote supporting durationMin or the quantities (may be null if neither is given).
3. "servings", "prepTimeMin", "cookTimeMin", "restTimeMin": each {"value": number, "evidence": string} or null. Only when the recipe states it ("serves 4", "bake 30 minutes"). Do not add up or estimate.
4. "yield": {"amount": number, "unit": string, "evidence": string} or null — the finished quantity, only when stated ("makes 12 cookies", "about 1 litre").
5. "tags": [{"name": string, "evidence": string}] — only attributes the recipe states or plainly names (e.g. the title says "vegan", an ingredient list shows no meat only if the text says vegetarian). Prefer existing tags: ${list(cat.tagNames)}. Max 6.
6. "regions": [{"country": ISO 3166-1 alpha-2 or null, "place": string|null, "evidence": string}] — only a place the recipe's text, title or source URL names as the dish's origin ("alla romana", "Sicilian", a .it recipe-site domain is NOT enough).
7. "warnings": short notes on inconsistencies you noticed but could not resolve from the text (e.g. an ingredient never used in any step). Write them in the recipe's language.

Respond EXCLUSIVELY with JSON:
{"ingredients":[],"steps":[],"servings":null,"prepTimeMin":null,"cookTimeMin":null,"restTimeMin":null,"yield":null,"tags":[],"regions":[],"warnings":[]}`;
}

// ── What comes back ─────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function findEntity(name: string, entities: CheckNamedEntity[]): CheckNamedEntity | undefined {
  const key = normText(name);
  if (!key) return undefined;
  const exact = entities.find((e) => entityNames(e).some((n) => normText(n) === key));
  if (exact) return exact;
  if (key.length < 4) return undefined;
  return entities.find((e) => entityNames(e).some((n) => {
    const k = normText(n);
    return k.length >= 4 && (k.includes(key) || key.includes(k));
  }));
}

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
function resolveUnit(text: string | null | undefined, units: CheckUnit[]): CheckUnit | undefined {
  const key = normText(text ?? '');
  if (!key) return undefined;
  const direct = units.find((u) => normText(u.symbol) === key || normText(u.name) === key);
  if (direct) return direct;
  const viaAlias = units.find((u) => u.id === matchUnitId(text ?? undefined, units));
  const head = key.slice(0, 4);
  return viaAlias && key.length >= 4 && normText(viaAlias.name).startsWith(head) ? viaAlias : undefined;
}

const fmt = (qty: number | null | undefined, unit?: string | null) =>
  qty == null ? '—' : `${qty % 1 === 0 ? qty : Number(qty.toFixed(2))}${unit ? ` ${unit}` : ''}`;

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

  // 1 ── Ingredient quantities
  for (const row of Array.isArray(parsed?.ingredients) ? parsed.ingredients : []) {
    const index = Number.isInteger(row?.i) ? row.i : -1;
    const ing = ingredients[index];
    const quantity = num(row?.quantity);
    if (!ing || quantity == null || !evidenceHolds(row.evidence, corpus) || !numberSupportedBy(quantity, row.evidence)) continue;
    // A quote about some other ingredient cannot justify this row's amount.
    if (!ingredientMentioned(normText(row.evidence), ing)) continue;

    let unitId = ing.unitId;
    let unitSymbol = ing.unitSymbol ?? null;
    const unitText = str(row.unit);
    if (unitText) {
      const unit = resolveUnit(unitText, cat.units);
      if (!unit) { unmatched.push(unitText); continue; }
      unitId = unit.id;
      unitSymbol = unit.symbol;
    }
    if (ing.quantity === quantity && (ing.unitId ?? null) === (unitId ?? null)) continue;
    changes.push({
      id: id('ing'), group: 'ingredients', type: 'ingredientQty', index, label: ingredientLabel(ing),
      kind: ing.quantity == null ? 'fill' : 'fix',
      quantity, unitId, unitSymbol,
      before: fmt(ing.quantity, ing.unitSymbol), after: fmt(quantity, unitSymbol),
      evidence: row.evidence.trim(),
    });
  }

  // 2 ── Steps: links to ingredients, tools and techniques, and the duration
  const usage = new Map<number, number>();
  steps.forEach((s) => (s.stepIngredients ?? []).forEach((r) => usage.set(r.ingredientSortOrder, (usage.get(r.ingredientSortOrder) ?? 0) + 1)));
  const stepRows: any[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const proposed = stepRows.map((row) => {
    const index = Number.isInteger(row?.i) ? row.i : -1;
    const step = steps[index];
    if (!step) return null;
    const text = plainStepText(`${step.title ?? ''} ${step.description}`, ingredients, cat);
    const textNorm = normText(text);
    const uses = (Array.isArray(row.ingredients) ? row.ingredients : [])
      .map((u: any) => ({ name: str(u?.name), quantity: num(u?.quantity), unit: str(u?.unit) }))
      .filter((u: any) => u.name);
    // Resolve by name against this recipe's own rows, never by position.
    const hits = new Map<number, { quantity: number | null; unit: string | null }>();
    for (const u of uses) {
      const key = normalizeName(u.name);
      if (!key) continue;
      const hit =
        ingredients.findIndex((x) => normalizeName(ingredientLabel(x)) === key) >= 0
          ? ingredients.findIndex((x) => normalizeName(ingredientLabel(x)) === key)
          : ingredients.findIndex((x) => { const k = normalizeName(ingredientLabel(x)); return k && (k.includes(key) || key.includes(k)); });
      if (hit < 0 || !ingredientMentioned(textNorm, ingredients[hit])) continue;
      // An amount for this step has to be quoted from the recipe.
      const amountOk = u.quantity != null && evidenceHolds(row.evidence, corpus) && numberSupportedBy(u.quantity, row.evidence);
      hits.set(hit, amountOk ? { quantity: u.quantity, unit: u.unit } : { quantity: null, unit: null });
    }
    return { index, row, step, text, textNorm, hits };
  });

  // Count how many steps will use each ingredient once the proposals land, so
  // an ingredient used in several steps is not credited 100% in each.
  for (const p of proposed) {
    if (!p) continue;
    const have = new Set((p.step.stepIngredients ?? []).map((r) => r.ingredientSortOrder));
    for (const so of p.hits.keys()) if (!have.has(so)) usage.set(so, (usage.get(so) ?? 0) + 1);
  }

  for (const p of proposed) {
    if (!p) continue;
    const { index, row, step, textNorm } = p;
    let description = step.description;
    const stepIngredients = [...(step.stepIngredients ?? [])];
    const added = { ingredients: [] as string[], tools: [] as string[], techniques: [] as string[] };

    const newRefs: StepIngredientRefLike[] = [];
    // Only ingredients this step is not already linked to are touched; what
    // the author linked by hand stays exactly as written.
    const fresh = [...p.hits.keys()].filter((so) => !stepIngredients.some((r) => r.ingredientSortOrder === so));
    for (const [so, use] of p.hits) {
      if (!fresh.includes(so)) continue;
      const ing = ingredients[so];
      let ref: StepIngredientRefLike | null = null;
      if (use.quantity != null) {
        const unit = resolveUnit(use.unit, cat.units);
        ref = { ingredientSortOrder: so, amountMode: 'absolute', portion: 1, quantity: use.quantity, unitSymbol: unit?.symbol ?? ing.unitSymbol ?? null };
        (ref as any).unitId = unit?.id ?? ing.unitId ?? null;
      } else if ((usage.get(so) ?? 0) <= 1) {
        ref = { ingredientSortOrder: so, amountMode: 'fraction', portion: 1 };
      }
      if (ref) { stepIngredients.push(ref as any); newRefs.push(ref); }
      added.ingredients.push(ingredientLabel(ing));
    }
    // In-text tokens for what is newly linked; an ingredient shared by several
    // steps is named without an amount rather than a made-up share.
    description = linkIngredientsInText(
      description,
      fresh.map((so) => ({ ingredientSortOrder: so, portion: 1 })),
      ingredients.map((i) => ({ name: ingredientLabel(i) })),
    );
    for (const ref of newRefs) {
      if (ref.amountMode === 'absolute') description = syncIngredientRefAmount(description, ref.ingredientSortOrder, fmt(ref.quantity, ref.unitSymbol));
    }
    for (const so of fresh) {
      if (newRefs.some((r) => r.ingredientSortOrder === so)) continue;
      description = description.replace(new RegExp(String.raw`\{\{ing:${so}\}\}`, 'g'), `{{ing:${so}|q=}}`);
    }

    const link = (type: 'tool' | 'tech', names: unknown, pool: CheckNamedEntity[], have: string[]) => {
      const out = [...have];
      for (const raw of Array.isArray(names) ? names : []) {
        const name = str(raw);
        const entity = name ? findEntity(name, pool) : undefined;
        // The step's own text has to mention it, under any name it answers to.
        if (!entity || out.includes(entity.id) || !entityNames(entity).concat(name ? [name] : []).some((n) => mentions(textNorm, n))) {
          if (name && !entity) unmatched.push(name);
          continue;
        }
        out.push(entity.id);
        (type === 'tool' ? added.tools : added.techniques).push(labelOf(entity));
        description = linkEntitiesInText(description, type, [{ id: entity.id, names: [...entityNames(entity), name!] }]);
      }
      return out;
    };
    const toolIds = link('tool', row.tools, cat.tools, step.toolIds ?? []);
    const techniqueIds = link('tech', row.techniques, cat.techniques, step.techniqueIds ?? []);

    if (added.ingredients.length || added.tools.length || added.techniques.length) {
      changes.push({
        id: id('links'), group: 'steps', type: 'stepLinks', kind: 'fill', index, description,
        stepIngredients: stepIngredients as CheckDraftStep['stepIngredients'], toolIds, techniqueIds, added,
        evidence: step.title?.trim() || p.text.slice(0, 80),
      });
    }

    const minutes = num(row.durationMin);
    if (minutes != null && evidenceHolds(row.evidence, corpus) && numberSupportedBy(minutes, row.evidence) && step.durationMin !== minutes) {
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
  for (const t of (Array.isArray(parsed?.tags) ? parsed.tags : []).slice(0, 6)) {
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

  return { changes, warnings: [...new Set(warnings)], unmatched: [...new Set(unmatched)] };
}

// ── Applying the ones the user kept ─────────────────────────────────────

export interface ResolvedRegionsInput {
  regions: string[];
  regionCoords: Record<string, unknown>;
}

/** Returns a new draft with `changes` applied. Region changes are carried by
 *  `resolved` (their labels and coordinates need a geocoder, which is async
 *  and belongs to the page); everything else is derived from the change. */
export function applyCheckChanges<T extends CheckDraft>(draft: T, changes: CheckChange[], resolved?: ResolvedRegionsInput, catalog?: Pick<CheckCatalog, 'tools' | 'techniques'>): T {
  const next: any = { ...draft };
  const steps: any[] = (draft.steps ?? []).map((s) => ({ ...s }));
  const ingredients: any[] = (draft.ingredients ?? []).map((i) => ({ ...i }));
  const tags = [...(draft.tags ?? [])];

  for (const c of changes) {
    switch (c.type) {
      case 'ingredientQty':
        if (ingredients[c.index]) ingredients[c.index] = { ...ingredients[c.index], quantity: c.quantity, quantityText: null, unitId: c.unitId, unitSymbol: c.unitSymbol };
        break;
      case 'stepDuration':
        if (steps[c.index]) steps[c.index].durationMin = c.durationMin;
        break;
      case 'stepLinks':
        if (steps[c.index]) {
          steps[c.index].description = c.description;
          steps[c.index].stepIngredients = c.stepIngredients;
          steps[c.index].toolIds = c.toolIds;
          steps[c.index].techniqueIds = c.techniqueIds;
        }
        break;
      case 'field': next[c.field] = c.value; break;
      case 'yield': next.yield_amount = c.amount; next.yield_unit_id = c.unitId; next.yield_unit_symbol = c.unitSymbol; break;
      case 'tag': if (!tags.some((t) => t.toLowerCase() === c.name.toLowerCase())) tags.push(c.name); break;
      case 'region': break;
    }
  }

  // The recipe-level tool and technique lists follow what the steps now use.
  if (catalog) {
    const used = (key: 'toolIds' | 'techniqueIds') => new Set(steps.flatMap((s) => s[key] ?? []));
    const toolIds = used('toolIds');
    const techIds = used('techniqueIds');
    const merge = (list: CheckNamedEntity[] | undefined, ids: Set<string>, pool: CheckNamedEntity[]) => {
      const out = [...(list ?? [])];
      for (const id of ids) if (!out.some((e) => e.id === id)) { const e = pool.find((p) => p.id === id); if (e) out.push(e); }
      return out;
    };
    next.tools = merge(draft.tools, toolIds, catalog.tools);
    if (draft.techniques) next.techniques = merge(draft.techniques, techIds, catalog.techniques);
  }

  next.steps = steps;
  next.ingredients = ingredients;
  next.tags = tags;
  if (resolved && changes.some((c) => c.type === 'region')) {
    const have = new Set((draft.regions ?? []).map((r) => r.toLowerCase()));
    next.regions = [...(draft.regions ?? []), ...resolved.regions.filter((r) => !have.has(r.toLowerCase()))];
    next.region_coords = { ...((draft as any).region_coords ?? {}), ...resolved.regionCoords };
  }
  return next as T;
}
