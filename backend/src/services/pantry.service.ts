// ════════════════════════════════════════════════════════════════════════
// SmartChef — "What can I cook right now?"
//
// The server half of frontend/src/services/pantry.local.ts; same rules,
// same response shape, so the Pantry screen cannot tell which answered.
//
// The reason this is worth having at all: every recipe goes through the
// matrioska engine first, so a dish whose sauce is itself a recipe is
// checked against its *resolved* ingredient tree. KitchenOwl is the only
// competitor with a pantry and it has no sub-recipes, so none of them can
// answer this question for a nested recipe.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import { calculatePortions } from "./matrioska.engine";
import type { UUID } from "@shared/types/index";

export interface PantryRequestItem {
  ingredientId: UUID;
  quantity?: number;
  unit?: string;
}

export interface CookableRecipe {
  recipeId: UUID;
  title: string;
  coverImageUrl: string | null;
  matchRatio: number;
  have: number;
  required: number;
  missing: Array<{ ingredientId: UUID; name: string; quantity: number; unitSymbol: string }>;
}

interface UnitRow { id: UUID; symbol: string; unit_type: string; to_base_factor: string | number | null }

/** Converts through the units catalogue: both the pantry and the recipe
 *  reference real unit rows, so `to_base_factor` is the authority and needs
 *  no second conversion table to disagree with. null when the amount cannot
 *  be compared at all. */
function toBase(quantity: number, unit: UnitRow | undefined): number | null {
  if (!unit || unit.to_base_factor == null) return null;
  const factor = typeof unit.to_base_factor === "string" ? parseFloat(unit.to_base_factor) : unit.to_base_factor;
  return Number.isFinite(factor) ? quantity * factor : null;
}

/**
 * Rules, matching the request contract frozen in routes/recipes.ts:
 *   - Optional ingredients never count against a recipe.
 *   - A pantry entry with no quantity means "I have some" and satisfies any
 *     amount — the contract says so explicitly.
 *   - An amount that cannot be compared (different unit types, no
 *     conversion factor, a vague "q.b.") counts as satisfied rather than
 *     missing. Refusing to suggest a recipe because it wants "a pinch of
 *     salt" would make the whole feature useless.
 *
 * `minMatchRatio` 0 is the partial-match mode, and it does NOT mean "every
 * recipe qualifies": taken literally it would return the entire library,
 * most of it matching nothing at all, which is a worse answer than none.
 * It means "at least one ingredient I have", i.e. the recipes a pantry
 * actually has a claim on, ranked by how much of each one it covers.
 * That mode exists because the alternative — the original 1.0 default —
 * answers "nothing" for any pantry that isn't already a full shop, which
 * reads as a broken feature rather than as a strict filter.
 */
export async function filterByPantry(
  items: PantryRequestItem[],
  minMatchRatio = 1,
  lang?: string | null
): Promise<CookableRecipe[]> {
  const units = await query<UnitRow>("SELECT id, symbol, unit_type, to_base_factor FROM units");
  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitBySymbol = new Map(units.map((u) => [u.symbol.toLowerCase(), u]));

  const stock = new Map<string, { quantity: number | null; unit: UnitRow | undefined }>();
  for (const item of items) {
    stock.set(item.ingredientId, {
      quantity: item.quantity ?? null,
      unit: item.unit ? unitBySymbol.get(item.unit.toLowerCase()) : undefined,
    });
  }

  const recipes = await query<{ id: UUID; title: string; cover_image_url: string | null; servings: number }>(
    `SELECT id, title, cover_image_url, servings
       FROM recipes
      WHERE sync_status != 'deleted' AND is_component = false`
  );

  const out: CookableRecipe[] = [];

  for (const recipe of recipes) {
    let resolved;
    try {
      resolved = await calculatePortions(recipe.id, recipe.servings);
    } catch {
      continue; // a broken sub-recipe reference is not cookable
    }

    const required = resolved.resolvedIngredients.filter((i) => !i.isOptional && i.ingredientId);
    if (required.length === 0) continue;

    const missing: CookableRecipe["missing"] = [];
    for (const need of required) {
      const held = stock.get(need.ingredientId);
      if (!held) {
        missing.push({ ingredientId: need.ingredientId, name: need.ingredientName, quantity: need.quantity, unitSymbol: need.unitSymbol });
        continue;
      }
      if (held.quantity == null) continue;

      const needBase = toBase(need.quantity, unitById.get(need.unitId));
      const heldBase = toBase(held.quantity, held.unit);
      if (needBase == null || heldBase == null) continue;
      if (heldBase + 1e-9 < needBase) {
        missing.push({ ingredientId: need.ingredientId, name: need.ingredientName, quantity: need.quantity, unitSymbol: need.unitSymbol });
      }
    }

    const have = required.length - missing.length;
    const matchRatio = have / required.length;
    const qualifies = minMatchRatio <= 0 ? have > 0 : matchRatio >= minMatchRatio;
    if (qualifies) {
      out.push({
        recipeId: recipe.id,
        title: recipe.title,
        coverImageUrl: recipe.cover_image_url,
        matchRatio: Math.round(matchRatio * 100) / 100,
        have,
        required: required.length,
        missing,
      });
    }
  }

  out.sort((a, b) => b.matchRatio - a.matchRatio || a.missing.length - b.missing.length);
  if (!lang || out.length === 0) return out;

  // Translated over the answer rather than inside the resolver: the
  // matrioska engine works in ids and base names, and is shared with the
  // shopping list and the nutrition figures, neither of which wants a
  // language. Without this the results named Italian recipes correctly and
  // then listed their missing ingredients in English.
  const missingIds = [...new Set(out.flatMap((r) => r.missing.map((m) => m.ingredientId)).filter(Boolean))];
  const [titleRows, nameRows] = await Promise.all([
    query<{ recipe_id: string; title: string | null }>(
      `SELECT recipe_id, title FROM recipe_translations
        WHERE recipe_id = ANY($1::uuid[]) AND LOWER(language_code) = LOWER($2)`,
      [out.map((r) => r.recipeId), lang]
    ),
    missingIds.length
      ? query<{ ingredient_id: string; translated_name: string | null }>(
          `SELECT ingredient_id, translated_name FROM ingredient_translations
            WHERE ingredient_id = ANY($1::uuid[]) AND LOWER(language_code) = LOWER($2)`,
          [missingIds, lang]
        )
      : Promise.resolve([]),
  ]);
  const titleById = new Map(titleRows.filter((r) => r.title).map((r) => [r.recipe_id, r.title as string]));
  const nameById = new Map(nameRows.filter((r) => r.translated_name).map((r) => [r.ingredient_id, r.translated_name as string]));
  return out.map((r) => ({
    ...r,
    title: titleById.get(r.recipeId) ?? r.title,
    missing: r.missing.map((m) => ({ ...m, name: nameById.get(m.ingredientId) ?? m.name })),
  }));
}
