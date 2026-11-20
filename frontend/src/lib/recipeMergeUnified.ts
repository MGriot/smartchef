// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Merge with AI": several saved versions of one dish, and the
// pages they came from, written up as ONE recipe
//
// The model reads every version and every reference page, compares them,
// and writes a single unified recipe together with its reasoning. Where two
// versions disagree in a way the text cannot settle, it does not choose in
// silence: it raises a doubt, and the user settles it in a chat that goes
// on until the draft is right. Nothing is saved until they say so.
//
// What keeps the rewrite honest is here, in code, not in the prompt:
//   - an ingredient row is one of the rows the versions already have (its
//     "from"), so the link to the ingredient library survives; a new one is
//     only accepted when the service finds it in the library;
//   - amounts, servings and durations are numbers or nothing;
//   - the overall times are what the model states or the sum of the step
//     durations (lib/recipeTimes.ts), never a guess left to stand;
//   - a reply that carries no usable recipe leaves the draft as it was.
// Pure functions throughout; the model calls and the database are in
// services/recipeMergeUnified.local.ts.
// ════════════════════════════════════════════════════════════════════════

import { parseMinutes } from './parseMinutes';
import { deriveRecipeTimes, timeKindOf, type TimeKind } from './recipeTimes';

/** One turn of a conversation with the model, in the shape the provider
 *  client takes (services/llmParser.local.ts's ChatTurn). */
export interface ChatTurnLike { role: 'user' | 'assistant'; content: string }

// ── What goes in ────────────────────────────────────────────────────────

export interface UnifiedSourceIngredient {
  id: string;
  label: string;
  quantity: number | null;
  quantityText: string | null;
  unit: string | null;
  unitId: string | null;
  notes: string | null;
  groupName: string | null;
  isOptional: boolean;
  ingredientId: string | null;
  subRecipeId: string | null;
  subtypeId: string | null;
}

export interface UnifiedSourceStep {
  id: string;
  title: string | null;
  /** Plain prose: every {{…}} reference turned into the words it reads as. */
  text: string;
  durationMin: number | null;
  notes: string | null;
  toolIds: string[];
  techniqueIds: string[];
  imageUrl: string | null;
}

export interface UnifiedNamedEntity { id: string; names: string[] }

export interface UnifiedSourceRecipe {
  id: string;
  title: string;
  description: string | null;
  tips: string | null;
  storage: string | null;
  servings: number | null;
  prepTimeMin: number | null;
  cookTimeMin: number | null;
  restTimeMin: number | null;
  difficulty: string | null;
  ingredients: UnifiedSourceIngredient[];
  steps: UnifiedSourceStep[];
  tools: UnifiedNamedEntity[];
  techniques: UnifiedNamedEntity[];
}

// ── What comes out ──────────────────────────────────────────────────────

export interface UnifiedIngredient {
  /** The existing row this one is ("r.i"), or null for an ingredient only a
   *  reference page names. */
  from: string | null;
  label: string;
  quantity: number | null;
  quantityText: string | null;
  unit: string | null;
  notes: string | null;
  groupName: string | null;
  isOptional: boolean;
}

export interface UnifiedStep {
  title: string | null;
  text: string;
  durationMin: number | null;
  timeKind: TimeKind | null;
  /** The steps of the versions this one draws on. */
  from: string[];
}

export interface UnifiedDraft {
  title: string;
  description: string | null;
  tips: string | null;
  storage: string | null;
  servings: number | null;
  prepTimeMin: number | null;
  cookTimeMin: number | null;
  restTimeMin: number | null;
  difficulty: string | null;
  ingredients: UnifiedIngredient[];
  steps: UnifiedStep[];
}

export interface UnifiedDoubt { question: string; options: string[] }

export interface UnifiedAnswer {
  /** What the model says to the user this turn. */
  reply: string;
  /** How it compared the versions and why it chose what it chose. */
  reasoning: string[];
  /** The whole recipe as it now stands; null when this turn changed nothing. */
  draft: UnifiedDraft | null;
  doubts: UnifiedDoubt[];
  warnings: string[];
}

export const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard', 'expert'];

// ── The request ─────────────────────────────────────────────────────────

const refOf = (r: number, i: number) => `${r}.${i}`;

export function parseRef(ref: unknown): { r: number; i: number } | null {
  if (typeof ref !== 'string' && typeof ref !== 'number') return null;
  const m = /^(\d+)\.(\d+)$/.exec(String(ref).trim());
  return m ? { r: Number(m[1]), i: Number(m[2]) } : null;
}

export function buildUnifiedRequest(
  recipes: UnifiedSourceRecipe[],
  sourcePages: Array<{ url: string; title: string | null; text: string }>,
  language: string,
) {
  return {
    language,
    recipes: recipes.map((r, ri) => ({
      index: ri,
      kept: ri === 0,
      title: r.title,
      description: r.description,
      tips: r.tips,
      storage: r.storage,
      servings: r.servings,
      prepTimeMin: r.prepTimeMin,
      cookTimeMin: r.cookTimeMin,
      restTimeMin: r.restTimeMin,
      difficulty: r.difficulty,
      ingredients: r.ingredients.map((ing, i) => ({
        ref: refOf(ri, i),
        name: ing.label,
        quantity: ing.quantity,
        quantityText: ing.quantityText,
        unit: ing.unit,
        notes: ing.notes,
        group: ing.groupName,
        optional: ing.isOptional,
      })),
      steps: r.steps.map((s, i) => ({ ref: refOf(ri, i), title: s.title, text: s.text, durationMin: s.durationMin, notes: s.notes })),
    })),
    sourcePages,
  };
}

export function buildUnifiedSystemPrompt(): string {
  return `You merge several saved versions of the SAME dish, from a recipe-management app, into ONE unified recipe, and then refine it in a conversation with the user.

The first message carries "recipes" and "sourcePages". "recipes": the versions; index 0 ("kept": true) is the record that survives, the others are deleted once merged. Every ingredient and step has a "ref" ("recipe.row"). "sourcePages": the text of the web pages these versions cite as their references, read for you. "language": the language to write everything in.

WORK IN THIS ORDER
1. Read every version and every source page, completely.
2. Compare them. Line up the ingredients and the steps across the versions and the pages: where they agree, where one says more (a temperature, a duration, a tip, a missing ingredient), where they conflict (different amounts, times, order, a different ingredient for the same role).
3. Settle what the text can settle. The page a version was taken from outranks a saved copy that lost or garbled something on the way; two versions agreeing outrank one. Mind the servings: amounts belong to a serving count, so never put together amounts written for different numbers of servings without scaling them, and when you scale say so.
4. Write ONE recipe: each ingredient once; the steps in cooking order, steps that say the same thing merged into one, every useful detail of any version kept. It must read as a recipe someone wrote, not as two recipes stapled together.
5. Explain yourself in "reasoning": short points, one per decision that mattered (what differed, what you chose, on what ground, naming the version or the site).

NEVER INVENT
Every ingredient, amount, time, temperature and action must come from one of the versions or one of the source pages. No cooking knowledge of your own, no typical values. If nothing states it, leave it out or null.

DOUBTS
When the versions differ in a way the text cannot settle (two legitimate variants: one cheese or another, with or without wine, 40 or 60 minutes with no page to arbitrate), do NOT decide in silence. Put the kept version's variant in the recipe and add a doubt: {"question": one clear question, "options": 2 to 4 short answers the user can tap}. Do the same when a source page could not confirm something important. Few and real: a doubt is a question whose answer changes the recipe.

FORMAT OF THE RECIPE
- "ingredients": each {"from": the "ref" of the existing row it is, "name", "quantity": number or null, "quantityText": string or null (a vague amount such as "q.b."), "unit": string or null, "notes": string or null, "group": string or null (a heading such as "For the sauce", only if a version groups its ingredients), "optional": boolean}. When several versions have the same ingredient, take the kept version's row as "from", or the most complete one; its amount may still come from another version or a page. An ingredient only a source page names: "from": null, with the "name" the page gives it, and only when it plainly belongs to this dish.
- "steps": each {"title": string or null, "text": plain prose with no markup, naming the ingredients by the words of your ingredient list, "durationMin": minutes or null (only when stated), "timeKind": "prep" | "cook" | "rest" | null (hands-on work, on the heat or in the oven, waiting; null without a duration), "from": the "ref"s of the steps it draws on, [] when it comes from a source page only}.
- "servings", "prepTimeMin", "cookTimeMin", "restTimeMin": what the versions or pages state, else null (the overall times are then added up from your steps).
- "difficulty": "easy" | "medium" | "hard" | "expert".

THE CONVERSATION
After your first answer the user writes to you: answers to your doubts, corrections, requests ("use the amounts of the second version", "split step 3", "what did the French page say about the wine?"). Do what they ask, within the same rules: if they ask for something no version or page supports, say so in "reply" and do it only if they insist, marking it in "warnings". Every answer returns the COMPLETE recipe as it now stands in "recipe" (never a fragment), or "recipe": null when nothing changes because they only asked a question. Drop a doubt once it is settled. "reply" is what you say to the user: short, in "language", plain text.

Respond EXCLUSIVELY with JSON:
{"reply": string, "reasoning": [string], "recipe": {"title": string, "description": string|null, "tips": string|null, "storage": string|null, "servings": number|null, "prepTimeMin": number|null, "cookTimeMin": number|null, "restTimeMin": number|null, "difficulty": string, "ingredients": [], "steps": []} | null, "doubts": [{"question": string, "options": [string]}], "warnings": [string]}`;
}

// ── Reading the answer ──────────────────────────────────────────────────

const clean = (v: unknown, max = 4000): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};

const oneLine = (v: unknown, max = 300): string | null => {
  const s = clean(v, max * 2);
  return s ? s.replace(/\s+/g, ' ').slice(0, max) : null;
};

const amount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim().replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const strings = (v: unknown, max: number, each = 600): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => oneLine(x, each)).filter((x): x is string => !!x))].slice(0, max) : [];

/** A `{{…}}` the model wrote would be read back as an inline reference to
 *  whatever sits at that position. Steps are plain prose here; the links are
 *  put in afterwards, by name. */
const stripRefs = (text: string) => text.replace(/\{\{[^}]*\}\}/g, '').replace(/[ \t]+/g, ' ').trim();

function readDraft(raw: any, recipes: UnifiedSourceRecipe[]): UnifiedDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const kept = recipes[0];

  const used = new Set<string>();
  const ingredients: UnifiedIngredient[] = [];
  for (const item of Array.isArray(raw.ingredients) ? raw.ingredients : []) {
    if (!item || typeof item !== 'object') continue;
    const ref = parseRef(item.from);
    const row = ref ? recipes[ref.r]?.ingredients[ref.i] : undefined;
    const from = row ? refOf(ref!.r, ref!.i) : null;
    // One row of a version is one ingredient of the result.
    if (from && used.has(from)) continue;
    const label = row ? row.label : oneLine(item.name, 120);
    if (!label) continue;
    if (from) used.add(from);
    const quantity = amount(item.quantity);
    ingredients.push({
      from,
      label,
      quantity,
      quantityText: quantity == null ? oneLine(item.quantityText, 60) : null,
      unit: oneLine(item.unit, 30),
      notes: oneLine(item.notes, 300),
      groupName: oneLine(item.group ?? item.groupName, 80),
      isOptional: item.optional === true || item.isOptional === true,
    });
  }

  const steps: UnifiedStep[] = [];
  for (const item of Array.isArray(raw.steps) ? raw.steps : []) {
    if (!item || typeof item !== 'object') continue;
    const text = stripRefs(clean(item.text ?? item.description) ?? '');
    if (!text) continue;
    const durationMin = parseMinutes(item.durationMin) || null;
    const from = [...new Set((Array.isArray(item.from) ? item.from : [item.from])
      .map(parseRef)
      .filter((r: { r: number; i: number } | null): r is { r: number; i: number } => !!r && !!recipes[r.r]?.steps[r.i])
      .map((r: { r: number; i: number }) => refOf(r.r, r.i)))] as string[];
    steps.push({
      title: oneLine(item.title, 120),
      text,
      durationMin,
      timeKind: durationMin ? timeKindOf({ timeKind: item.timeKind, description: text }) : null,
      from,
    });
  }

  // A recipe with nothing to cook from is a failed answer, not a merge: the
  // versions had ingredients and steps, so must the result.
  const hadIngredients = recipes.some((r) => r.ingredients.length > 0);
  const hadSteps = recipes.some((r) => r.steps.length > 0);
  if ((hadIngredients && ingredients.length === 0) || (hadSteps && steps.length === 0)) return null;

  const times = deriveRecipeTimes(
    { prepTimeMin: parseMinutes(raw.prepTimeMin), cookTimeMin: parseMinutes(raw.cookTimeMin), restTimeMin: parseMinutes(raw.restTimeMin) },
    steps.map((s) => ({ durationMin: s.durationMin, timeKind: s.timeKind, description: s.text })),
  );
  const servings = amount(raw.servings);
  const difficulty = typeof raw.difficulty === 'string' && DIFFICULTY_LEVELS.includes(raw.difficulty.trim().toLowerCase())
    ? raw.difficulty.trim().toLowerCase()
    : kept?.difficulty ?? null;

  return {
    title: oneLine(raw.title, 200) ?? kept?.title ?? '',
    description: clean(raw.description),
    tips: clean(raw.tips),
    storage: clean(raw.storage ?? raw.storageInstructions),
    servings: servings ? Math.round(servings) : kept?.servings ?? null,
    prepTimeMin: times.prepTimeMin ?? null,
    cookTimeMin: times.cookTimeMin ?? null,
    restTimeMin: times.restTimeMin ?? null,
    difficulty,
    ingredients,
    steps,
  };
}

export function interpretUnifiedResponse(parsed: any, recipes: UnifiedSourceRecipe[]): UnifiedAnswer {
  const doubts: UnifiedDoubt[] = [];
  for (const d of Array.isArray(parsed?.doubts) ? parsed.doubts : []) {
    const question = oneLine(d?.question, 400);
    if (!question) continue;
    doubts.push({ question, options: strings(d?.options, 4, 120) });
    if (doubts.length >= 6) break;
  }
  const reasoning = Array.isArray(parsed?.reasoning) ? strings(parsed.reasoning, 20) : strings([parsed?.reasoning], 1, 2000);
  return {
    reply: clean(parsed?.reply, 3000) ?? '',
    reasoning,
    draft: readDraft(parsed?.recipe, recipes),
    doubts,
    warnings: strings(parsed?.warnings, 8),
  };
}

// ── The conversation ────────────────────────────────────────────────────

export interface UnifiedExchange {
  /** What the user wrote; null for the opening turn (the versions themselves). */
  user: string | null;
  answer: UnifiedAnswer;
}

/** The draft as the JSON the model itself writes, so that what it is shown
 *  as "the recipe so far" is what the app actually holds after validation. */
export function draftAsModelJson(draft: UnifiedDraft) {
  return {
    title: draft.title,
    description: draft.description,
    tips: draft.tips,
    storage: draft.storage,
    servings: draft.servings,
    prepTimeMin: draft.prepTimeMin,
    cookTimeMin: draft.cookTimeMin,
    restTimeMin: draft.restTimeMin,
    difficulty: draft.difficulty,
    ingredients: draft.ingredients.map((i) => ({
      from: i.from, name: i.label, quantity: i.quantity, quantityText: i.quantityText, unit: i.unit, notes: i.notes, group: i.groupName, optional: i.isOptional,
    })),
    steps: draft.steps.map((s) => ({ title: s.title, text: s.text, durationMin: s.durationMin, timeKind: s.timeKind, from: s.from })),
  };
}

/** How many past exchanges travel in full words; older ones are dropped
 *  (the recipe they led to is in the latest answer anyway). */
const CHAT_WINDOW = 8;

/** The turns to send for the next user message: the versions and pages, the
 *  recent conversation (answers as their "reply" only), the recipe as it now
 *  stands, then the new message. */
export function buildUnifiedTurns(
  context: string,
  exchanges: UnifiedExchange[],
  draft: UnifiedDraft,
  message: string,
): ChatTurnLike[] {
  const turns: ChatTurnLike[] = [{ role: 'user', content: context }];
  const opening = exchanges[0];
  const recent = exchanges.slice(1).slice(-CHAT_WINDOW);
  const all = opening ? [opening, ...recent] : recent;
  all.forEach((exchange, n) => {
    if (exchange.user != null) turns.push({ role: 'user', content: exchange.user });
    const last = n === all.length - 1;
    turns.push({
      role: 'assistant',
      content: JSON.stringify(last
        ? { reply: exchange.answer.reply, reasoning: exchange.answer.reasoning, recipe: draftAsModelJson(draft), doubts: exchange.answer.doubts, warnings: exchange.answer.warnings }
        : { reply: exchange.answer.reply }),
    });
  });
  turns.push({ role: 'user', content: message });
  return turns;
}

// ── Saving ──────────────────────────────────────────────────────────────

export interface UnifiedSaveIngredient {
  sortOrder: number;
  ingredientId: string | null;
  subRecipeId: string | null;
  subtypeId: string | null;
  quantity: number | null;
  quantityText: string | null;
  unitId: string | null;
  notes: string | null;
  isOptional: boolean;
  groupName: string | null;
}

export interface UnifiedSaveStep {
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: string[];
  techniqueIds: string[];
  notes: string | null;
  imageUrl: string | null;
  stepIngredients: Array<{ ingredientSortOrder: number; amountMode: 'fraction'; portion: number }>;
}

export interface UnifiedSaveDeps {
  /** A unit wording to a unit id (lib/fuzzyMatch.ts's matchUnitId over the library). */
  unitIdFor: (unit: string) => string | null;
  /** Library ingredient for a name no version has a row for; null when none. */
  ingredientIdFor: (name: string) => string | null;
  /** Step prose with the ingredients it names turned into inline references,
   *  and which ingredient positions those are. */
  linkStep: (text: string, ingredientNames: string[], tools: UnifiedNamedEntity[], techniques: UnifiedNamedEntity[]) => { description: string; ingredientPositions: number[] };
  /** Ids of the recipes being merged: a row that uses one of them as a
   *  sub-recipe cannot survive, the recipe it points at is about to go. */
  mergedIds: Set<string>;
}

/** The draft as ingredient and step rows ready to be written, plus the
 *  ingredients that had to be left out (named by a page, absent from the
 *  library and from every version). */
export function draftToRows(draft: UnifiedDraft, recipes: UnifiedSourceRecipe[], deps: UnifiedSaveDeps): {
  ingredients: UnifiedSaveIngredient[];
  steps: UnifiedSaveStep[];
  names: string[];
  leftOut: string[];
} {
  const ingredients: UnifiedSaveIngredient[] = [];
  const names: string[] = [];
  const leftOut: string[] = [];

  for (const item of draft.ingredients) {
    const ref = parseRef(item.from);
    const row = ref ? recipes[ref.r]?.ingredients[ref.i] : undefined;
    const ingredientId = row ? row.ingredientId : deps.ingredientIdFor(item.label);
    const subRecipeId = row?.subRecipeId && !deps.mergedIds.has(row.subRecipeId) ? row.subRecipeId : null;
    if (!ingredientId && !subRecipeId) { leftOut.push(item.label); continue; }

    // The row's own unit when the wording is unchanged; otherwise the
    // library's unit for the new wording. A unit the library lacks stays as
    // words next to the amount rather than being dropped.
    let unitId: string | null = null;
    let quantity = item.quantity;
    let quantityText = item.quantityText;
    if (item.unit) {
      unitId = row && row.unit && row.unit.toLowerCase() === item.unit.toLowerCase() ? row.unitId : deps.unitIdFor(item.unit);
      if (!unitId) {
        quantityText = [quantity != null ? String(+quantity.toFixed(3)) : quantityText, item.unit].filter(Boolean).join(' ') || null;
        quantity = null;
      }
    }
    ingredients.push({
      sortOrder: ingredients.length,
      ingredientId: ingredientId ?? null,
      subRecipeId,
      subtypeId: row?.subtypeId ?? null,
      quantity,
      quantityText,
      unitId,
      notes: item.notes,
      isOptional: item.isOptional,
      groupName: item.groupName,
    });
    names.push(item.label);
  }

  const steps: UnifiedSaveStep[] = draft.steps.map((step, n) => {
    const origins = step.from.map(parseRef).flatMap((r) => (r && recipes[r.r]?.steps[r.i] ? [{ recipe: recipes[r.r], step: recipes[r.r].steps[r.i] }] : []));
    const toolIds = [...new Set(origins.flatMap((o) => o.step.toolIds))];
    const techniqueIds = [...new Set(origins.flatMap((o) => o.step.techniqueIds))];
    const known = <T extends UnifiedNamedEntity>(pick: (r: UnifiedSourceRecipe) => T[], ids: string[]) =>
      [...new Map(recipes.flatMap(pick).filter((e) => ids.includes(e.id)).map((e) => [e.id, e])).values()];
    const linked = deps.linkStep(step.text, names, known((r) => r.tools, toolIds), known((r) => r.techniques, techniqueIds));
    return {
      stepNumber: n + 1,
      title: step.title,
      description: linked.description,
      durationMin: step.durationMin,
      toolIds,
      techniqueIds,
      notes: null,
      imageUrl: origins.find((o) => o.step.imageUrl)?.step.imageUrl ?? null,
      stepIngredients: linked.ingredientPositions.map((at) => ({ ingredientSortOrder: at, amountMode: 'fraction' as const, portion: 1 })),
    };
  });

  return { ingredients, steps, names, leftOut };
}

/** "A", "B", "C"… for the versions, as the dialog names them. */
export const versionLetter = (index: number) => String.fromCharCode(65 + (index % 26));

/** Which versions a row or step of the draft came from, as letters. */
export function originsOf(from: string | string[] | null): string[] {
  const refs = (Array.isArray(from) ? from : [from]).map(parseRef).filter((r): r is { r: number; i: number } => !!r);
  return [...new Set(refs.map((r) => r.r))].sort((a, b) => a - b).map(versionLetter);
}
