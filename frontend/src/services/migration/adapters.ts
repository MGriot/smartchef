// ════════════════════════════════════════════════════════════════════════
// SmartChef — Reading other apps' exports
//
// Anyone arriving with years of recipes in Paprika or CopyMeThat had no
// route in: SmartChef read only its own bundle format. That makes the
// product hard to adopt however good the recipe model is.
//
// Every adapter here is the same shape — bytes in, TemplateParseResult[]
// out — so they all land in the Import screen's existing review step and
// go through the same fuzzy ingredient/tool matching as an AI or
// structured-data import. That matters: a foreign export names ingredients
// in free text, and writing them straight into the library would mint a
// duplicate "Tomato" beside the one already there. Nothing is created
// without the user seeing the matches first.
//
// Adapters never throw on a single bad recipe. A 200-recipe export with
// three unreadable entries should import 197 and say so, not fail whole.
// ════════════════════════════════════════════════════════════════════════

import type { TemplateParseResult } from '../recipeTemplateParser';
import { extractRecipeFromHtml, parseIngredientLine, isoDurationToMinutes, parseYield } from '../recipeStructuredData';
import { readZip, gunzip, looksGzipped, looksZipped } from '../../lib/zipReader';

export type MigrationSource =
  | 'paprika'
  | 'mealie'
  | 'recipesage'
  | 'nextcloud'
  | 'crouton'
  | 'mela'
  | 'copymethat'
  | 'schema-org';

export interface MigrationResult {
  source: MigrationSource;
  recipes: TemplateParseResult[];
  /** Entries that could not be read, by name — surfaced rather than hidden. */
  skipped: string[];
}

const decoder = new TextDecoder('utf-8');
const text = (bytes: Uint8Array) => decoder.decode(bytes);

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.match(/\d+(?:[.,]\d+)?/);
    if (m) return parseFloat(m[0].replace(',', '.'));
  }
  return undefined;
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => lines(v));
  }
  const s = str(value);
  if (!s) return [];
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function tagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : str((v as Record<string, unknown>)?.name)))
      .filter((v): v is string => !!v);
  }
  const s = str(value);
  return s ? s.split(',').map((t) => t.trim()).filter(Boolean) : [];
}

/** Section headers inside an ingredient block ("For the sauce:") are not
 *  ingredients — they carry the group the following lines belong to, which
 *  is exactly what TemplateParseIngredient.groupName is for. */
function isGroupHeading(line: string): boolean {
  return /:$/.test(line.trim()) && !/\d/.test(line);
}

function parseIngredientBlock(raw: unknown): TemplateParseResult['ingredients'] {
  const out: TemplateParseResult['ingredients'] = [];
  let group: string | null = null;
  for (const line of lines(raw)) {
    if (isGroupHeading(line)) {
      group = line.replace(/:$/, '').trim() || null;
      continue;
    }
    const parsed = parseIngredientLine(line.replace(/^[-•*]\s*/, ''));
    if (parsed) out.push({ ...parsed, groupName: group });
  }
  return out;
}

function parseStepBlock(raw: unknown): TemplateParseResult['steps'] {
  return lines(raw)
    .map((line) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .map((description, i) => ({ stepNumber: i + 1, description }));
}

function emptyResult(title: string): TemplateParseResult {
  return {
    title, tags: [], tools: [], ingredients: [], steps: [], warnings: [],
    storageInstructions: null, tips: null,
  };
}

// ── Paprika ─────────────────────────────────────────────────────────────
// A .paprikarecipes file is a zip whose entries are each an individually
// GZIPPED JSON document — not plain JSON, which is the detail that makes
// naive readers fail on it.

function paprikaToRecipe(obj: Record<string, unknown>): TemplateParseResult | null {
  const title = str(obj.name);
  if (!title) return null;
  const result = emptyResult(title);
  result.description = str(obj.description);
  result.servings = num(obj.servings);
  result.prepTimeMin = num(obj.prep_time);
  result.cookTimeMin = num(obj.cook_time);
  result.difficulty = str(obj.difficulty);
  result.tags = tagList(obj.categories);
  result.ingredients = parseIngredientBlock(obj.ingredients);
  result.steps = parseStepBlock(obj.directions);
  result.tips = str(obj.notes) ?? null;
  result.sourceUrl = str(obj.source_url);
  return result;
}

async function readPaprika(bytes: Uint8Array): Promise<MigrationResult> {
  const skipped: string[] = [];
  const recipes: TemplateParseResult[] = [];

  const process = (name: string, json: string) => {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const recipe = paprikaToRecipe(parsed);
      if (recipe) recipes.push(recipe);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  };

  if (looksZipped(bytes)) {
    for (const entry of await readZip(bytes)) {
      try {
        const inner = looksGzipped(entry.bytes) ? await gunzip(entry.bytes) : entry.bytes;
        process(entry.name, text(inner));
      } catch {
        skipped.push(entry.name);
      }
    }
  } else {
    // A single .paprikarecipe, which is just the gzipped JSON on its own.
    const inner = looksGzipped(bytes) ? await gunzip(bytes) : bytes;
    process('recipe', text(inner));
  }

  return { source: 'paprika', recipes, skipped };
}

// ── Mealie ──────────────────────────────────────────────────────────────

function mealieToRecipe(obj: Record<string, unknown>): TemplateParseResult | null {
  const title = str(obj.name);
  if (!title) return null;
  const result = emptyResult(title);
  result.description = str(obj.description);
  result.servings = parseYield(obj.recipeYield ?? obj.recipeServings);
  result.prepTimeMin = isoDurationToMinutes(obj.prepTime) ?? num(obj.prepTime);
  result.cookTimeMin = isoDurationToMinutes(obj.cookTime ?? obj.performTime) ?? num(obj.cookTime);
  result.tags = [...tagList(obj.tags), ...tagList(obj.recipeCategory)];
  result.sourceUrl = str(obj.orgURL) ?? str(obj.org_url);

  // Mealie stores ingredients structured when it can, and as a raw display
  // line when it cannot; prefer the structure and fall back to parsing.
  const rawIngredients = obj.recipeIngredient;
  if (Array.isArray(rawIngredients)) {
    result.ingredients = rawIngredients
      .map((entry): TemplateParseResult['ingredients'][number] | null => {
        if (typeof entry === 'string') return parseIngredientLine(entry);
        const e = (entry ?? {}) as Record<string, unknown>;
        const food = e.food as Record<string, unknown> | undefined;
        const unit = e.unit as Record<string, unknown> | undefined;

        // Structured entry: the food's name is the ingredient, and quantity
        // and unit are already separated.
        const foodName = str(food?.name);
        if (foodName) {
          return {
            name: foodName,
            quantity: num(e.quantity),
            unit: str(unit?.abbreviation) ?? str(unit?.name),
            notes: str(e.note),
          };
        }

        // Unstructured entry: `display` is a whole line ("3 tbsp olive oil"),
        // not a name — parsing it is the point, and taking it as the name
        // verbatim produced ingredients literally called "3 tbsp olive oil".
        const line = str(e.display) ?? str(e.note) ?? str(e.title);
        return line ? parseIngredientLine(line) : null;
      })
      .filter((i): i is TemplateParseResult['ingredients'][number] => i !== null);
  }

  const rawSteps = obj.recipeInstructions;
  if (Array.isArray(rawSteps)) {
    result.steps = rawSteps
      .map((entry, i) => {
        const description = typeof entry === 'string'
          ? entry
          : str((entry as Record<string, unknown>)?.text) ?? '';
        const title = typeof entry === 'object' && entry
          ? str((entry as Record<string, unknown>).title)
          : undefined;
        return description.trim() ? { stepNumber: i + 1, description: description.trim(), title } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s, i) => ({ ...s, stepNumber: i + 1 }));
  }

  const notes = obj.notes;
  if (Array.isArray(notes) && notes.length) {
    result.tips = notes.map((n) => str((n as Record<string, unknown>)?.text) ?? str(n)).filter(Boolean).join('\n');
  }

  return result;
}

// ── Crouton ─────────────────────────────────────────────────────────────

function croutonToRecipe(obj: Record<string, unknown>): TemplateParseResult | null {
  const title = str(obj.name);
  if (!title) return null;
  const result = emptyResult(title);
  result.servings = num(obj.serves);
  result.tags = tagList(obj.tags);
  result.sourceUrl = str(obj.webLink);
  result.description = str(obj.neutritionalInfo) ?? str(obj.notes);

  const ingredients = obj.ingredients;
  if (Array.isArray(ingredients)) {
    result.ingredients = ingredients
      .map((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const ing = (e.ingredient ?? {}) as Record<string, unknown>;
        const name = str(ing.name) ?? str(e.name);
        if (!name) return null;
        const quantity = (e.quantity ?? {}) as Record<string, unknown>;
        return { name, quantity: num(quantity.amount), unit: str(quantity.quantityType) };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null);
  }
  result.steps = parseStepBlock((obj.steps as unknown[])?.map?.((s) => str((s as Record<string, unknown>)?.step) ?? '') ?? []);
  return result;
}

// ── Nextcloud Cookbook / anything schema.org-shaped ─────────────────────

function schemaOrgToRecipe(obj: Record<string, unknown>): TemplateParseResult | null {
  // Reuse the extractor by handing it a minimal document — one mapper for
  // schema.org rather than a near-copy that drifts.
  const html = `<script type="application/ld+json">${JSON.stringify({ ...obj, '@type': 'Recipe' })}</script>`;
  return extractRecipeFromHtml(html) as TemplateParseResult | null;
}

// ── Detection ───────────────────────────────────────────────────────────

function looksLikeMealie(o: Record<string, unknown>): boolean {
  return 'recipeIngredient' in o && ('slug' in o || 'recipeYield' in o || 'recipeInstructions' in o);
}
function looksLikeCrouton(o: Record<string, unknown>): boolean {
  return 'serves' in o && Array.isArray(o.ingredients) && 'uuid' in o;
}
function looksLikePaprika(o: Record<string, unknown>): boolean {
  return 'directions' in o && 'ingredients' in o;
}

function fromJsonObject(o: Record<string, unknown>): { source: MigrationSource; recipe: TemplateParseResult | null } {
  if (looksLikePaprika(o)) return { source: 'paprika', recipe: paprikaToRecipe(o) };
  if (looksLikeCrouton(o)) return { source: 'crouton', recipe: croutonToRecipe(o) };
  if (looksLikeMealie(o)) return { source: 'mealie', recipe: mealieToRecipe(o) };
  return { source: 'schema-org', recipe: schemaOrgToRecipe(o) };
}

/** Anything that might hold recipes: a bare object, an array, or a wrapper
 *  with a `recipes`/`data`/`items` array (which most bulk exports use). */
function candidateObjects(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const key of ['recipes', 'data', 'items', 'results']) {
      if (Array.isArray(o[key])) {
        return (o[key] as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      }
    }
    return [o];
  }
  return [];
}

/**
 * Reads whatever the user picked, whatever app produced it.
 *
 * Returns null when the file is not a recognisable recipe export at all,
 * so the caller can fall back to SmartChef's own bundle importer rather
 * than reporting a misleading error.
 */
export async function readMigrationFile(fileName: string, bytes: Uint8Array): Promise<MigrationResult | null> {
  const lower = fileName.toLowerCase();

  // Paprika announces itself by extension, and its contents are gzipped, so
  // sniffing the bytes would not identify it.
  if (lower.endsWith('.paprikarecipes') || lower.endsWith('.paprikarecipe')) {
    return readPaprika(bytes);
  }

  if (looksZipped(bytes)) {
    // Mela (.melarecipes) and Mealie's bulk export are both zips of JSON.
    const skipped: string[] = [];
    const recipes: TemplateParseResult[] = [];
    let source: MigrationSource = lower.endsWith('.melarecipes') ? 'mela' : 'mealie';

    for (const entry of await readZip(bytes)) {
      if (!/\.(json|melarecipe|crumb)$/i.test(entry.name)) continue;
      try {
        const body = looksGzipped(entry.bytes) ? await gunzip(entry.bytes) : entry.bytes;
        for (const obj of candidateObjects(JSON.parse(text(body)))) {
          const { source: detected, recipe } = fromJsonObject(obj);
          if (recipe) {
            recipes.push(recipe);
            if (!lower.endsWith('.melarecipes')) source = detected;
          } else skipped.push(entry.name);
        }
      } catch {
        skipped.push(entry.name);
      }
    }
    return recipes.length || skipped.length ? { source, recipes, skipped } : null;
  }

  const body = text(bytes).trim();

  // CopyMeThat exports HTML pages that still carry their schema.org data,
  // so the structured-data extractor already handles them.
  if (body.startsWith('<')) {
    const recipe = extractRecipeFromHtml(body) as TemplateParseResult | null;
    return recipe ? { source: 'copymethat', recipes: [recipe], skipped: [] } : null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  // SmartChef's own bundle has its own importer and must not be hijacked.
  if (parsed && typeof parsed === 'object' && 'formatVersion' in (parsed as Record<string, unknown>)) {
    return null;
  }

  const objects = candidateObjects(parsed);
  if (objects.length === 0) return null;

  const recipes: TemplateParseResult[] = [];
  const skipped: string[] = [];
  let source: MigrationSource = 'schema-org';

  objects.forEach((obj, i) => {
    const { source: detected, recipe } = fromJsonObject(obj);
    if (recipe && recipe.ingredients.length + recipe.steps.length > 0) {
      recipes.push(recipe);
      source = detected;
    } else {
      skipped.push(str(obj.name) ?? `#${i + 1}`);
    }
  });

  return recipes.length ? { source, recipes, skipped } : null;
}

export const MIGRATION_SOURCE_LABELS: Record<MigrationSource, string> = {
  paprika: 'Paprika',
  mealie: 'Mealie',
  recipesage: 'RecipeSage',
  nextcloud: 'Nextcloud Cookbook',
  crouton: 'Crouton',
  mela: 'Mela',
  copymethat: 'CopyMeThat',
  'schema-org': 'schema.org',
};
