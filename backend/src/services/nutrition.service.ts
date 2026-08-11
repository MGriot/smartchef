// ════════════════════════════════════════════════════════════════════════
// SmartChef — Nutrition Service
// Calcola i valori nutrizionali di una ricetta (o di un intero menù)
// riusando il Matrioska Engine per risolvere ingredienti diretti e di
// sub-ricette, poi convertendo ogni quantità in grammi per scalarla contro
// i valori "per 100g" registrati sull'ingrediente.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import { calculatePortions } from "./matrioska.engine";
import type { UUID } from "@shared/types/index";

export interface NutritionTotals {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
}

export interface RecipeNutritionResult {
  recipeId: UUID;
  requestedServings: number;
  totals: NutritionTotals;
  perServing: NutritionTotals;
  unresolved: string[]; // nomi ingredienti che non contribuiscono (unità non convertibile o dati nutrizionali mancanti)
}

const ZERO_TOTALS = (): NutritionTotals => ({
  caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0,
});

interface IngredientNutritionRow {
  id: UUID;
  density_g_per_ml: number | null;
  calories_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
}

interface UnitRow {
  id: UUID;
  unit_type: string;
  to_base_factor: number | null;
}

/**
 * Risolve gli ingredienti (compresi quelli di sub-ricette annidate, via
 * calculatePortions) e somma i loro valori nutrizionali scalati.
 */
export async function calculateRecipeNutrition(
  recipeId: UUID,
  requestedServings: number
): Promise<RecipeNutritionResult> {
  const portions = await calculatePortions(recipeId, requestedServings);
  const resolved = portions.resolvedIngredients;

  const ingredientIds = [...new Set(resolved.map(r => r.ingredientId).filter(Boolean))];
  const unitIds = [...new Set(resolved.map(r => r.unitId).filter(Boolean))];

  const [ingRows, unitRows] = await Promise.all([
    ingredientIds.length
      ? query<IngredientNutritionRow>(
          `SELECT id, density_g_per_ml, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg
           FROM ingredients WHERE id = ANY($1::uuid[])`,
          [ingredientIds]
        )
      : Promise.resolve([]),
    unitIds.length
      ? query<UnitRow>(`SELECT id, unit_type, to_base_factor FROM units WHERE id = ANY($1::uuid[])`, [unitIds])
      : Promise.resolve([]),
  ]);

  const ingredientById = new Map(ingRows.map(r => [r.id, r]));
  const unitById = new Map(unitRows.map(r => [r.id, r]));

  const totals = ZERO_TOTALS();
  const unresolved: string[] = [];

  for (const item of resolved) {
    const ing = ingredientById.get(item.ingredientId);
    const unit = item.unitId ? unitById.get(item.unitId) : undefined;

    let grams: number | null = null;
    if (unit?.unit_type === "weight" && unit.to_base_factor != null) {
      grams = item.quantity * unit.to_base_factor;
    } else if (unit?.unit_type === "volume" && unit.to_base_factor != null && ing?.density_g_per_ml != null) {
      grams = item.quantity * unit.to_base_factor * ing.density_g_per_ml;
    }

    const hasNutritionData = ing && (
      ing.calories_kcal != null || ing.protein_g != null || ing.carbs_g != null ||
      ing.fat_g != null || ing.fiber_g != null || ing.sugar_g != null || ing.sodium_mg != null
    );

    if (grams == null || grams === 0 || !hasNutritionData) {
      unresolved.push(item.ingredientName);
      continue;
    }

    const factor = grams / 100;
    totals.caloriesKcal += (ing!.calories_kcal ?? 0) * factor;
    totals.proteinG += (ing!.protein_g ?? 0) * factor;
    totals.carbsG += (ing!.carbs_g ?? 0) * factor;
    totals.fatG += (ing!.fat_g ?? 0) * factor;
    totals.fiberG += (ing!.fiber_g ?? 0) * factor;
    totals.sugarG += (ing!.sugar_g ?? 0) * factor;
    totals.sodiumMg += (ing!.sodium_mg ?? 0) * factor;
  }

  const round = (n: number) => Math.round(n * 10) / 10;
  const roundedTotals = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, round(v)])
  ) as unknown as NutritionTotals;
  const perServing = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, round(v / Math.max(requestedServings, 1))])
  ) as unknown as NutritionTotals;

  return {
    recipeId,
    requestedServings,
    totals: roundedTotals,
    perServing,
    unresolved: [...new Set(unresolved)],
  };
}

export interface MenuNutritionResult {
  menuId: UUID;
  byDay: Record<number, NutritionTotals>;
  weekly: NutritionTotals;
  unresolved: string[];
}

interface MenuItemRow {
  recipe_id: UUID;
  day_of_week: number;
  servings: number;
}

/**
 * Somma la nutrizione di ogni ricetta pianificata in un menù, raggruppata
 * per giorno della settimana, più un totale settimanale.
 */
export async function calculateMenuNutrition(menuId: UUID): Promise<MenuNutritionResult> {
  const items = await query<MenuItemRow>(
    `SELECT recipe_id, day_of_week, servings FROM menu_items WHERE menu_id = $1`,
    [menuId]
  );

  const byDay: Record<number, NutritionTotals> = {};
  const weekly = ZERO_TOTALS();
  const unresolved = new Set<string>();

  for (const item of items) {
    const result = await calculateRecipeNutrition(item.recipe_id, item.servings);
    result.unresolved.forEach(u => unresolved.add(u));

    if (!byDay[item.day_of_week]) byDay[item.day_of_week] = ZERO_TOTALS();
    for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
      byDay[item.day_of_week][key] += result.totals[key];
      weekly[key] += result.totals[key];
    }
  }

  const round = (n: number) => Math.round(n * 10) / 10;
  for (const day of Object.keys(byDay)) {
    for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
      byDay[Number(day)][key] = round(byDay[Number(day)][key]);
    }
  }
  for (const key of Object.keys(weekly) as (keyof NutritionTotals)[]) {
    weekly[key] = round(weekly[key]);
  }

  return { menuId, byDay, weekly, unresolved: [...unresolved] };
}
