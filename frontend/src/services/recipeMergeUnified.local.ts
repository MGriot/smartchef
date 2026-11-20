// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Merge with AI", standalone mode
//
// Loads the versions to merge, reads the pages they cite, and has the
// configured model write ONE unified recipe and explain it; then carries a
// conversation in which the user settles the model's doubts and asks for
// changes, the draft being rewritten at every turn. Saving it rewrites the
// kept recipe and folds the copies into it (recipes.local.ts's
// mergeRecipesUnified). The rules the model's answers are held to are in
// lib/recipeMergeUnified.ts.
//
// A merge in progress lives in memory, keyed by a session id: the dialog is
// one sitting, and nothing here is worth a table.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';
import { query } from '../db/local';
import { callConfiguredProviderChat, LONG_AI_TIMEOUT_MS, parseJsonObject, type ChatTurn } from './llmParser.local';
import { getRecipe, mergeRecipesUnified, type RecipeInput } from './recipes.local';
import { readRecipeSources } from './sourceReader.local';
import { sourcePagesForModel, sourcesReadSummary, type SourcePage } from '../lib/sourcePages';
import { STEP_REF_RE, parseRefParams, linkIngredientsInText, normalizeName } from '../lib/stepRefs';
import { ingredientsNamedInText, linkEntitiesInText } from '../lib/importLinking';
import { matchUnitId } from '../lib/fuzzyMatch';
import {
  buildUnifiedRequest, buildUnifiedSystemPrompt, buildUnifiedTurns, draftToRows, interpretUnifiedResponse, versionLetter,
  type UnifiedDoubt, type UnifiedDraft, type UnifiedExchange, type UnifiedSourceRecipe,
} from '../lib/recipeMergeUnified';

/** Most versions one AI merge takes: the request carries all of every one. */
export const MAX_AI_MERGE_RECIPES = 6;
/** A rewritten recipe with its reasoning is a longer answer than a parse. */
const MERGE_MAX_TOKENS = 8192;
/** Merges left open (a closed dialog never says goodbye) are dropped oldest first. */
const MAX_SESSIONS = 4;

interface Session {
  id: string;
  keptId: string;
  otherIds: string[];
  /** The rows as getRecipe returned them, kept recipe first. */
  raw: any[];
  recipes: UnifiedSourceRecipe[];
  pages: SourcePage[];
  context: string;
  exchanges: UnifiedExchange[];
  draft: UnifiedDraft;
  reasoning: string[];
  doubts: UnifiedDoubt[];
  warnings: string[];
}

export interface UnifiedMergeView {
  sessionId: string;
  recipes: Array<{ id: string; title: string; letter: string }>;
  draft: UnifiedDraft;
  reasoning: string[];
  doubts: UnifiedDoubt[];
  warnings: string[];
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  sourcesRead: Array<{ url: string; ok: boolean; title?: string; error?: string }>;
  /** Ingredients of the draft that only a page names and the library lacks:
   *  they cannot be saved as rows and are listed so the user adds them after. */
  notInLibrary: string[];
  /** The kept recipe has translations, which a rewrite makes stale. */
  hasTranslations: boolean;
}

const sessions = new Map<string, Session>();

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Loading the versions ────────────────────────────────────────────────

async function loadVersion(id: string): Promise<{ raw: any; recipe: UnifiedSourceRecipe }> {
  // No language: the merge is written in, and saved to, the recipe's own
  // base text. A translated view would be rewritten into the base fields.
  const raw: any = await getRecipe(id);
  if (!raw || raw.sync_status === 'deleted') throw new Error(i18n.t('errors.recipeNotFound'));
  const names: string[] = [];
  for (const ing of raw.ingredients ?? []) names[Number(ing.sortOrder)] = ing.ingredientName || ing.subRecipeTitle || '';
  const toolName = new Map<string, string>((raw.tools ?? []).map((t: any) => [String(t.id), t.name]));
  const techName = new Map<string, string>((raw.techniques ?? []).map((t: any) => [String(t.id), t.name]));
  const plain = (text: string) => (text || '').replace(STEP_REF_RE, (whole, type: string, refId: string, rawParams?: string) => {
    const key = refId.trim();
    const params = parseRefParams(rawParams);
    if (type === 'ing') {
      const label = params.alias || names[Number(key)] || whole;
      return params.amount ? `${params.amount} ${label}` : label;
    }
    return params.alias || (type === 'tool' ? toolName.get(key) : techName.get(key)) || whole;
  });
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
  return {
    raw,
    recipe: {
      id: String(raw.id),
      title: raw.title ?? '',
      description: raw.description ?? null,
      tips: raw.tips ?? null,
      storage: raw.storage_instructions ?? null,
      servings: num(raw.servings),
      prepTimeMin: num(raw.prep_time_min),
      cookTimeMin: num(raw.cook_time_min),
      restTimeMin: num(raw.rest_time_min),
      difficulty: raw.difficulty ?? null,
      ingredients: (raw.ingredients ?? []).map((ing: any) => ({
        id: String(ing.id),
        label: ing.ingredientName || ing.subRecipeTitle || '',
        quantity: num(ing.quantity),
        quantityText: ing.quantityText ?? null,
        unit: ing.unitSymbol ?? null,
        unitId: ing.unitId ?? null,
        notes: ing.notes ?? null,
        groupName: ing.groupName ?? null,
        isOptional: !!ing.isOptional,
        ingredientId: ing.ingredientId ?? null,
        subRecipeId: ing.subRecipeId ?? null,
        subtypeId: null,
      })),
      steps: (raw.steps ?? []).map((s: any) => ({
        id: String(s.id),
        title: s.title ?? null,
        text: plain(s.description ?? ''),
        durationMin: num(s.durationMin),
        notes: s.notes ?? null,
        toolIds: Array.isArray(s.toolIds) ? s.toolIds.map(String) : [],
        techniqueIds: Array.isArray(s.techniqueIds) ? s.techniqueIds.map(String) : [],
        imageUrl: s.imageUrl ?? null,
      })),
      tools: (raw.tools ?? []).map((t: any) => ({ id: String(t.id), names: [t.name].filter(Boolean) })),
      techniques: (raw.techniques ?? []).map((t: any) => ({ id: String(t.id), names: [t.name].filter(Boolean) })),
    },
  };
}

// ── Asking the model ────────────────────────────────────────────────────

async function ask(turns: ChatTurn[]) {
  const raw = await callConfiguredProviderChat(turns, buildUnifiedSystemPrompt(), { timeoutMs: LONG_AI_TIMEOUT_MS, maxTokens: MERGE_MAX_TOKENS });
  return parseJsonObject(raw);
}

/** Library ingredient ids by normalized name, base names and translations. */
async function libraryIngredientIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const base = await query<{ id: string; name: string }>("SELECT id, name FROM ingredients WHERE sync_status != 'deleted'");
  const live = new Set(base.map((r) => r.id));
  for (const r of base) { const key = normalizeName(r.name ?? ''); if (key && !index.has(key)) index.set(key, r.id); }
  const translated = await query<{ ingredient_id: string; translated_name: string | null }>(
    "SELECT ingredient_id, translated_name FROM ingredient_translations");
  for (const r of translated) {
    const key = normalizeName(r.translated_name ?? '');
    if (key && live.has(r.ingredient_id) && !index.has(key)) index.set(key, r.ingredient_id);
  }
  return index;
}

async function rowsFor(session: Session) {
  const needsLibrary = session.draft.ingredients.some((i) => !i.from);
  const [library, units] = await Promise.all([
    needsLibrary ? libraryIngredientIndex() : Promise.resolve(new Map<string, string>()),
    query<{ id: string; symbol: string; name: string }>("SELECT id, symbol, name FROM units"),
  ]);
  return draftToRows(session.draft, session.recipes, {
    unitIdFor: (unit) => matchUnitId(unit, units) ?? null,
    ingredientIdFor: (name) => library.get(normalizeName(name)) ?? null,
    mergedIds: new Set([session.keptId, ...session.otherIds]),
    linkStep: (text, ingredientNames, tools, techniques) => {
      const rows = ingredientNames.map((name) => ({ name }));
      const ingredientPositions = ingredientsNamedInText(text, rows, new Set());
      const refs = ingredientPositions.map((at) => ({ ingredientSortOrder: at, amountMode: 'fraction' as const, portion: 1 }));
      let description = linkIngredientsInText(text, refs, rows);
      description = linkEntitiesInText(description, 'tool', tools);
      description = linkEntitiesInText(description, 'tech', techniques);
      return { description, ingredientPositions };
    },
  });
}

async function viewOf(session: Session): Promise<UnifiedMergeView> {
  const messages: UnifiedMergeView['messages'] = [];
  for (const exchange of session.exchanges) {
    if (exchange.user != null) messages.push({ role: 'user', text: exchange.user });
    if (exchange.answer.reply) messages.push({ role: 'assistant', text: exchange.answer.reply });
  }
  const { leftOut } = await rowsFor(session);
  return {
    sessionId: session.id,
    recipes: session.recipes.map((r, i) => ({ id: r.id, title: r.title, letter: versionLetter(i) })),
    draft: session.draft,
    reasoning: session.reasoning,
    doubts: session.doubts,
    warnings: session.warnings,
    messages,
    sourcesRead: sourcesReadSummary(session.pages),
    notInLibrary: leftOut,
    hasTranslations: (session.raw[0]?.translations ?? []).length > 0,
  };
}

// ── The three calls ─────────────────────────────────────────────────────

/** Opens a merge: `keptId` first, then the copies. Reads the reference
 *  pages, asks for the first unified recipe. */
export async function startUnifiedMerge(keptId: string, otherIds: string[], uiLang?: string): Promise<UnifiedMergeView> {
  const ids = [keptId, ...new Set(otherIds.filter((id) => id !== keptId))];
  if (ids.length < 2) throw new Error(i18n.t('errors.recipeRequired'));
  if (ids.length > MAX_AI_MERGE_RECIPES) throw new Error(i18n.t('errors.tooManyRecipesToMerge', { count: MAX_AI_MERGE_RECIPES }));

  const loaded = await Promise.all(ids.map(loadVersion));
  const raw = loaded.map((l) => l.raw);
  const recipes = loaded.map((l) => l.recipe);
  const pages = await readRecipeSources(raw);
  const language = raw[0].language_code || uiLang || i18n.language || 'en';
  const context = JSON.stringify(buildUnifiedRequest(recipes, sourcePagesForModel(pages), language));

  const answer = interpretUnifiedResponse(await ask([{ role: 'user', content: context }]), recipes);
  if (!answer.draft) throw new Error(i18n.t('recipeDetail.aiMergeUnified.noRecipe'));

  const session: Session = {
    id: newSessionId(), keptId, otherIds: ids.slice(1), raw, recipes, pages, context,
    exchanges: [{ user: null, answer }],
    draft: answer.draft, reasoning: answer.reasoning, doubts: answer.doubts, warnings: answer.warnings,
  };
  sessions.set(session.id, session);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return viewOf(session);
}

function sessionOf(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(i18n.t('recipeDetail.aiMergeUnified.sessionLost'));
  return session;
}

/** One chat turn: the user's message in, the model's reply and (usually) a
 *  rewritten draft out. A reply with no usable recipe leaves the draft alone. */
export async function continueUnifiedMerge(sessionId: string, message: string): Promise<UnifiedMergeView> {
  const session = sessionOf(sessionId);
  const text = message.trim().slice(0, 4000);
  if (!text) throw new Error(i18n.t('errors.recipeRequired'));
  const turns = buildUnifiedTurns(session.context, session.exchanges, session.draft, text);
  const answer = interpretUnifiedResponse(await ask(turns), session.recipes);
  session.exchanges.push({ user: text, answer });
  if (answer.draft) {
    session.draft = answer.draft;
    // The doubts and warnings describe the recipe as it now stands.
    session.doubts = answer.doubts;
    session.warnings = answer.warnings;
    if (answer.reasoning.length) session.reasoning = answer.reasoning;
  }
  return viewOf(session);
}

/** Saves the draft as the kept recipe and folds the copies into it. */
export async function applyUnifiedMerge(sessionId: string): Promise<{ recipesUpdated: number } | null> {
  const session = sessionOf(sessionId);
  const kept = session.raw[0];
  const others = session.raw.slice(1);
  const { ingredients, steps } = await rowsFor(session);
  const draft = session.draft;

  const union = <T,>(lists: T[][]) => [...new Set(lists.flat())];
  const first = <T,>(pick: (r: any) => T | null | undefined) => {
    for (const r of session.raw) { const v = pick(r); if (v != null && v !== '') return v; }
    return null;
  };
  const stepTools = union(steps.map((s) => s.toolIds));
  const regions = union<string>(session.raw.map((r) => (Array.isArray(r.regions) ? r.regions : [])));
  const regionCoords = Object.assign({}, ...[...session.raw].reverse().map((r) => r.region_coords ?? {}));

  const content: RecipeInput = {
    title: draft.title || kept.title,
    description: draft.description,
    difficulty: draft.difficulty ?? kept.difficulty ?? 'medium',
    servings: draft.servings ?? kept.servings ?? 4,
    prepTimeMin: draft.prepTimeMin,
    cookTimeMin: draft.cookTimeMin,
    restTimeMin: draft.restTimeMin,
    rating: first((r) => r.rating),
    yieldAmount: first((r) => r.yield_amount),
    yieldUnitId: first((r) => (r.yield_amount ? r.yield_unit_id : null)),
    tags: union<string>(session.raw.map((r) => (Array.isArray(r.tags) ? r.tags : []))),
    regions,
    regionCoords,
    coverImageUrl: first((r) => r.cover_image_url),
    sourceUrl: first((r) => r.source_url),
    isComponent: !!kept.is_component,
    languageCode: kept.language_code ?? undefined,
    storageInstructions: draft.storage,
    tips: draft.tips,
    ingredients: ingredients.map((i) => ({
      sortOrder: i.sortOrder,
      ingredientId: i.ingredientId ?? undefined,
      subRecipeId: i.subRecipeId ?? undefined,
      subtypeId: i.subtypeId ?? undefined,
      quantity: i.quantity ?? undefined,
      quantityText: i.quantityText ?? undefined,
      unitId: i.unitId ?? undefined,
      notes: i.notes ?? undefined,
      isOptional: i.isOptional,
      groupName: i.groupName,
    })),
    steps,
    toolIds: union<string>([(kept.tools ?? []).map((t: any) => String(t.id)), stepTools]),
    // The translations described the recipe as it was. Stale ones would
    // show the old title and text under the new recipe: cleared, to be made again.
    translations: [],
  };

  const result = await mergeRecipesUnified(session.keptId, others.map((r) => String(r.id)), content);
  sessions.delete(sessionId);
  return result;
}

export function closeUnifiedMerge(sessionId: string): void {
  sessions.delete(sessionId);
}
