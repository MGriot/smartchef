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

import { callConfiguredProvider, repairTruncatedJson } from './llmParser.local';
import { languageLabel } from '../lib/languages';

function parseJsonObject(raw: string): any {
  const match = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*/);
  if (!match) throw new Error('The model did not return any JSON — try again, or switch provider.');
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
  /** Name per language code (includes 'en' = name). */
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
    `write it on a shopping list, first letter capitalized: ${langList}. The "en" entry equals "name".\n\n` +
    `Respond EXCLUSIVELY with JSON: {"items": [{"key": "...", "name": "...", "parent": "..." | null, "translations": {"en": "...", ...}}]}, ` +
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
