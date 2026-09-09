// ════════════════════════════════════════════════════════════════════════
// SmartChef — Importing a whole library at once
//
// The Import screen's Review Matches step is one recipe at a time, which is
// right for a single URL and unusable for a 200-recipe Paprika export.
//
// The key move is matching ONCE for the whole batch rather than per recipe:
// two hundred recipes might mention "olive oil" a hundred times, and asking
// the matcher (and the user) about it a hundred times would be both slow
// and maddening. Names are pooled, matched once, and the decision is reused
// everywhere that name appears.
//
// Ambiguous names are still the user's call — see needsReview below. What
// this must never do is silently mint a second "Tomato" beside the one
// already in the library, which is exactly what a naive bulk insert does.
// ════════════════════════════════════════════════════════════════════════

import type { TemplateParseResult } from '../recipeTemplateParser';
import { proposeMatches } from '../matchSuggestions';
import { apiFetch } from '../../lib/api';
import { repairIngredientAmount } from '../../lib/ingredientAmount';
import { matchUnitId, type MatchSuggestion } from '../../lib/fuzzyMatch';

/** Above this the top suggestion is taken automatically; below it the name
 *  is put in front of the user. Matches the single-recipe path's threshold
 *  so bulk and single imports never disagree about the same name. */
const AUTO_MATCH_SCORE = 0.7;

export interface NameDecision {
  name: string;
  /** null = create a new library entry for this name. */
  matchedId: string | null;
  matchedName?: string;
  score?: number;
  suggestions: MatchSuggestion[];
}

export interface BulkPlan {
  recipes: TemplateParseResult[];
  ingredients: NameDecision[];
  tools: NameDecision[];
  /** Ingredient names the matcher was unsure about. */
  needsReview: NameDecision[];
  uniqueIngredientCount: number;
}

function decide(name: string, suggestions: MatchSuggestion[]): NameDecision {
  const top = suggestions[0];
  if (top && top.score > AUTO_MATCH_SCORE) {
    return { name, matchedId: top.id, matchedName: top.name, score: top.score, suggestions };
  }
  return { name, matchedId: null, suggestions };
}

/** Pools every distinct ingredient and tool name across the batch and
 *  matches them in one pass. */
export async function planBulkImport(recipes: TemplateParseResult[]): Promise<BulkPlan> {
  const ingredientNames = [...new Set(
    recipes.flatMap((r) => r.ingredients.map((i) => i.name.trim()).filter(Boolean)),
  )];
  const toolNames = [...new Set(recipes.flatMap((r) => r.tools.map((t) => t.trim()).filter(Boolean)))];

  const matches = await proposeMatches(ingredientNames, toolNames, []);

  const ingredients = ingredientNames.map((n) => decide(n, matches.ingredients[n] || []));
  const tools = toolNames.map((n) => decide(n, matches.tools[n] || []));

  return {
    recipes,
    ingredients,
    tools,
    // Only names with *some* candidate are worth asking about. A name with
    // no suggestions at all is unambiguously new and needs no decision.
    needsReview: ingredients.filter((d) => d.matchedId === null && d.suggestions.length > 0),
    uniqueIngredientCount: ingredientNames.length,
  };
}

export interface BulkProgress {
  done: number;
  total: number;
  currentTitle: string;
}

export interface BulkImportSummary {
  created: number;
  failed: Array<{ title: string; reason: string }>;
  newIngredients: number;
}

interface CreatedLookup {
  ingredientIdByName: Map<string, string>;
  toolIdByName: Map<string, string>;
}

async function ensureIngredient(
  name: string,
  categoryId: string,
  lookup: CreatedLookup,
): Promise<string | null> {
  const key = name.toLowerCase();
  const known = lookup.ingredientIdByName.get(key);
  if (known) return known;

  const res = await apiFetch('/api/ingredients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, categoryId }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const id = json.data?.id as string | undefined;
  if (id) lookup.ingredientIdByName.set(key, id);
  return id ?? null;
}

/**
 * Creates every recipe in the plan.
 *
 * Sequential on purpose. Each recipe may create ingredients that the next
 * one reuses, and firing them concurrently races those creates into
 * duplicates — the precise failure this whole module exists to avoid. A
 * couple of hundred recipes is a progress bar, not a performance problem.
 */
export async function runBulkImport(
  plan: BulkPlan,
  categoryId: string,
  units: Array<{ id: string; symbol: string; name: string }>,
  onProgress?: (p: BulkProgress) => void,
): Promise<BulkImportSummary> {
  const lookup: CreatedLookup = { ingredientIdByName: new Map(), toolIdByName: new Map() };
  for (const d of plan.ingredients) {
    if (d.matchedId) lookup.ingredientIdByName.set(d.name.toLowerCase(), d.matchedId);
  }
  for (const d of plan.tools) {
    if (d.matchedId) lookup.toolIdByName.set(d.name.toLowerCase(), d.matchedId);
  }

  const preexisting = lookup.ingredientIdByName.size;
  const summary: BulkImportSummary = { created: 0, failed: [], newIngredients: 0 };

  for (const [index, recipe] of plan.recipes.entries()) {
    onProgress?.({ done: index, total: plan.recipes.length, currentTitle: recipe.title });
    try {
      const ingredients: Array<Record<string, unknown>> = [];

      for (const [sortOrder, raw] of recipe.ingredients.entries()) {
        // repairIngredientAmount only knows about the amount fields, so the
        // repaired values are merged back onto the original line — same
        // pattern as the single-recipe path in RecipeImport.tsx.
        const repaired = repairIngredientAmount(raw);
        const ing = { ...raw, quantity: repaired.quantity ?? undefined, notes: repaired.notes ?? undefined };
        const name = ing.name.trim();
        if (!name) continue;
        const ingredientId = await ensureIngredient(name, categoryId, lookup);
        if (!ingredientId) continue;
        ingredients.push({
          sortOrder,
          ingredientId,
          quantity: ing.quantity ?? null,
          quantityText: ing.quantity == null ? ing.quantityText ?? null : null,
          unitId: ing.unit ? matchUnitId(ing.unit, units) : null,
          notes: ing.notes ?? null,
          groupName: ing.groupName ?? null,
          isOptional: false,
        });
      }

      const res = await apiFetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: recipe.title,
          description: recipe.description || undefined,
          servings: recipe.servings || 4,
          prepTimeMin: recipe.prepTimeMin || undefined,
          cookTimeMin: recipe.cookTimeMin || undefined,
          restTimeMin: recipe.restTimeMin || undefined,
          difficulty: recipe.difficulty || 'medium',
          languageCode: recipe.language || undefined,
          storageInstructions: recipe.storageInstructions || undefined,
          tips: recipe.tips || undefined,
          tags: recipe.tags || [],
          sourceUrl: recipe.sourceUrl || undefined,
          sources: recipe.sourceUrl
            ? [{ type: 'url', label: 'Original recipe', url: recipe.sourceUrl }]
            : [],
          isComponent: false,
          ingredients,
          steps: recipe.steps.map((s) => ({
            stepNumber: s.stepNumber,
            title: s.title || undefined,
            description: s.description,
            durationMin: s.durationMin ?? null,
            toolIds: [],
          })),
          toolIds: [],
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
      }
      summary.created += 1;
    } catch (err) {
      // One bad recipe must not abandon the other 199.
      summary.failed.push({
        title: recipe.title,
        reason: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  summary.newIngredients = lookup.ingredientIdByName.size - preexisting;
  onProgress?.({ done: plan.recipes.length, total: plan.recipes.length, currentTitle: '' });
  return summary;
}
