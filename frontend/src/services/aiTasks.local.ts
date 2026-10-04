// ════════════════════════════════════════════════════════════════════════
// SmartChef — Small AI tasks, standalone mode
//
// Everything the app asks the configured LLM for that isn't Smart Import:
//   - translating a recipe's content into another language (server mode's
//     POST /api/recipes/:id/translate/:lang, backend translateRecipeContent)
//   - naming ingredients the way the catalog is named: one English base
//     name, a "variety of" parent, and a name per library language.
//
// Uses the same provider plumbing as llmParser.local.ts, so whichever
// provider Account → AI Provider has selected answers these too.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';
import { callConfiguredProvider, repairTruncatedJson } from './llmParser.local';
import { languageLabel } from '../lib/languages';

function parseJsonObject(raw: string): any {
  const match = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*/);
  if (!match) throw new Error(i18n.t('errors.noJsonFromModel'));
  try {
    return JSON.parse(match[0]);
  } catch {
    return JSON.parse(repairTruncatedJson(match[0]));
  }
}

// ── Recipe translation ──────────────────────────────────────────────────

export interface RecipeTranslationStep {
  id: string;
  title: string | null;
  description: string;
  notes: string | null;
}
export interface RecipeTranslationInput {
  title: string;
  description: string | null;
  steps: RecipeTranslationStep[];
  ingredientNotes: Array<{ id: string; notes: string }>;
}
export type RecipeTranslationOutput = RecipeTranslationInput;

/** Same prompt and the same defensive normalization as the backend's
 *  translateRecipeContent(): ids are copied through, and anything the model
 *  drops or blanks falls back to the source rather than erasing content. */
export async function translateRecipeContent(input: RecipeTranslationInput, targetLang: string): Promise<RecipeTranslationOutput> {
  const targetLangName = languageLabel(targetLang, 'en');
  const systemPrompt =
    `You translate recipe content from a recipe-management app into ${targetLangName} (ISO code "${targetLang}"). ` +
    `You will receive a JSON object with a title, an optional description, a list of steps (each with an id, ` +
    `optional title, description, and optional notes — "notes" is a chef's tip for that step), and a list of ` +
    `ingredient notes (each with an id and short free-text note, e.g. "finely chopped"). ` +
    `Translate every text field naturally and idiomatically into ${targetLangName}, preserving culinary meaning ` +
    `and quantities/units exactly as written. The "id" fields are opaque identifiers — copy them through EXACTLY ` +
    `unchanged, never translate or alter them. If a field is null in the input, keep it null in the output. ` +
    `Respond EXCLUSIVELY with a JSON object matching the exact same shape as the input ` +
    `({title, description, steps: [{id, title, description, notes}], ingredientNotes: [{id, notes}]}), no extra text.`;

  const parsed = parseJsonObject(await callConfiguredProvider(JSON.stringify(input), systemPrompt));
  const stepById = new Map(input.steps.map((s) => [s.id, s]));
  const noteById = new Map(input.ingredientNotes.map((n) => [n.id, n]));

  return {
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : input.title,
    description: typeof parsed.description === 'string' ? parsed.description : null,
    steps: Array.isArray(parsed.steps)
      ? parsed.steps
          .filter((s: any) => s && typeof s.id === 'string' && stepById.has(s.id))
          .map((s: any) => ({
            id: s.id,
            title: typeof s.title === 'string' ? s.title : null,
            description: typeof s.description === 'string' && s.description.trim() ? s.description : stepById.get(s.id)!.description,
            notes: typeof s.notes === 'string' ? s.notes : null,
          }))
      : [],
    ingredientNotes: Array.isArray(parsed.ingredientNotes)
      ? parsed.ingredientNotes
          .filter((n: any) => n && typeof n.id === 'string' && typeof n.notes === 'string' && n.notes.trim() && noteById.has(n.id))
          .map((n: any) => ({ id: n.id, notes: n.notes }))
      : [],
  };
}

// ── Ingredient naming ───────────────────────────────────────────────────
//
// The catalog convention, which both Smart Import and the Library's
// "Tidy names" pass follow:
//   - the base name is English, Title Case, with no quantity, brand-free
//     unless the product IS the brand (Aperol), and no preparation/usage
//     words ("finely chopped", "to top up", "for garnish") — those are a
//     recipe row's notes, not a catalog entry;
//   - ingredients form a chain from general to specific to variation,
//     recorded through parent_ingredient_id:  Apple → Renetta Apple →
//     Renetta Apple Slices. Each link names its parent;
//   - every library language gets its own name.

export interface IngredientNamingItem {
  /** Opaque — echoed back so the caller can line answers up with rows. */
  key: string;
  /** The name as written today: a recipe's wording, or a catalog row's. */
  text: string;
  /** Names already on file per language, as context for the model. */
  known?: Record<string, string>;
}

export interface IngredientNamingResult {
  key: string;
  /** Canonical English catalog name. */
  name: string;
  /** The next-more-general ingredient's catalog name, or null. */
  parent: string | null;
  /** Name per requested language code; 'en' only when asked for, and then
   *  always `name` itself. */
  translations: Record<string, string>;
}

export function buildIngredientNamingPrompt(catalogNames: string[], langs: string[], keepName: boolean): string {
  const langList = langs.map((l) => `"${l}" (${languageLabel(l, 'en')})`).join(', ');
  const catalog = catalogNames.length
    ? `\n\nIngredients ALREADY in the user's catalog (English base names):\n${catalogNames.join(', ')}`
    : '';
  return (
    `You maintain the ingredient catalog of a recipe app. For each input item, return how it should be named in the catalog.\n\n` +
    `Naming rules for "name":\n` +
    `- English, Title Case, singular unless the ingredient is normally named in the plural (e.g. "Chickpeas", "Pine Nuts").\n` +
    `- No quantities, no brands (unless the product itself is a brand, e.g. "Aperol"), and no preparation or usage words ` +
    `such as "chopped", "at room temperature", "to top up", "for garnish" — those belong in the recipe, not the catalog. ` +
    `"soda to top up" is "Soda Water"; "ice" is "Ice"; "burro morbido" is "Butter".\n` +
    `- Ingredients form a chain from GENERAL to SPECIFIC to VARIATION: "Apple" → "Renetta Apple" → "Renetta Apple Slices". ` +
    `A specific is a variety, cultivar or type of the general one ("Renetta Apple", "Red Onion", "Arborio Rice"); a variation ` +
    `is a part or derived form of an ingredient ("Lemon Zest", "Lemon Juice", "Egg Yolk"). Name the specific with its ` +
    `qualifier first, as English reads: "Renetta Apple", never "Apple Renetta" or "Apple (Renetta)".\n` +
    `- If a name already in the catalog means the same ingredient, reuse it EXACTLY.\n` +
    (keepName ? `- The input text is already the English base name the user chose: return it unchanged as "name".\n` : '') +
    `\n"parent" is the name of the next-more-general ingredient in that chain ("Renetta Apple" → "Apple", ` +
    `"Lemon Zest" → "Lemon", "Apple" → null). Use it ONLY when it is a name from the catalog below or the "name" of another ` +
    `input item, copied exactly; otherwise null. Never make an ingredient its own parent.\n\n` +
    `"translations" maps each of these language codes to the ingredient's natural name in that language, as a cook would ` +
    `write it on a shopping list, first letter capitalized: ${langList}.${langs.includes('en') ? ' The "en" entry equals "name".' : ''}\n\n` +
    `Respond EXCLUSIVELY with JSON: {"items": [{"key": "...", "name": "...", "parent": "..." | null, "translations": {"${langs[0] ?? 'it'}": "...", ...}}]}, ` +
    `one entry per input item, keys copied exactly.` +
    catalog
  );
}

/** Pulls a usable answer out of the model's JSON. Anything malformed is
 *  dropped per item rather than failing the batch. */
export function normalizeIngredientNaming(
  parsed: any,
  items: IngredientNamingItem[],
  langs: string[],
  keepName: boolean
): IngredientNamingResult[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out: IngredientNamingResult[] = [];
  const rows: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !byKey.has(row.key)) continue;
    const source = byKey.get(row.key)!;
    const name = keepName
      ? source.text.trim()
      : typeof row.name === 'string' && row.name.trim() ? row.name.trim() : source.text.trim();
    const parent = typeof row.parent === 'string' && row.parent.trim() && row.parent.trim().toLowerCase() !== name.toLowerCase()
      ? row.parent.trim()
      : null;
    const translations: Record<string, string> = {};
    const raw = row.translations && typeof row.translations === 'object' ? row.translations : {};
    for (const lang of langs) {
      const v = raw[lang];
      if (typeof v === 'string' && v.trim()) translations[lang] = v.trim();
    }
    if (langs.includes('en')) translations.en = name;
    out.push({ key: row.key, name, parent, translations });
    byKey.delete(row.key);
  }
  return out;
}

const NAMING_BATCH = 40;

/** Names a list of ingredients in batches. `keepName` is for when the
 *  English name is the user's decision already and only the parent and
 *  translations are wanted. */
export async function nameIngredients(
  items: IngredientNamingItem[],
  opts: { catalogNames: string[]; langs: string[]; keepName?: boolean }
): Promise<IngredientNamingResult[]> {
  const keepName = opts.keepName === true;
  const systemPrompt = buildIngredientNamingPrompt(opts.catalogNames, opts.langs, keepName);
  const results: IngredientNamingResult[] = [];
  for (let i = 0; i < items.length; i += NAMING_BATCH) {
    const batch = items.slice(i, i + NAMING_BATCH);
    const payload = batch.map((b) => (b.known && Object.keys(b.known).length ? { key: b.key, text: b.text, known: b.known } : { key: b.key, text: b.text }));
    const raw = await callConfiguredProvider(JSON.stringify({ items: payload }), systemPrompt);
    results.push(...normalizeIngredientNaming(parseJsonObject(raw), batch, opts.langs, keepName));
  }
  return results;
}

// ── Ingredient tidy (the Library's "Tidy with AI") ──────────────────────
//
// Naming above, plus everything else a catalog row can be wrong or missing
// about: its aisle (category), its tags, its nutrition per 100 g, and the
// other names it goes by. The model is shown what the row says today and
// asked to correct it as well as fill gaps — a translation that names a
// different ingredient ("Farina" filed as the Italian for Sugar) used to
// pass untouched, because the naming pass only ever filled languages that
// were missing.
//
// It only ever chooses categories and tags from the lists it is given:
// inventing an aisle the user never made would be worse than leaving one
// unset. What comes back is a suggestion; lib/ingredientTidy.ts turns it
// into the reviewable changes and nothing is written until the user
// applies them.

export interface TidyAspects {
  /** English base name, "variety of" parent, a name per language — and
   *  corrections of names on file that are wrong. */
  naming: boolean;
  /** Category and tags, from the user's own lists. */
  classification: boolean;
  /** kcal, protein, carbs, fat, fiber, sugar, sodium per 100 g. */
  nutrition: boolean;
  /** Alternative names, for search and import matching. */
  synonyms: boolean;
}

export interface NutritionPer100g {
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
}

export interface IngredientTidyItem {
  key: string;
  /** Today's base name. */
  text: string;
  /** Today's name per language. */
  known?: Record<string, string>;
  category?: string | null;
  tags?: string[];
  nutrition?: Partial<NutritionPer100g>;
  synonyms?: string[];
}

export interface IngredientTidyResult {
  key: string;
  name?: string;
  parent?: string | null;
  translations?: Record<string, string>;
  /** Languages whose name on file the model judged wrong. */
  wrongTranslations?: string[];
  /** A name from the category list, or null when none fits. */
  category?: string | null;
  /** Names from the tag list that apply. */
  tags?: string[];
  /** Tags on file, from the tag list, that do not apply. */
  wrongTags?: string[];
  nutrition?: NutritionPer100g;
  synonyms?: string[];
}

export interface TidyPromptContext {
  aspects: TidyAspects;
  langs: string[];
  catalogNames: string[];
  categoryNames: string[];
  tagNames: string[];
}

export function buildIngredientTidyPrompt(ctx: TidyPromptContext): string {
  const { aspects } = ctx;
  const langList = ctx.langs.map((l) => `"${l}" (${languageLabel(l, 'en')})`).join(', ');
  const sections: string[] = [
    `You maintain the ingredient catalog of a recipe app. Each input item is one catalog row as it is today: ` +
    `"text" is its base name${aspects.naming ? ', "known" its name per language' : ''}` +
    `${aspects.classification ? ', "category" and "tags" what it is filed under' : ''}` +
    `${aspects.nutrition ? ', "nutrition" its values per 100 g (null = not on file)' : ''}` +
    `${aspects.synonyms ? ', "synonyms" its other names' : ''}. ` +
    `Values on file can be WRONG as well as missing: correct them, do not just copy them back.`,
  ];

  if (aspects.naming) {
    sections.push(
      `"name": the catalog base name — English, Title Case, singular unless normally plural ("Chickpeas"), no quantities, ` +
      `brands only when the product is the brand ("Aperol"), no preparation words ("chopped", "for garnish"). If "text" is ` +
      `not English or not well formed, give the correct English name. Name a variety with its qualifier first ("Renetta ` +
      `Apple", never "Apple Renetta"). If a catalog name below means the same ingredient, reuse it EXACTLY.\n` +
      `"parent": the next-more-general ingredient ("Renetta Apple" → "Apple", "Lemon Zest" → "Lemon"), ONLY as a name from ` +
      `the catalog below or another input item's "name", copied exactly; otherwise null. Never the item itself.\n` +
      `"translations": the ingredient's natural name in each of ${langList}, as a cook writes it on a shopping list, first ` +
      `letter capitalized.\n` +
      `"wrongTranslations": the language codes whose "known" name is WRONG — it names a different ingredient, is in the ` +
      `wrong language, or is a mistranslation. A merely different but correct wording is NOT wrong. Empty array if none.`,
    );
  }
  if (aspects.classification) {
    sections.push(
      `"category": the aisle this ingredient belongs in, copied EXACTLY from this list, or null if none fits: ` +
      `${ctx.categoryNames.length ? ctx.categoryNames.map((c) => `"${c}"`).join(', ') : '(no categories)'}.\n` +
      `"tags": every tag from this list that applies to the ingredient (diet, allergens, kind of food…), copied EXACTLY; ` +
      `never invent a tag: ${ctx.tagNames.length ? ctx.tagNames.map((c) => `"${c}"`).join(', ') : '(no tags)'}.\n` +
      `"wrongTags": tags the item has today that do NOT apply (e.g. "Vegan" on butter). Empty array if none.`,
    );
  }
  if (aspects.nutrition) {
    sections.push(
      `"nutrition": typical values per 100 g of the raw/as-sold ingredient, as in a standard food composition table: ` +
      `{"kcal": number, "protein": grams, "carbs": grams, "fat": grams, "fiber": grams, "sugar": grams, "sodium": milligrams}. ` +
      `Correct values on file that are clearly wrong. Use null for a value you cannot estimate reasonably (e.g. a spice ` +
      `blend whose composition varies).`,
    );
  }
  if (aspects.synonyms) {
    sections.push(
      `"synonyms": other names people use for this same ingredient, in any of the languages above or English ` +
      `(regional names, common alternative spellings — "Courgette" for "Zucchini", "Garbanzo Beans" for "Chickpeas"). ` +
      `Not varieties, not brands, not the name itself. At most 6. Empty array if none.`,
    );
  }

  const shape = [
    '"key": "..."',
    ...(aspects.naming ? ['"name": "..."', '"parent": "..." | null', '"translations": {...}', '"wrongTranslations": [...]'] : []),
    ...(aspects.classification ? ['"category": "..." | null', '"tags": [...]', '"wrongTags": [...]'] : []),
    ...(aspects.nutrition ? ['"nutrition": {...}'] : []),
    ...(aspects.synonyms ? ['"synonyms": [...]'] : []),
  ].join(', ');
  sections.push(`Respond EXCLUSIVELY with JSON: {"items": [{${shape}}]}, one entry per input item, keys copied exactly.`);

  if (aspects.naming && ctx.catalogNames.length) {
    sections.push(`Ingredients ALREADY in the user's catalog (English base names):\n${ctx.catalogNames.join(', ')}`);
  }
  return sections.join('\n\n');
}

/** Per-100 g plausibility: anything outside these is a model error, not a
 *  food — pure fat is ~900 kcal, nothing has more than 100 g of a macro in
 *  100 g, and table salt is ~39 g of sodium. */
const NUTRITION_LIMITS: Record<keyof NutritionPer100g, number> = {
  caloriesKcal: 900, proteinG: 100, carbsG: 100, fatG: 100, fiberG: 100, sugarG: 100, sodiumMg: 40000,
};
const NUTRITION_KEYS: Array<[keyof NutritionPer100g, string]> = [
  ['caloriesKcal', 'kcal'], ['proteinG', 'protein'], ['carbsG', 'carbs'], ['fatG', 'fat'],
  ['fiberG', 'fiber'], ['sugarG', 'sugar'], ['sodiumMg', 'sodium'],
];

function cleanNutrition(raw: unknown): NutritionPer100g | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const out = {} as NutritionPer100g;
  let any = false;
  for (const [key, alias] of NUTRITION_KEYS) {
    const value = source[alias] ?? source[key];
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0 && n <= NUTRITION_LIMITS[key]) {
      out[key] = Math.round(n * 10) / 10;
      any = true;
    } else {
      out[key] = null;
    }
  }
  return any ? out : undefined;
}

const stringList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];

/** Keeps only names that are really in `allowed` (case-insensitive),
 *  returned in the list's own spelling. */
function pickFrom(allowed: string[], names: string[]): string[] {
  const byLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const out: string[] = [];
  for (const name of names) {
    const hit = byLower.get(name.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Pulls a usable answer out of the model's JSON, field by field: anything
 *  malformed or outside the given lists is dropped rather than failing the
 *  batch, and an aspect that was not asked for is never returned. */
export function normalizeIngredientTidy(parsed: any, items: IngredientTidyItem[], ctx: TidyPromptContext): IngredientTidyResult[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const rows: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: IngredientTidyResult[] = [];
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !byKey.has(row.key)) continue;
    const source = byKey.get(row.key)!;
    const result: IngredientTidyResult = { key: row.key };

    if (ctx.aspects.naming) {
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : source.text.trim();
      result.name = name;
      result.parent = typeof row.parent === 'string' && row.parent.trim() && row.parent.trim().toLowerCase() !== name.toLowerCase()
        ? row.parent.trim()
        : null;
      const translations: Record<string, string> = {};
      const raw = row.translations && typeof row.translations === 'object' ? row.translations : {};
      for (const lang of ctx.langs) {
        const v = raw[lang];
        if (typeof v === 'string' && v.trim()) translations[lang] = v.trim();
      }
      result.translations = translations;
      result.wrongTranslations = stringList(row.wrongTranslations)
        .map((l) => l.toLowerCase())
        .filter((l) => ctx.langs.includes(l) && !!translations[l]);
    }

    if (ctx.aspects.classification) {
      const category = typeof row.category === 'string' ? pickFrom(ctx.categoryNames, [row.category])[0] : undefined;
      result.category = category ?? null;
      result.tags = pickFrom(ctx.tagNames, stringList(row.tags));
      // Only tags the row actually has can be wrong on it.
      result.wrongTags = pickFrom(source.tags ?? [], stringList(row.wrongTags))
        .filter((t) => !result.tags!.some((k) => k.toLowerCase() === t.toLowerCase()));
    }

    if (ctx.aspects.nutrition) {
      const nutrition = cleanNutrition(row.nutrition);
      if (nutrition) result.nutrition = nutrition;
    }

    if (ctx.aspects.synonyms) {
      const base = (result.name ?? source.text).toLowerCase();
      result.synonyms = [...new Set(stringList(row.synonyms))]
        .filter((s) => s.toLowerCase() !== base)
        .slice(0, 6);
    }

    out.push(result);
    byKey.delete(row.key);
  }
  return out;
}

/** Tidies a list of catalog rows in batches — fewer per batch the more is
 *  asked of each, so an answer stays well inside the model's output limit. */
export async function tidyIngredients(items: IngredientTidyItem[], ctx: TidyPromptContext): Promise<IngredientTidyResult[]> {
  const systemPrompt = buildIngredientTidyPrompt(ctx);
  const asked = Object.values(ctx.aspects).filter(Boolean).length;
  const batchSize = asked <= 1 ? 30 : 15;
  const results: IngredientTidyResult[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // Only what each asked-for aspect needs to see goes into the request.
    const payload = batch.map((b) => ({
      key: b.key,
      text: b.text,
      ...(ctx.aspects.naming && b.known && Object.keys(b.known).length ? { known: b.known } : {}),
      ...(ctx.aspects.classification ? { category: b.category ?? null, tags: b.tags ?? [] } : {}),
      ...(ctx.aspects.nutrition ? { nutrition: b.nutrition ?? {} } : {}),
      ...(ctx.aspects.synonyms ? { synonyms: b.synonyms ?? [] } : {}),
    }));
    const raw = await callConfiguredProvider(JSON.stringify({ items: payload }), systemPrompt);
    results.push(...normalizeIngredientTidy(parseJsonObject(raw), batch, ctx));
  }
  return results;
}
