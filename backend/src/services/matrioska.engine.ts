// ════════════════════════════════════════════════════════════════════════
// SmartChef — Matrioska Engine
// Calcola ricorsivamente gli ingredienti per N porzioni
// risolvendo tutte le sub-ricette nidificate
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import type {
  PortionCalculationResult,
  ResolvedIngredient,
  UUID,
} from "@shared/types/index";

const MAX_DEPTH = 20; // protezione contro ricorsione infinita

interface RawRecipeIngredient {
  id: UUID;
  sort_order: number;
  ingredient_id: UUID | null;
  ingredient_name: string | null;
  sub_recipe_id: UUID | null;
  sub_recipe_title: string | null;
  sub_recipe_servings: number | null;
  quantity: number | null;
  quantity_text: string | null;
  unit_id: UUID | null;
  unit_symbol: string | null;
  notes: string | null;
  is_optional: boolean;
}

/**
 * Carica gli ingredienti diretti di una ricetta dal DB
 */
async function loadRecipeIngredients(recipeId: UUID): Promise<RawRecipeIngredient[]> {
  return query<RawRecipeIngredient>(
    `SELECT
       ri.id, ri.sort_order,
       ri.ingredient_id,
       i.name  AS ingredient_name,
       ri.sub_recipe_id,
       sr.title AS sub_recipe_title,
       sr.servings AS sub_recipe_servings,
       ri.quantity, ri.quantity_text,
       ri.unit_id, u.symbol AS unit_symbol,
       ri.notes, ri.is_optional
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i    ON i.id = ri.ingredient_id
     LEFT JOIN recipes sr       ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u          ON u.id = ri.unit_id
     WHERE ri.recipe_id = $1
     ORDER BY ri.sort_order`,
    [recipeId]
  );
}

/**
 * Risolve ricorsivamente tutti gli ingredienti di una ricetta
 * scalando le quantità per il numero di porzioni richieste.
 *
 * @param recipeId      - ID della ricetta da risolvere
 * @param requestedServings - Numero di porzioni desiderate
 * @param baseServings  - Numero di porzioni della ricetta come definita (default del DB)
 * @param chain         - Stack della catena di nidificazione (per tracciamento)
 * @param depth         - Profondità di ricorsione corrente
 * @param visited       - Set degli ID già visitati (anti-loop)
 */
async function resolveIngredients(
  recipeId: UUID,
  requestedServings: number,
  baseServings: number,
  chain: string[],
  depth: number,
  visited: Set<UUID>
): Promise<{ ingredients: ResolvedIngredient[]; warnings: string[] }> {
  if (depth > MAX_DEPTH) {
    return {
      ingredients: [],
      warnings: [`⚠️ Profondità massima (${MAX_DEPTH}) raggiunta in: ${chain.join(" → ")}`],
    };
  }

  if (visited.has(recipeId)) {
    return {
      ingredients: [],
      warnings: [`⚠️ Riferimento circolare rilevato: ${chain.join(" → ")}`],
    };
  }
  visited.add(recipeId);

  const scaleFactor = requestedServings / baseServings;
  const rows = await loadRecipeIngredients(recipeId);

  const resolved: ResolvedIngredient[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    // ── Ingrediente semplice ────────────────────────────────────────────
    if (row.ingredient_id) {
      if (row.quantity == null && !row.quantity_text) {
        warnings.push(
          `⚠️ Quantità mancante per "${row.ingredient_name}" in ${chain.at(-1) ?? "?"}`
        );
      }

      if (row.quantity_text && row.quantity == null) {
        // Quantità vaga: passa through con avviso
        resolved.push({
          ingredientId: row.ingredient_id,
          ingredientName: row.ingredient_name!,
          quantity: 0,
          quantityText: row.quantity_text,
          unitSymbol: row.unit_symbol ?? "—",
          unitId: row.unit_id ?? "",
          sourceChain: [...chain],
        });
        warnings.push(
          `ℹ️ Quantità vaga "${row.quantity_text}" per "${row.ingredient_name}" in ${chain.at(-1) ?? "?"}`
        );
        continue;
      }

      resolved.push({
        ingredientId: row.ingredient_id,
        ingredientName: row.ingredient_name!,
        quantity: (row.quantity ?? 0) * scaleFactor,
        quantityText: row.quantity_text ?? undefined,
        unitSymbol: row.unit_symbol ?? "—",
        unitId: row.unit_id ?? "",
        sourceChain: [...chain],
      });
      continue;
    }

    // ── Sub-ricetta nidificata (Matrioska) ─────────────────────────────
    if (row.sub_recipe_id) {
      const subTitle = row.sub_recipe_title ?? row.sub_recipe_id;
      const subBaseServings = row.sub_recipe_servings ?? 4;

      // La sub-ricetta è usata come "ingrediente" → la sua quantità
      // è il numero di porzioni-equivalenti necessarie
      const subRequestedServings = row.quantity != null
        ? row.quantity * scaleFactor  // quantità esplicita (es. "2 porzioni di Salsa Madre")
        : requestedServings;           // default: stesse porzioni della ricetta padre

      const sub = await resolveIngredients(
        row.sub_recipe_id,
        subRequestedServings,
        subBaseServings,
        [...chain, subTitle],
        depth + 1,
        new Set(visited) // clone per evitare falsi positivi tra rami paralleli
      );

      resolved.push(...sub.ingredients);
      warnings.push(...sub.warnings);
    }
  }

  return { ingredients: resolved, warnings };
}

/**
 * Aggrega ingredienti duplicati sommando le quantità
 * (stesso ingredientId + stessa unità)
 */
function aggregateIngredients(
  ingredients: ResolvedIngredient[]
): ResolvedIngredient[] {
  const map = new Map<string, ResolvedIngredient>();

  for (const item of ingredients) {
    const key = `${item.ingredientId}::${item.unitId}`;
    if (map.has(key)) {
      const existing = map.get(key)!;
      existing.quantity += item.quantity;
      existing.sourceChain = [...new Set([...existing.sourceChain, ...item.sourceChain])];
    } else {
      map.set(key, { ...item, sourceChain: [...item.sourceChain] });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.ingredientName.localeCompare(b.ingredientName)
  );
}

/**
 * Entry point pubblico del Matrioska Engine
 */
export async function calculatePortions(
  recipeId: UUID,
  requestedServings: number
): Promise<PortionCalculationResult> {
  // Recupera info base della ricetta
  const recipeRows = await query<{ title: string; servings: number }>(
    "SELECT title, servings FROM recipes WHERE id = $1",
    [recipeId]
  );

  if (!recipeRows.length) {
    throw new Error(`Ricetta ${recipeId} non trovata`);
  }

  const { title, servings: baseServings } = recipeRows[0];

  const { ingredients, warnings } = await resolveIngredients(
    recipeId,
    requestedServings,
    baseServings,
    [title],
    0,
    new Set()
  );

  const aggregated = aggregateIngredients(ingredients);

  return {
    recipeId,
    recipeTitle: title,
    requestedServings,
    resolvedIngredients: aggregated,
    warnings,
  };
}
