// ════════════════════════════════════════════════════════════════════════
// SmartChef — The pantry, and "what can I cook right now?"
//
// KitchenOwl is the only competitor that tracks a cupboard, and it has no
// concept of a recipe inside a recipe. SmartChef does, so this can answer a
// question none of them can: whether you can cook a dish whose sauce is
// itself a recipe, by resolving the whole tree through the matrioska engine
// before comparing against stock.
//
// The matching honours the request contract that has been frozen in
// backend/src/routes/recipes.ts since long before this existed —
// `{ingredients: [{ingredientId, quantity?, unit?}], minMatchRatio?}` —
// including its stated rule that an omitted quantity means "I have some,
// don't check amounts".
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import { calculatePortions, preloadMatrioska } from './matrioska.local';

export interface PantryItemRow {
  id: string;
  ingredient_id: string;
  ingredient_name: string | null;
  category_name: string | null;
  category_color: string | null;
  quantity: number | null;
  unit_id: string | null;
  unit_symbol: string | null;
  expires_at: string | null;
  note: string | null;
}

function newId(): string {
  return crypto.randomUUID();
}

export async function listPantry(): Promise<PantryItemRow[]> {
  return query<PantryItemRow>(
    `SELECT p.id, p.ingredient_id, i.name AS ingredient_name,
            ic.name AS category_name, ic.color AS category_color,
            p.quantity, p.unit_id, u.symbol AS unit_symbol,
            p.expires_at, p.note
       FROM pantry_items p
       LEFT JOIN ingredients i ON i.id = p.ingredient_id
       LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
       LEFT JOIN units u ON u.id = p.unit_id
      ORDER BY ic.sort_order, i.name`,
  );
}

/** Upsert by ingredient: topping up the flour edits the existing row rather
 *  than adding a second "flour" the matcher would have to sum. */
export async function putPantryItem(input: {
  ingredientId: string;
  quantity?: number | null;
  unitId?: string | null;
  expiresAt?: string | null;
  note?: string | null;
}): Promise<{ id: string }> {
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM pantry_items WHERE ingredient_id=$1', [input.ingredientId],
  );
  if (existing) {
    await query(
      `UPDATE pantry_items
          SET quantity=$1, unit_id=$2, expires_at=$3, note=$4, updated_at=CURRENT_TIMESTAMP
        WHERE id=$5`,
      [input.quantity ?? null, input.unitId ?? null, input.expiresAt ?? null, input.note ?? null, existing.id],
    );
    return { id: existing.id };
  }
  const id = newId();
  await query(
    `INSERT INTO pantry_items (id, ingredient_id, quantity, unit_id, expires_at, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.ingredientId, input.quantity ?? null, input.unitId ?? null, input.expiresAt ?? null, input.note ?? null],
  );
  return { id };
}

export async function deletePantryItem(id: string): Promise<void> {
  await query('DELETE FROM pantry_items WHERE id=$1', [id]);
}

// ── Matching ────────────────────────────────────────────────────────────

export interface PantryRequestItem {
  ingredientId: string;
  quantity?: number;
  unit?: string;
}

export interface CookableRecipe {
  recipeId: string;
  title: string;
  coverImageUrl: string | null;
  matchRatio: number;
  have: number;
  required: number;
  missing: Array<{ ingredientId: string; name: string; quantity: number; unitSymbol: string }>;
}

interface UnitRow { id: string; symbol: string; name: string; unit_type: string; to_base_factor: number | null }

/** Converts through the units catalogue rather than lib/unitConvert: the
 *  pantry and the recipe both reference real unit rows, so `to_base_factor`
 *  is the authority here and needs no second table to disagree with.
 *  Returns null when the two are not the same kind of thing, which the
 *  caller treats as "cannot verify the amount". */
function toBase(quantity: number, unit: UnitRow | undefined): number | null {
  if (!unit || unit.to_base_factor == null) return null;
  return quantity * unit.to_base_factor;
}

/**
 * Which recipes can be cooked from a given set of ingredients.
 *
 * Rules, matching the frozen contract:
 *   - Optional ingredients never count against a recipe. That is why
 *     `isOptional` had to be carried through the matrioska engine.
 *   - A pantry entry with no quantity means "I have some" and satisfies
 *     any amount.
 *   - An amount that cannot be compared (different unit types, a missing
 *     conversion factor, a vague "q.b.") counts as satisfied rather than
 *     missing: refusing to suggest a recipe because it wants "a pinch of
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
): Promise<CookableRecipe[]> {
  const units = await query<UnitRow>('SELECT id, symbol, name, unit_type, to_base_factor FROM units');
  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitBySymbol = new Map(units.map((u) => [u.symbol.toLowerCase(), u]));

  const stock = new Map<string, { quantity: number | null; unit: UnitRow | undefined }>();
  for (const item of items) {
    const unit = item.unit ? unitBySymbol.get(item.unit.toLowerCase()) : undefined;
    stock.set(item.ingredientId, { quantity: item.quantity ?? null, unit });
  }

  // Two queries for the whole library's ingredients instead of one per
  // recipe per sub-recipe node. Every one of those is a native bridge
  // round-trip on Android, which is the difference between an answer that
  // arrives and one you watch arrive.
  const [recipes, preload] = await Promise.all([
    query<{ id: string; title: string; cover_image_url: string | null; servings: number }>(
      `SELECT id, title, cover_image_url, servings
         FROM recipes
        WHERE sync_status != 'deleted' AND is_component = 0`,
    ),
    preloadMatrioska(),
  ]);

  const out: CookableRecipe[] = [];

  for (const recipe of recipes) {
    let resolved;
    try {
      resolved = await calculatePortions(recipe.id, recipe.servings, preload);
    } catch {
      continue; // a recipe with a broken sub-recipe reference is not cookable
    }

    const required = resolved.resolvedIngredients.filter((i) => !i.isOptional && i.ingredientId);
    if (required.length === 0) continue;

    const missing: CookableRecipe['missing'] = [];

    for (const need of required) {
      const held = stock.get(need.ingredientId);
      if (!held) {
        missing.push({
          ingredientId: need.ingredientId,
          name: need.ingredientName,
          quantity: need.quantity,
          unitSymbol: need.unitSymbol,
        });
        continue;
      }
      if (held.quantity == null) continue; // "I have some"

      const needBase = toBase(need.quantity, unitById.get(need.unitId));
      const heldBase = toBase(held.quantity, held.unit);
      // Not comparable → assume it is fine, rather than hiding the recipe.
      if (needBase == null || heldBase == null) continue;
      if (heldBase + 1e-9 < needBase) {
        missing.push({
          ingredientId: need.ingredientId,
          name: need.ingredientName,
          quantity: need.quantity,
          unitSymbol: need.unitSymbol,
        });
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

  // Best matches first; among equals, the one needing fewest things.
  return out.sort((a, b) => b.matchRatio - a.matchRatio || a.missing.length - b.missing.length);
}
