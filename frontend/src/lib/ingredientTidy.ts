// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Tidy with AI" for the existing ingredient catalog
//
// Turns the AI's answers (POST /api/ingredients/ai-tidy, or the older
// naming-only /ai-name) into the list of changes the Library shows for
// review: rename to the catalog convention, link a "variety of" parent,
// fill missing languages and correct wrong ones, move to the right
// category, add and remove tags, fill or correct nutrition, add synonyms.
// Pure so it can be tested — the suite has no jsdom (see
// lib/importMatching.ts).
//
// Every change is its own kind with its own checkbox, so a user can take
// the category and leave the nutrition. Conservative where it matters:
//   - an existing parent is never replaced;
//   - a rename that would collide with another ingredient's name is not
//     applied — two rows with one name are a merge, which the Library's own
//     Merge action does properly;
//   - an existing translation is only replaced when the model said it is
//     WRONG, not merely worded differently;
//   - an existing nutrition value is only replaced when the suggestion is
//     far enough off to be a different food, not a rounding difference;
//   - removing a tag is proposed but never pre-selected.
// ════════════════════════════════════════════════════════════════════════

export type NutrientKey = 'caloriesKcal' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sugarG' | 'sodiumMg';
export const NUTRIENT_KEYS: NutrientKey[] = ['caloriesKcal', 'proteinG', 'carbsG', 'fatG', 'fiberG', 'sugarG', 'sodiumMg'];

/** The row columns each nutrient lives in on GET /api/ingredients. */
const NUTRIENT_COLUMN: Record<NutrientKey, keyof TidyIngredient> = {
  caloriesKcal: 'calories_kcal', proteinG: 'protein_g', carbsG: 'carbs_g', fatG: 'fat_g',
  fiberG: 'fiber_g', sugarG: 'sugar_g', sodiumMg: 'sodium_mg',
};

export interface TidyIngredient {
  id: string;
  name: string;
  parent_ingredient_id?: string | null;
  translations?: Array<{ lang: string; text: string }>;
  category_id?: string | null;
  tags?: Array<{ id: string; name?: string }>;
  calories_kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  sugar_g?: number | null;
  sodium_mg?: number | null;
  synonyms?: string[];
}

export interface TidySuggestion {
  key: string;
  /** Absent when naming was not asked for. */
  name?: string;
  parent?: string | null;
  parentId?: string | null;
  translations?: Array<{ lang: string; text: string }>;
  wrongTranslations?: string[];
  categoryId?: string | null;
  tagIds?: string[];
  wrongTagIds?: string[];
  nutrition?: Partial<Record<NutrientKey, number | null>>;
  synonyms?: string[];
}

export interface TidyProposal {
  id: string;
  oldName: string;
  /** Set when the name changes. */
  newName?: string;
  /** Set when a rename was proposed but another ingredient already has
   *  that name — not applied; merge instead. */
  duplicateOf?: { id: string; name: string };
  parentId?: string;
  parentName?: string;
  /** Languages with no name on file yet. */
  addTranslations: Array<{ lang: string; text: string }>;
  /** Names on file the AI judged wrong, with its replacement. */
  fixTranslations: Array<{ lang: string; from: string; to: string }>;
  category?: { id: string; fromId: string | null };
  addTagIds: string[];
  removeTagIds: string[];
  /** from = null is a fill, a number is a correction. */
  nutrition: Array<{ key: NutrientKey; from: number | null; to: number }>;
  addSynonyms: string[];
}

export type TidyChangeKind =
  | 'name' | 'parent' | 'addTranslations' | 'fixTranslations'
  | 'category' | 'addTags' | 'removeTags' | 'nutrition' | 'synonyms';

/** How far a suggested value has to be from the one on file before it is a
 *  correction rather than a rounding difference: 25 % of the larger value,
 *  and at least a floor per nutrient so near-zero values do not flap. */
const NUTRIENT_FLOOR: Record<NutrientKey, number> = {
  caloriesKcal: 30, proteinG: 3, carbsG: 3, fatG: 3, fiberG: 2, sugarG: 3, sodiumMg: 50,
};

export function isNutritionCorrection(key: NutrientKey, from: number, to: number): boolean {
  return Math.abs(from - to) > Math.max(NUTRIENT_FLOOR[key], 0.25 * Math.max(Math.abs(from), Math.abs(to)));
}

export function buildTidyProposals(ingredients: TidyIngredient[], suggestions: TidySuggestion[]): TidyProposal[] {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const idByName = new Map<string, string>();
  for (const i of ingredients) if (!idByName.has(i.name.trim().toLowerCase())) idByName.set(i.name.trim().toLowerCase(), i.id);

  // A parent may be named by the name another row is ABOUT to get ("Apple"
  // for a row still called "apple"), so proposed names resolve too.
  const idByProposedName = new Map<string, string>();
  for (const s of suggestions) if (byId.has(s.key) && s.name) idByProposedName.set(s.name.trim().toLowerCase(), s.key);

  const out: TidyProposal[] = [];
  for (const s of suggestions) {
    const ing = byId.get(s.key);
    if (!ing) continue;
    const proposal: TidyProposal = {
      id: ing.id, oldName: ing.name,
      addTranslations: [], fixTranslations: [], addTagIds: [], removeTagIds: [], nutrition: [], addSynonyms: [],
    };

    const newName = (s.name ?? '').trim();
    if (newName && newName !== ing.name.trim()) {
      const clash = idByName.get(newName.toLowerCase());
      if (clash && clash !== ing.id) proposal.duplicateOf = { id: clash, name: byId.get(clash)!.name };
      else proposal.newName = newName;
    }

    if (!ing.parent_ingredient_id && s.parent) {
      const parentId = s.parentId ?? idByName.get(s.parent.toLowerCase()) ?? idByProposedName.get(s.parent.toLowerCase());
      if (parentId && parentId !== ing.id) {
        proposal.parentId = parentId;
        proposal.parentName = s.parent;
      }
    }

    // Translations that go with a rename we are NOT applying would name a
    // different thing than the row keeps, so a clash adds none.
    if (!proposal.duplicateOf && s.translations) {
      const current = new Map((ing.translations ?? []).filter((t) => t.text?.trim()).map((t) => [t.lang.toLowerCase(), t.text.trim()]));
      const wrong = new Set((s.wrongTranslations ?? []).map((l) => l.toLowerCase()));
      for (const t of s.translations) {
        const lang = t.lang.toLowerCase();
        const text = t.text?.trim();
        if (!text) continue;
        const have = current.get(lang);
        if (have === undefined) proposal.addTranslations.push({ lang, text });
        else if (wrong.has(lang) && have.toLowerCase() !== text.toLowerCase()) proposal.fixTranslations.push({ lang, from: have, to: text });
      }
    }

    if (s.categoryId && s.categoryId !== (ing.category_id ?? null)) {
      proposal.category = { id: s.categoryId, fromId: ing.category_id ?? null };
    }

    if (s.tagIds || s.wrongTagIds) {
      const current = new Set((ing.tags ?? []).map((t) => t.id));
      const suggested = new Set(s.tagIds ?? []);
      proposal.addTagIds = [...suggested].filter((id) => !current.has(id));
      proposal.removeTagIds = (s.wrongTagIds ?? []).filter((id) => current.has(id) && !suggested.has(id));
    }

    if (s.nutrition) {
      for (const key of NUTRIENT_KEYS) {
        const to = s.nutrition[key];
        if (typeof to !== 'number' || !Number.isFinite(to)) continue;
        const raw = ing[NUTRIENT_COLUMN[key]];
        const from = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        if (from === null) proposal.nutrition.push({ key, from: null, to });
        else if (isNutritionCorrection(key, from, to)) proposal.nutrition.push({ key, from, to });
      }
    }

    if (s.synonyms) {
      const taken = new Set([
        ing.name.toLowerCase(), newName.toLowerCase(),
        ...(ing.synonyms ?? []).map((x) => x.toLowerCase()),
      ]);
      for (const syn of s.synonyms) {
        const clean = syn.trim();
        if (clean && !taken.has(clean.toLowerCase())) {
          proposal.addSynonyms.push(clean);
          taken.add(clean.toLowerCase());
        }
      }
    }

    if (proposalKinds(proposal).length > 0 || proposal.duplicateOf) out.push(proposal);
  }
  return out;
}

/** The kinds of change a proposal carries, in display order. */
export function proposalKinds(p: TidyProposal): TidyChangeKind[] {
  const kinds: TidyChangeKind[] = [];
  if (p.newName) kinds.push('name');
  if (p.parentId) kinds.push('parent');
  if (p.addTranslations.length) kinds.push('addTranslations');
  if (p.fixTranslations.length) kinds.push('fixTranslations');
  if (p.category) kinds.push('category');
  if (p.addTagIds.length) kinds.push('addTags');
  if (p.removeTagIds.length) kinds.push('removeTags');
  if (p.nutrition.length) kinds.push('nutrition');
  if (p.addSynonyms.length) kinds.push('synonyms');
  return kinds;
}

export const selectionKey = (id: string, kind: TidyChangeKind) => `${id}:${kind}`;

/** What is ticked when the review opens: everything except removing tags,
 *  which is the one change that throws information away. */
export function defaultSelection(proposals: TidyProposal[]): Set<string> {
  const selected = new Set<string>();
  for (const p of proposals) {
    for (const kind of proposalKinds(p)) {
      if (kind !== 'removeTags') selected.add(selectionKey(p.id, kind));
    }
  }
  return selected;
}

/** The body of POST /api/ingredients/:id/naming for the ticked changes of
 *  one proposal, or null when none of them is ticked. */
export function changeFor(p: TidyProposal, selected: Set<string>): Record<string, unknown> | null {
  const on = (kind: TidyChangeKind) => selected.has(selectionKey(p.id, kind));
  const body: Record<string, unknown> = {};
  if (p.newName && on('name')) body.name = p.newName;
  if (p.parentId && on('parent')) body.parentIngredientId = p.parentId;
  const translations = [
    ...(on('addTranslations') ? p.addTranslations : []),
    ...(on('fixTranslations') ? p.fixTranslations.map((f) => ({ lang: f.lang, text: f.to })) : []),
  ];
  if (translations.length) body.translations = translations;
  if (p.category && on('category')) body.categoryId = p.category.id;
  if (p.addTagIds.length && on('addTags')) body.addTagIds = p.addTagIds;
  if (p.removeTagIds.length && on('removeTags')) body.removeTagIds = p.removeTagIds;
  if (p.nutrition.length && on('nutrition')) body.nutrition = Object.fromEntries(p.nutrition.map((n) => [n.key, n.to]));
  if (p.addSynonyms.length && on('synonyms')) body.addSynonyms = p.addSynonyms;
  return Object.keys(body).length ? body : null;
}
