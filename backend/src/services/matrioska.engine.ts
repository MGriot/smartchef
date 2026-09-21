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

// ── Cook sequence (Kitchen Mode: sub-recipes before the main recipe) ──────

export interface CookSequenceStep {
  id: UUID;
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: UUID[];
  imageUrl: string | null;
  notes: string | null;
  /** The step in the reader's language, when one was asked for and exists. */
  translatedTitle?: string | null;
  translatedDescription?: string | null;
  translatedNotes?: string | null;
  /** Which of the section's ingredients this step uses, and how much —
   *  the same shape recipe_steps.step_ingredients holds. Kitchen mode
   *  renders it as a tickable checklist. */
  stepIngredients: Array<{
    ingredientSortOrder: number;
    amountMode?: "fraction" | "absolute";
    portion: number;
    quantity?: number | null;
    unitId?: UUID | null;
    unitSymbol?: string | null;
  }>;
}

export interface CookSequenceIngredientRef {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
  unitSymbol: string | null;
}

export interface CookSequenceToolRef {
  id: UUID;
  name: string;
  icon: string | null;
}

export interface CookSequenceSection {
  recipeId: UUID;
  recipeTitle: string;
  isMain: boolean;
  steps: CookSequenceStep[];
  ingredients: CookSequenceIngredientRef[];
  tools: CookSequenceToolRef[];
}

interface SubRecipeRef {
  sub_recipe_id: UUID;
  sub_recipe_title: string;
}

async function loadSubRecipeRefs(recipeId: UUID): Promise<SubRecipeRef[]> {
  return query<SubRecipeRef>(
    `SELECT ri.sub_recipe_id, sr.title AS sub_recipe_title
     FROM recipe_ingredients ri
     JOIN recipes sr ON sr.id = ri.sub_recipe_id
     WHERE ri.recipe_id = $1 AND ri.sub_recipe_id IS NOT NULL
     ORDER BY ri.sort_order`,
    [recipeId]
  );
}

async function loadRecipeSteps(recipeId: UUID, lang?: string): Promise<CookSequenceStep[]> {
  return query<CookSequenceStep>(
    `SELECT rs.id, rs.step_number AS "stepNumber", rs.title, rs.description,
            rs.duration_min AS "durationMin", rs.tool_ids AS "toolIds", rs.image_url AS "imageUrl", rs.notes,
            rs.step_ingredients AS "stepIngredients",
            ${lang ? "rst.title" : "NULL"} AS "translatedTitle",
            ${lang ? "rst.description" : "NULL"} AS "translatedDescription",
            ${lang ? "rst.notes" : "NULL"} AS "translatedNotes"
     FROM recipe_steps rs
     ${lang ? "LEFT JOIN recipe_step_translations rst ON rst.step_id = rs.id AND LOWER(rst.language_code) = LOWER($2)" : ""}
     WHERE rs.recipe_id = $1
     ORDER BY rs.step_number`,
    lang ? [recipeId, lang] : [recipeId]
  );
}

async function loadSectionIngredients(recipeId: UUID, lang?: string): Promise<CookSequenceIngredientRef[]> {
  // A catalog ingredient takes its ingredient_translations name, a nested
  // recipe its recipe_translations title — each falling back to the base.
  const nameCol = lang
    ? `COALESCE(
         (SELECT it.translated_name FROM ingredient_translations it
          WHERE it.ingredient_id = i.id AND LOWER(it.language_code) = LOWER($2) LIMIT 1),
         i.name,
         (SELECT rt.title FROM recipe_translations rt
          WHERE rt.recipe_id = sr.id AND LOWER(rt.language_code) = LOWER($2) LIMIT 1),
         sr.title)`
    : "COALESCE(i.name, sr.title)";
  return query<CookSequenceIngredientRef>(
    `SELECT ri.sort_order AS "sortOrder", ${nameCol} AS "ingredientName",
            ri.quantity, u.symbol AS "unitSymbol"
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u ON u.id = ri.unit_id
     WHERE ri.recipe_id = $1
     ORDER BY ri.sort_order`,
    lang ? [recipeId, lang] : [recipeId]
  );
}

async function loadSectionTools(recipeId: UUID, lang?: string): Promise<CookSequenceToolRef[]> {
  const nameCol = lang
    ? `COALESCE((SELECT tt.name FROM tool_translations tt
                 WHERE tt.tool_id = t.id AND LOWER(tt.language_code) = LOWER($2) LIMIT 1), t.name)`
    : "t.name";
  return query<CookSequenceToolRef>(
    `SELECT t.id, ${nameCol} AS name, t.icon
     FROM recipe_tools rt
     JOIN tools t ON t.id = rt.tool_id
     WHERE rt.recipe_id = $1`,
    lang ? [recipeId, lang] : [recipeId]
  );
}

/**
 * Risolve ricorsivamente l'ordine di preparazione "Kitchen Mode": le
 * sub-ricette annidate (Matrioska) vengono espanse depth-first PRIMA degli
 * step della ricetta che le contiene, cosicché l'utente prepari sempre i
 * componenti prima del piatto finale che li usa.
 */
async function resolveCookSequenceRecursive(
  recipeId: UUID,
  isMain: boolean,
  depth: number,
  visited: Set<UUID>,
  lang?: string
): Promise<CookSequenceSection[]> {
  if (depth > MAX_DEPTH || visited.has(recipeId)) return [];
  visited.add(recipeId);

  const [subRefs, recipeRow] = await Promise.all([
    loadSubRecipeRefs(recipeId),
    lang
      ? query<{ title: string }>(
          `SELECT COALESCE((SELECT rt.title FROM recipe_translations rt
                            WHERE rt.recipe_id = r.id AND LOWER(rt.language_code) = LOWER($2) LIMIT 1), r.title) AS title
           FROM recipes r WHERE r.id = $1`,
          [recipeId, lang]
        )
      : query<{ title: string }>("SELECT title FROM recipes WHERE id = $1", [recipeId]),
  ]);

  const sections: CookSequenceSection[] = [];
  for (const ref of subRefs) {
    const subSections = await resolveCookSequenceRecursive(
      ref.sub_recipe_id,
      false,
      depth + 1,
      new Set(visited),
      lang
    );
    sections.push(...subSections);
  }

  const [steps, ingredients, tools] = await Promise.all([
    loadRecipeSteps(recipeId, lang),
    loadSectionIngredients(recipeId, lang),
    loadSectionTools(recipeId, lang),
  ]);
  sections.push({
    recipeId,
    recipeTitle: recipeRow[0]?.title ?? "?",
    isMain,
    steps,
    ingredients,
    tools,
  });

  return sections;
}

export async function resolveCookSequence(recipeId: UUID, lang?: string): Promise<CookSequenceSection[]> {
  return resolveCookSequenceRecursive(recipeId, true, 0, new Set(), lang);
}

interface RawRecipeIngredient {
  id: UUID;
  sort_order: number;
  ingredient_id: UUID | null;
  ingredient_name: string | null;
  sub_recipe_id: UUID | null;
  sub_recipe_title: string | null;
  sub_recipe_servings: number | null;
  sub_recipe_yield_amount: number | null;
  sub_recipe_yield_unit_type: string | null;
  sub_recipe_yield_to_base_factor: number | null;
  quantity: number | null;
  quantity_text: string | null;
  unit_id: UUID | null;
  unit_symbol: string | null;
  unit_type: string | null;
  to_base_factor: number | null;
  notes: string | null;
  is_optional: boolean;
  /** Non-null on a row that is an ALTERNATIVE to the row at that
   *  sort_order. Dropped below, so the shopping list, the nutrition
   *  totals and the pantry matcher see the thing you actually cook with
   *  rather than both halves of an either/or. */
  substitute_for: number | null;
}

/**
 * Carica gli ingredienti diretti di una ricetta dal DB
 */
async function loadRecipeIngredients(recipeId: UUID): Promise<RawRecipeIngredient[]> {
  const rows = await query<RawRecipeIngredient>(
    `SELECT
       ri.id, ri.sort_order,
       ri.ingredient_id,
       i.name  AS ingredient_name,
       ri.sub_recipe_id,
       sr.title AS sub_recipe_title,
       sr.servings AS sub_recipe_servings,
       sr.yield_amount AS sub_recipe_yield_amount,
       yu.unit_type AS sub_recipe_yield_unit_type,
       yu.to_base_factor AS sub_recipe_yield_to_base_factor,
       ri.quantity, ri.quantity_text,
       ri.unit_id, u.symbol AS unit_symbol, u.unit_type AS unit_type, u.to_base_factor AS to_base_factor,
       ri.notes, ri.is_optional, ri.substitute_for
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i    ON i.id = ri.ingredient_id
     LEFT JOIN recipes sr       ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u          ON u.id = ri.unit_id
     LEFT JOIN units yu         ON yu.id = sr.yield_unit_id
     WHERE ri.recipe_id = $1
     ORDER BY ri.sort_order`,
    [recipeId]
  );
  // The "or use margarine instead" rows are alternatives to a sibling row,
  // so counting them would have the shopping list buying both, the
  // nutrition totals adding both, and the pantry matcher demanding both.
  return rows.filter(r => r.substitute_for == null);
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
          isOptional: !!row.is_optional,
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
        isOptional: !!row.is_optional,
        sourceChain: [...chain],
      });
      continue;
    }

    // ── Sub-ricetta nidificata (Matrioska) ─────────────────────────────
    if (row.sub_recipe_id) {
      const subTitle = row.sub_recipe_title ?? row.sub_recipe_id;
      const subBaseServings = row.sub_recipe_servings ?? 4;

      // Se la riga specifica un'unità di peso/volume E la sotto-ricetta ha
      // una resa (yield) impostata nella STESSA categoria di unità, converti
      // la quantità richiesta in una frazione della resa totale — permette
      // di scrivere "200 g di Salsa Madre" invece di "porzioni".
      // Niente conversione peso↔volume: servirebbe una densità che le
      // ricette (a differenza degli ingredienti) non hanno.
      let subRequestedServings: number;
      if (
        row.unit_id != null &&
        (row.unit_type === "weight" || row.unit_type === "volume") &&
        row.to_base_factor != null &&
        row.quantity != null &&
        row.sub_recipe_yield_amount != null &&
        row.sub_recipe_yield_unit_type === row.unit_type &&
        row.sub_recipe_yield_to_base_factor != null
      ) {
        const requiredBase = row.quantity * row.to_base_factor;
        const yieldBase = row.sub_recipe_yield_amount * row.sub_recipe_yield_to_base_factor;
        const fractionOfBatch = requiredBase / yieldBase;
        subRequestedServings = fractionOfBatch * subBaseServings * scaleFactor;
      } else if (
        row.unit_id != null &&
        (row.unit_type === "weight" || row.unit_type === "volume") &&
        row.quantity != null
      ) {
        // L'utente ha scelto un'unità di peso/volume ma la conversione non è
        // possibile (resa mancante o di tipo diverso) — non inventare un
        // numero: avvisa e ricadi sul comportamento a porzioni.
        warnings.push(
          `⚠️ Impossibile convertire l'unità per "${subTitle}" in ${chain.at(-1) ?? "?"} — imposta la resa (yield) della sotto-ricetta nella stessa unità (peso o volume), oppure usa un'unità "porzioni"/nessuna unità.`
        );
        subRequestedServings = row.quantity * scaleFactor;
      } else {
        // La sub-ricetta è usata come "ingrediente" → la sua quantità
        // è il numero di porzioni-equivalenti necessarie
        subRequestedServings = row.quantity != null
          ? row.quantity * scaleFactor  // quantità esplicita (es. "2 porzioni di Salsa Madre")
          : requestedServings;           // default: stesse porzioni della ricetta padre
      }

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
      // One required use makes the whole line required: an ingredient that
      // is optional in a garnish but essential in the base is essential.
      existing.isOptional = existing.isOptional && item.isOptional;
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
