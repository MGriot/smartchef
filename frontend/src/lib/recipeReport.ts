// ════════════════════════════════════════════════════════════════════════
// SmartChef — The printed recipe report, as data
//
// pages/RecipeReport.tsx renders a recipe for paper: everything the recipe
// page shows, plus what only Kitchen mode shows today (each step's own
// tools, techniques and chef's note), plus the full text of every recipe it
// uses as an ingredient. This module decides WHAT goes on the page — every
// amount scaled and converted, every label resolved, every empty section
// left out — and the page only lays it out.
//
// Kept pure (no React, no i18n singleton; `t` and the locale-bound
// formatters are passed in) so it runs under vitest's node environment, the
// same way lib/cookidooExport.ts is built and tested.
//
// Amounts go through lib/recipeScaling.ts, the code the recipe page itself
// uses, so a printout can never disagree with the screen.
// ════════════════════════════════════════════════════════════════════════

import { formatDurationWith } from './duration';
import { pickIngredientName } from './ingredientDisplay';
import { createRecipeScaler, type RecipeScaler, type StepTextIngredient } from './recipeScaling';
import type { MeasurementSystem } from './unitConvert';

/** The page's own difficulty labels — shared with RecipeDetail. */
export const difficultyKey: Record<string, string> = {
  easy: 'gallery.difficultyEasy', medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced', expert: 'gallery.difficultyExpert',
};

/** An ingredient note as imports leave it — ", 7 circa," — without the
 *  separators that belonged to the source line around it. */
export const tidyNote = (note: string | null | undefined): string =>
  (note ?? '').replace(/^[\s,;]+|[\s,;]+$/g, '');

/** How deep the component-recipe walk goes. Real recipes nest two or three
 *  levels; this only stops a pathological chain from filling a printout. */
export const MAX_COMPONENT_DEPTH = 6;

// ── Input: the /api/recipes/:id payload, structurally ───────────────────

export interface ReportStepIngredientRef {
  ingredientSortOrder: number;
  amountMode?: 'fraction' | 'absolute';
  portion: number;
  quantity?: number | null;
  unitSymbol?: string | null;
}

export interface ReportIngredientInput {
  sortOrder: number;
  ingredientName?: string | null;
  ingredientPluralName?: string | null;
  subRecipeId?: string | null;
  subRecipeTitle?: string | null;
  quantity: number | null;
  quantityText?: string | null;
  unitSymbol?: string | null;
  isOptional?: boolean;
  notes?: string | null;
  translatedNotes?: string | null;
  groupName?: string | null;
  substituteFor?: number | null;
}

export interface ReportStepInput {
  id: string;
  stepNumber: number;
  title?: string | null;
  translatedTitle?: string | null;
  description: string;
  translatedDescription?: string | null;
  durationMin?: number | null;
  toolIds?: string[] | null;
  techniqueIds?: string[] | null;
  notes?: string | null;
  translatedNotes?: string | null;
  imageUrl?: string | null;
  stepIngredients?: ReportStepIngredientRef[] | null;
}

export interface ReportNamedInput {
  id: string;
  name: string;
  translated_name?: string | null;
}

export interface ReportSourceInput {
  type: 'url' | 'book' | 'video' | 'other';
  label?: string;
  url?: string;
}

export interface ReportRecipeInput {
  id: string;
  title: string;
  translated_title?: string | null;
  description?: string | null;
  translated_description?: string | null;
  storage_instructions?: string | null;
  tips?: string | null;
  difficulty?: string | null;
  servings: number;
  prep_time_min?: number | null;
  cook_time_min?: number | null;
  rest_time_min?: number | null;
  rating?: number | null;
  times_cooked?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  tags?: string[] | null;
  tags_display?: { name: string; translated_name?: string | null; color?: string | null }[] | null;
  regions?: string[] | null;
  yield_amount?: number | null;
  yield_unit_symbol?: string | null;
  cover_image_url?: string | null;
  source_url?: string | null;
  sources?: ReportSourceInput[] | null;
  creator_name?: string | null;
  ingredients?: ReportIngredientInput[] | null;
  steps?: ReportStepInput[] | null;
  tools?: ReportNamedInput[] | null;
  techniques?: ReportNamedInput[] | null;
}

export interface ReportNutritionTotals {
  caloriesKcal: number; proteinG: number; carbsG: number; fatG: number;
  fiberG: number; sugarG: number; sodiumMg: number;
}

export interface ReportNutritionInput {
  /** At the recipe's own base servings, as /api/recipes/:id/nutrition
   *  returns it when asked for `?servings=<recipe.servings>`. */
  totals: ReportNutritionTotals;
  unresolved?: string[];
}

export interface ReportInput {
  recipe: ReportRecipeInput;
  /** Every recipe reachable through a subRecipeId, by id. Missing entries
   *  (a sub-recipe that failed to load) are simply not printed. */
  subRecipes?: Map<string, ReportRecipeInput>;
  /** The technique library, for {{tech:id}} references in step text. */
  techniques?: ReportNamedInput[];
  nutrition?: ReportNutritionInput | null;
}

export interface ReportOptions {
  servings: number;
  displaySystem: MeasurementSystem;
  includeCover: boolean;
  includeStepPhotos: boolean;
  includeComponents: boolean;
  includeNutrition: boolean;
}

export interface ReportFormatters {
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Date only, in the reader's locale. */
  formatDate: (iso: string) => string;
  /** A region code or free-text region, as the page shows it. */
  formatRegion: (region: string) => string;
}

// ── Output ──────────────────────────────────────────────────────────────

export interface ReportFact {
  label: string;
  value: string;
}

export interface ReportSubstitute {
  name: string;
  amount: string;
  note: string | null;
}

export interface ReportIngredient {
  name: string;
  amount: string;
  optional: boolean;
  note: string | null;
  /** Set when this row is a recipe used as an ingredient AND that recipe
   *  is printed further down, so the row can point at it. */
  componentAnchor: string | null;
  substitutes: ReportSubstitute[];
}

export interface ReportIngredientGroup {
  name: string | null;
  items: ReportIngredient[];
}

export interface ReportStepTextContext {
  ingredients: StepTextIngredient[];
  tools: { id: string; name: string }[];
  techniques: { id: string; name: string }[];
  scale: number;
}

export interface ReportStep {
  key: string;
  number: number;
  title: string;
  duration: string | null;
  /** The stored image value; the page resolves it (local paths need it). */
  image: string | null;
  /** Raw step text with {{…}} tokens; render through RenderStepText with
   *  `textContext`. */
  text: string;
  textContext: ReportStepTextContext;
  /** "Flour: 500 g (80%)" — what the step takes out of the ingredients. */
  uses: string[];
  tools: string[];
  techniques: string[];
  note: string | null;
}

export interface ReportSection {
  id: string;
  /** Stable DOM id, for an ingredient row to link to its component. */
  anchor: string;
  title: string;
  description: string | null;
  facts: ReportFact[];
  /** Where a component recipe is used: "Used in Tiramisù: 300 g". */
  usedIn: string[];
  ingredientGroups: ReportIngredientGroup[];
  tools: string[];
  techniques: string[];
  steps: ReportStep[];
  storage: string | null;
  tips: string | null;
}

export interface ReportNutrition {
  heading: string;
  rows: ReportFact[];
  perServing: string;
  unresolved: string | null;
}

export interface ReportReference {
  type: ReportSourceInput['type'];
  label: string;
  url: string | null;
}

export interface RecipeReportModel {
  title: string;
  description: string | null;
  coverImage: string | null;
  /** Servings, yield, times, difficulty. */
  facts: ReportFact[];
  /** Author, rating, cook count, dates — one line under the title. */
  meta: string[];
  tags: { name: string; color: string | null }[];
  regions: string[];
  main: ReportSection;
  components: ReportSection[];
  nutrition: ReportNutrition | null;
  references: ReportReference[];
}

// ── Builder ─────────────────────────────────────────────────────────────

const nonEmpty = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
};

const anchorFor = (recipeId: string) => `report-recipe-${recipeId}`;

const nameOf = (item: ReportNamedInput) => item.translated_name || item.name;

/** Component recipes in the order they are prepared: a recipe's own
 *  components before it, depth-first — the order Kitchen mode cooks them
 *  in (matrioska.local.ts's cook sequence). Cycle-safe: a recipe already
 *  on the list, or on the path to it, is not visited again. */
export function componentOrder(
  root: ReportRecipeInput,
  subRecipes: Map<string, ReportRecipeInput>,
  maxDepth = MAX_COMPONENT_DEPTH,
): ReportRecipeInput[] {
  const ordered: ReportRecipeInput[] = [];
  const placed = new Set<string>([root.id]);

  const visit = (recipe: ReportRecipeInput, depth: number, path: Set<string>) => {
    if (depth > maxDepth) return;
    const rows = [...(recipe.ingredients || [])].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const row of rows) {
      const subId = row.subRecipeId;
      if (!subId || placed.has(subId) || path.has(subId)) continue;
      const sub = subRecipes.get(subId);
      if (!sub) continue;
      const nextPath = new Set(path).add(subId);
      visit(sub, depth + 1, nextPath);
      if (!placed.has(subId)) {
        placed.add(subId);
        ordered.push(sub);
      }
    }
  };

  visit(root, 1, new Set([root.id]));
  return ordered;
}

function buildIngredientGroups(
  recipe: ReportRecipeInput,
  scaler: RecipeScaler,
  printedComponents: Set<string>,
): ReportIngredientGroup[] {
  const sorted = [...(recipe.ingredients || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  // A substitute is not a line of its own — it belongs under the
  // ingredient it stands in for, exactly as the recipe page lists it.
  const substitutesFor = new Map<number, ReportIngredientInput[]>();
  for (const ing of sorted) {
    if (ing.substituteFor == null) continue;
    const list = substitutesFor.get(ing.substituteFor);
    if (list) list.push(ing);
    else substitutesFor.set(ing.substituteFor, [ing]);
  }
  const primary = sorted.filter(ing => ing.substituteFor == null);

  const label = (ing: ReportIngredientInput) =>
    ing.ingredientName
      ? pickIngredientName(ing.ingredientName, ing.ingredientPluralName, scaler.scaleNum(ing.quantity))
      : (ing.subRecipeTitle || '');

  const groups: ReportIngredientGroup[] = [];
  let prevGroupName: string | null | undefined = undefined;
  for (const ing of primary) {
    // Same rule as the page's group headers: a new header only where a
    // named group starts; an unnamed row keeps reading under the last one.
    const startsGroup = !!ing.groupName && ing.groupName !== prevGroupName;
    if (startsGroup || groups.length === 0) groups.push({ name: startsGroup ? ing.groupName! : null, items: [] });
    prevGroupName = ing.groupName;

    groups[groups.length - 1].items.push({
      name: label(ing),
      amount: scaler.formatAmount(ing.quantity, ing.unitSymbol, ing.quantityText),
      optional: !!ing.isOptional,
      note: nonEmpty(tidyNote(ing.translatedNotes || ing.notes)),
      componentAnchor: ing.subRecipeId && printedComponents.has(ing.subRecipeId) ? anchorFor(ing.subRecipeId) : null,
      substitutes: (substitutesFor.get(ing.sortOrder) ?? []).map(alt => ({
        name: label(alt),
        amount: scaler.formatAmount(alt.quantity, alt.unitSymbol, alt.quantityText),
        note: nonEmpty(tidyNote(alt.translatedNotes || alt.notes)),
      })),
    });
  }
  return groups.filter(g => g.items.length > 0);
}

function buildSteps(
  recipe: ReportRecipeInput,
  scaler: RecipeScaler,
  library: ReportNamedInput[],
  options: ReportOptions,
  t: ReportFormatters['t'],
): ReportStep[] {
  const tools = (recipe.tools || []).map(tool => ({ id: tool.id, name: nameOf(tool) }));
  // Recipe-level techniques first (getRecipe collects them from the steps,
  // translated), the library as the fallback for anything not among them.
  const techniqueNames = new Map<string, string>();
  for (const tech of library) techniqueNames.set(tech.id, nameOf(tech));
  for (const tech of recipe.techniques || []) techniqueNames.set(tech.id, nameOf(tech));
  const textTechniques = library.map(tech => ({ id: tech.id, name: nameOf(tech) }));

  const sortedSteps = [...(recipe.steps || [])].sort((a, b) => a.stepNumber - b.stepNumber);
  return sortedSteps.map(step => {
    const uses = scaler.stepIngredientList(step).map(si =>
      `${si.name}${si.quantity ? `: ${si.quantity}${si.unitSymbol ? ' ' + si.unitSymbol : ''}` : ''}${si.portionPct < 100 ? ` (${si.portionPct}%)` : ''}`,
    );
    return {
      key: `${recipe.id}:${step.id}`,
      number: step.stepNumber,
      title: step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber }),
      duration: step.durationMin ? formatDurationWith(t, step.durationMin) : null,
      image: options.includeStepPhotos ? nonEmpty(step.imageUrl) : null,
      text: step.translatedDescription || step.description || '',
      textContext: {
        ingredients: scaler.stepTextIngredientsFor(step),
        tools,
        techniques: textTechniques,
        scale: scaler.servingsScale,
      },
      uses,
      tools: (step.toolIds || []).map(id => tools.find(tool => tool.id === id)?.name).filter((n): n is string => !!n),
      techniques: (step.techniqueIds || []).map(id => techniqueNames.get(id)).filter((n): n is string => !!n),
      note: nonEmpty(step.translatedNotes || step.notes),
    };
  });
}

function timeFacts(recipe: ReportRecipeInput, t: ReportFormatters['t']): ReportFact[] {
  const prep = recipe.prep_time_min ?? 0;
  const rest = recipe.rest_time_min ?? 0;
  const cook = recipe.cook_time_min ?? 0;
  const facts: ReportFact[] = [];
  // Zero rows are left off paper: "Waiting time —" on a salad is ink that
  // says nothing.
  if (prep > 0) facts.push({ label: t('recipeDetail.prepTime'), value: formatDurationWith(t, prep, { short: true }) });
  if (rest > 0) facts.push({ label: t('recipeDetail.waitingTime'), value: formatDurationWith(t, rest, { short: true }) });
  if (cook > 0) facts.push({ label: t('recipeDetail.cookTime'), value: formatDurationWith(t, cook, { short: true }) });
  if (prep + rest + cook > 0) facts.push({ label: t('recipeDetail.totalTime'), value: formatDurationWith(t, prep + rest + cook, { short: true }) });
  return facts;
}

function difficultyFact(recipe: ReportRecipeInput, t: ReportFormatters['t']): ReportFact[] {
  if (!recipe.difficulty) return [];
  const key = difficultyKey[recipe.difficulty];
  return [{ label: t('recipeDetail.complexity'), value: key ? t(key) : recipe.difficulty }];
}

function buildSection(
  recipe: ReportRecipeInput,
  scaler: RecipeScaler,
  facts: ReportFact[],
  input: ReportInput,
  options: ReportOptions,
  printedComponents: Set<string>,
  t: ReportFormatters['t'],
): ReportSection {
  const tools = (recipe.tools || []).map(nameOf);
  const techniques = (recipe.techniques || []).map(nameOf);
  return {
    id: recipe.id,
    anchor: anchorFor(recipe.id),
    title: recipe.translated_title || recipe.title,
    description: nonEmpty(recipe.translated_description || recipe.description),
    facts,
    usedIn: [],
    ingredientGroups: buildIngredientGroups(recipe, scaler, printedComponents),
    tools,
    techniques,
    steps: buildSteps(recipe, scaler, input.techniques || [], options, t),
    storage: nonEmpty(recipe.storage_instructions),
    tips: nonEmpty(recipe.tips),
  };
}

function scalerFor(recipe: ReportRecipeInput, mainServings: number, options: ReportOptions, t: ReportFormatters['t']) {
  return createRecipeScaler({
    ingredients: recipe.ingredients || [],
    steps: recipe.steps || [],
    // Every section scales by the main recipe's ratio — the convention the
    // recipe page's sub-ingredient list and Kitchen mode both use, so the
    // component amounts printed here match the ones on screen.
    baseServings: mainServings,
    servings: options.servings,
    displaySystem: options.displaySystem,
    fallbackName: t('shopping.ingredientFallback'),
  });
}

function buildNutrition(
  nutrition: ReportNutritionInput | null | undefined,
  recipe: ReportRecipeInput,
  options: ReportOptions,
  t: ReportFormatters['t'],
): ReportNutrition | null {
  if (!options.includeNutrition || !nutrition) return null;
  const totals = nutrition.totals;
  if (!(totals.caloriesKcal > 0 || totals.proteinG > 0 || totals.carbsG > 0 || totals.fatG > 0)) return null;
  // Fetched once at the recipe's base servings, scaled here like the page
  // scales it against its slider.
  const ratio = recipe.servings ? options.servings / recipe.servings : 1;
  const at = (v: number) => Math.round(v * ratio);
  const fields: { key: keyof ReportNutritionTotals; label: string; unit: string }[] = [
    { key: 'caloriesKcal', label: t('recipeDetail.calories'), unit: 'kcal' },
    { key: 'proteinG', label: t('recipeDetail.protein'), unit: 'g' },
    { key: 'carbsG', label: t('recipeDetail.carbs'), unit: 'g' },
    { key: 'fatG', label: t('recipeDetail.fat'), unit: 'g' },
    { key: 'fiberG', label: t('recipeDetail.fiber'), unit: 'g' },
    { key: 'sugarG', label: t('recipeDetail.sugar'), unit: 'g' },
    { key: 'sodiumMg', label: t('recipeDetail.sodium'), unit: 'mg' },
  ];
  const unresolved = nutrition.unresolved || [];
  return {
    heading: t('recipeDetail.totalForServings', { count: options.servings }),
    rows: fields.map(f => ({ label: f.label, value: `${at(totals[f.key])} ${f.unit}` })),
    perServing: t('recipeDetail.kcalPerServing', {
      count: Math.round((totals.caloriesKcal * ratio) / Math.max(1, options.servings)),
    }),
    unresolved: unresolved.length ? t('recipeDetail.nutritionUnavailableFor', { items: unresolved.join(', ') }) : null,
  };
}

function buildReferences(recipe: ReportRecipeInput, t: ReportFormatters['t']): ReportReference[] {
  const refs: ReportReference[] = (recipe.sources || [])
    .filter(s => nonEmpty(s.label) || nonEmpty(s.url))
    .map(s => ({ type: s.type || 'other', label: nonEmpty(s.label) || s.url!, url: nonEmpty(s.url) }));
  // The import's single source_url, unless the sources list already
  // carries it — printing the same link twice says nothing new.
  const sourceUrl = nonEmpty(recipe.source_url);
  if (sourceUrl && !refs.some(r => r.url === sourceUrl)) {
    refs.unshift({ type: 'url', label: t('print.source'), url: sourceUrl });
  }
  return refs;
}

export function buildRecipeReport(input: ReportInput, options: ReportOptions, fmt: ReportFormatters): RecipeReportModel {
  const { recipe } = input;
  const { t } = fmt;
  const subRecipes = input.subRecipes ?? new Map<string, ReportRecipeInput>();

  const components = options.includeComponents ? componentOrder(recipe, subRecipes) : [];
  const printed = new Set(components.map(c => c.id));

  const mainScaler = scalerFor(recipe, recipe.servings, options, t);
  const scalers = new Map<string, RecipeScaler>([[recipe.id, mainScaler]]);
  for (const sub of components) scalers.set(sub.id, scalerFor(sub, recipe.servings, options, t));

  const yieldFact = (r: ReportRecipeInput, scaler: RecipeScaler): ReportFact[] =>
    r.yield_amount != null
      ? [{ label: t('recipeDetail.yield'), value: scaler.formatAmount(r.yield_amount, r.yield_unit_symbol || null) }]
      : [];

  const mainFacts: ReportFact[] = [
    { label: t('recipeDetail.servings'), value: String(options.servings) },
    ...yieldFact(recipe, mainScaler),
    ...timeFacts(recipe, t),
    ...difficultyFact(recipe, t),
  ];
  const main = buildSection(recipe, mainScaler, mainFacts, input, options, printed, t);

  const componentSections = components.map(sub => {
    const scaler = scalers.get(sub.id)!;
    const section = buildSection(
      sub, scaler, [...yieldFact(sub, scaler), ...timeFacts(sub, t), ...difficultyFact(sub, t)],
      input, options, printed, t,
    );
    // Every printed recipe that uses this one, with the amount it asks for
    // — the link between "300 g pastry cream" in a list and the recipe
    // that makes it.
    for (const parent of [recipe, ...components]) {
      const parentScaler = scalers.get(parent.id)!;
      for (const row of parent.ingredients || []) {
        if (row.subRecipeId !== sub.id) continue;
        const amount = parentScaler.formatAmount(row.quantity, row.unitSymbol, row.quantityText);
        const parentTitle = parent.translated_title || parent.title;
        section.usedIn.push(amount
          ? t('print.report.usedInAmount', { recipe: parentTitle, amount })
          : t('print.report.usedIn', { recipe: parentTitle }));
      }
    }
    return section;
  });

  const meta: string[] = [];
  if (nonEmpty(recipe.creator_name)) meta.push(t('print.report.byAuthor', { name: recipe.creator_name }));
  if (recipe.rating) {
    const stars = Math.max(0, Math.min(5, Math.round(recipe.rating)));
    meta.push('★'.repeat(stars) + '☆'.repeat(5 - stars));
  }
  if (recipe.times_cooked) meta.push(t('recipeDetail.cookedTimes', { count: recipe.times_cooked }));
  if (recipe.created_at) meta.push(t('recipeDetail.created', { date: fmt.formatDate(recipe.created_at) }));
  if (recipe.updated_at && recipe.updated_at !== recipe.created_at) {
    meta.push(t('recipeDetail.lastEdited', { date: fmt.formatDate(recipe.updated_at) }));
  }

  const tags = recipe.tags_display && recipe.tags_display.length > 0
    ? recipe.tags_display.map(tag => ({ name: tag.translated_name || tag.name, color: tag.color ?? null }))
    : (recipe.tags || []).map(name => ({ name, color: null }));

  return {
    title: main.title,
    description: main.description,
    coverImage: options.includeCover ? nonEmpty(recipe.cover_image_url) : null,
    facts: mainFacts,
    meta,
    tags: tags.filter(tag => nonEmpty(tag.name)),
    regions: (recipe.regions || []).filter(r => nonEmpty(r)).map(fmt.formatRegion),
    main,
    components: componentSections,
    nutrition: buildNutrition(input.nutrition, recipe, options, t),
    references: buildReferences(recipe, t),
  };
}

/** Every recipe id a report for `recipe` could print as a component —
 *  what the page has to fetch before it can build one. Walks whatever has
 *  been fetched so far; the page calls it again as sub-recipes arrive. */
export function missingComponentIds(root: ReportRecipeInput, fetched: Map<string, ReportRecipeInput>): string[] {
  const missing = new Set<string>();
  const seen = new Set<string>([root.id]);
  const walk = (recipe: ReportRecipeInput, depth: number) => {
    if (depth > MAX_COMPONENT_DEPTH) return;
    for (const row of recipe.ingredients || []) {
      const id = row.subRecipeId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const sub = fetched.get(id);
      if (sub) walk(sub, depth + 1);
      else missing.add(id);
    }
  };
  walk(root, 1);
  return [...missing];
}
