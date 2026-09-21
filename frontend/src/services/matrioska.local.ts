// ════════════════════════════════════════════════════════════════════════
// SmartChef — Matrioska Engine (standalone port)
// Ported from backend/src/services/matrioska.engine.ts, unchanged except:
// query() now comes from ../db/local instead of ../db/pool, and the
// @shared/types import (not wired into the frontend build) is replaced by
// the same interfaces defined locally below. Pure computation over query()
// results otherwise — no Postgres-specific SQL in this file to translate.
// ════════════════════════════════════════════════════════════════════════

import { query, inPlaceholders, chunk } from "../db/local";

export type UUID = string;

export interface ResolvedIngredient {
  ingredientId: UUID;
  ingredientName: string;
  quantity: number;
  quantityText?: string;
  unitSymbol: string;
  unitId: UUID;
  sourceChain: string[];
  /** Whether the recipe marks this ingredient optional. Carried through so
   *  "can I cook this?" can ignore a missing garnish — it was read from the
   *  row all along and simply never propagated. */
  isOptional: boolean;
}

export interface PortionCalculationResult {
  recipeId: UUID;
  recipeTitle: string;
  requestedServings: number;
  resolvedIngredients: ResolvedIngredient[];
  warnings: string[];
}

const MAX_DEPTH = 20; // protezione contro ricorsione infinita

// Sopra/sotto questa soglia, un cambio di porzioni non è più "un po' di
// più/meno" ma un salto di scala — ingredienti come lievito o spezie non
// scalano linearmente a quel punto, così come tempi di cottura e dimensioni
// di teglie/pentole. Cookidoo mostra lo stesso tipo di avviso (oltre alla
// capacità massima del boccale, che qui non si applica) ogni volta che le
// porzioni vengono personalizzate oltre la resa originale della ricetta.
const LARGE_SCALE_FACTOR = 3;
const SMALL_SCALE_FACTOR = 0.25;

// ── Cook sequence (Kitchen Mode: sub-recipes before the main recipe) ──────

export interface CookSequenceStep {
  id: UUID;
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: UUID[];
  techniqueIds: UUID[];
  imageUrl: string | null;
  notes: string | null;
  /** The step in the reader's language, when one was asked for and exists —
   *  the same fields getRecipe() returns, so kitchen mode can use the same
   *  "translated ?? base" fallback for a sub-recipe's steps. */
  translatedTitle?: string | null;
  translatedDescription?: string | null;
  translatedNotes?: string | null;
  /** Which of the section's ingredients this step uses, and how much —
   *  the same shape recipe_steps.step_ingredients holds. Kitchen mode
   *  renders it as a tickable checklist, so the sub-recipe-flattened
   *  variant of that screen needs it as much as the plain one does. */
  stepIngredients: Array<{
    ingredientSortOrder: number;
    amountMode?: 'fraction' | 'absolute';
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
  groupName: string | null;
}

export interface CookSequenceToolRef {
  id: UUID;
  name: string;
  icon: string | null;
}

export interface CookSequenceTechniqueRef {
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
  techniques: CookSequenceTechniqueRef[];
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

async function loadRecipeStepsRaw(recipeId: UUID): Promise<Array<Record<string, unknown>>> {
  return query(
    `SELECT id, step_number, title, description, duration_min, tool_ids, technique_ids, image_url, notes, step_ingredients
     FROM recipe_steps
     WHERE recipe_id = $1
     ORDER BY step_number`,
    [recipeId]
  );
}

async function loadRecipeSteps(recipeId: UUID, lang?: string): Promise<CookSequenceStep[]> {
  const rows = await loadRecipeStepsRaw(recipeId);
  // One read for the section's translations, not one per step.
  const translatedByStepId = new Map<UUID, { title: string | null; description: string | null; notes: string | null }>();
  if (lang && rows.length > 0) {
    for (const batch of chunk(rows.map((r) => r.id as UUID))) {
      const p: unknown[] = [];
      const placeholders = inPlaceholders(p, batch);
      p.push(lang);
      const trRows = await query<{ step_id: UUID; title: string | null; description: string | null; notes: string | null }>(
        `SELECT step_id, title, description, notes FROM recipe_step_translations
         WHERE step_id IN (${placeholders}) AND LOWER(language_code) = LOWER($${p.length})`,
        p
      );
      for (const tr of trRows) translatedByStepId.set(tr.step_id, tr);
    }
  }
  return rows.map((r) => ({
    translatedTitle: translatedByStepId.get(r.id as UUID)?.title ?? null,
    translatedDescription: translatedByStepId.get(r.id as UUID)?.description ?? null,
    translatedNotes: translatedByStepId.get(r.id as UUID)?.notes ?? null,
    id: r.id as UUID,
    stepNumber: r.step_number as number,
    title: (r.title as string) ?? null,
    description: r.description as string,
    durationMin: (r.duration_min as number) ?? null,
    toolIds: JSON.parse((r.tool_ids as string) ?? '[]'),
    techniqueIds: JSON.parse((r.technique_ids as string) ?? '[]'),
    imageUrl: (r.image_url as string) ?? null,
    notes: (r.notes as string) ?? null,
    stepIngredients: JSON.parse((r.step_ingredients as string) ?? '[]'),
  }));
}

/** Resolves the union of technique ids tagged across a section's own steps
 *  into name/icon refs — mirrors loadSectionTools() below, just sourced
 *  from steps[].techniqueIds (an array column on recipe_steps) instead of
 *  a recipe_tools join table, since technique tagging never got one. */
async function loadSectionTechniques(steps: CookSequenceStep[], lang?: string): Promise<CookSequenceTechniqueRef[]> {
  const ids = new Set<UUID>();
  for (const step of steps) for (const id of step.techniqueIds) ids.add(id);
  if (ids.size === 0) return [];

  // One read for the section rather than one per technique — cook mode
  // resolves this for every sub-recipe as well as the main one, so a query
  // per chip multiplies down the whole matrioska tree.
  const byId = new Map<UUID, CookSequenceTechniqueRef>();
  for (const batch of chunk([...ids])) {
    const p: unknown[] = [];
    const placeholders = inPlaceholders(p, batch);
    let nameCol = "name";
    if (lang) {
      p.push(lang);
      nameCol = `COALESCE((SELECT tt.name FROM technique_translations tt
                           WHERE tt.technique_id = techniques.id AND LOWER(tt.language_code) = LOWER($${p.length}) LIMIT 1), name) AS name`;
    }
    const rows = await query<CookSequenceTechniqueRef>(
      `SELECT id, ${nameCol}, icon FROM techniques
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      p
    );
    for (const r of rows) byId.set(r.id, r);
  }
  // Kept in the order the steps mention them, which `IN (...)` does not
  // preserve on its own.
  return [...ids].flatMap((id) => { const r = byId.get(id); return r ? [r] : []; });
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
  const rows = await query<{ sort_order: number; ingredient_name: string; quantity: number | null; unit_symbol: string | null; group_name: string | null }>(
    `SELECT ri.sort_order, ${nameCol} AS ingredient_name,
            ri.quantity, u.symbol AS unit_symbol, ri.group_name
     FROM recipe_ingredients ri
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u ON u.id = ri.unit_id
     WHERE ri.recipe_id = $1
     ORDER BY ri.sort_order`,
    lang ? [recipeId, lang] : [recipeId]
  );
  return rows.map((r) => ({
    sortOrder: r.sort_order,
    ingredientName: r.ingredient_name,
    quantity: r.quantity,
    unitSymbol: r.unit_symbol,
    groupName: r.group_name,
  }));
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
  const techniques = await loadSectionTechniques(steps, lang);
  sections.push({
    recipeId,
    recipeTitle: recipeRow[0]?.title ?? "?",
    isMain,
    steps,
    ingredients,
    tools,
    techniques,
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
  is_optional: number;
  /** Non-null on a row that is an ALTERNATIVE to the row at that
   *  sort_order. Every consumer of this engine — the shopping list, the
   *  nutrition totals, the pantry matcher, the kitchen-mode sequence —
   *  wants the thing you actually cook with, not both halves of an
   *  either/or, so these rows are dropped in loadRecipeIngredients(). */
  substitute_for: number | null;
}

/** Every recipe's rows, read once.
 *
 *  Resolving a single recipe costs one query per node of its sub-recipe
 *  tree, which is right for a recipe page and ruinous for anything that
 *  resolves the whole library: the pantry matcher was issuing well over a
 *  hundred sequential queries on a 49-recipe library, and on Android every
 *  one of them is a native bridge round-trip. Hand this to
 *  calculatePortions() and the same recursion reads from memory instead —
 *  two queries for the entire library, with no second copy of the
 *  resolution rules to drift out of step. */
export interface MatrioskaPreload {
  /** recipe id → its direct rows, in sort order. */
  ingredients: Map<UUID, RawRecipeIngredient[]>;
  /** recipe id → the title and base servings calculatePortions() starts from. */
  recipes: Map<UUID, { title: string; servings: number }>;
}

export async function preloadMatrioska(): Promise<MatrioskaPreload> {
  // Sub-recipes are resolved through here too, so neither query filters on
  // is_component or sync_status — a row the recursion asks for and does not
  // find would silently resolve to nothing.
  const [rows, recipes] = await Promise.all([
    query<RawRecipeIngredient & { recipe_id: UUID }>(
      `SELECT
         ri.recipe_id,
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
       ORDER BY ri.recipe_id, ri.sort_order`
    ),
    query<{ id: UUID; title: string; servings: number }>(
      `SELECT id, title, servings FROM recipes`
    ),
  ]);

  const byRecipe = new Map<UUID, RawRecipeIngredient[]>();
  for (const row of rows) {
    const list = byRecipe.get(row.recipe_id);
    if (list) list.push(row);
    else byRecipe.set(row.recipe_id, [row]);
  }

  return {
    ingredients: byRecipe,
    recipes: new Map(recipes.map((r) => [r.id, { title: r.title, servings: r.servings }])),
  };
}

/**
 * Carica gli ingredienti diretti di una ricetta dal DB
 */
async function loadRecipeIngredients(
  recipeId: UUID,
  preload?: MatrioskaPreload
): Promise<RawRecipeIngredient[]> {
  // A preload is authoritative: a recipe with no ingredients is simply
  // absent from the map, and must read as "no rows" rather than fall back
  // to the query the preload exists to avoid.
  if (preload) return dropSubstitutes(preload.ingredients.get(recipeId) ?? []);
  return dropSubstitutes(await query<RawRecipeIngredient>(
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
  ));
}

/** Drops the "or use margarine instead" rows. They are alternatives to a
 *  sibling row, so counting them would have the shopping list buying both,
 *  the nutrition totals adding both, and the pantry matcher demanding
 *  both. Kept out here, at the one place every caller reads rows through,
 *  rather than in each consumer. */
function dropSubstitutes(rows: RawRecipeIngredient[]): RawRecipeIngredient[] {
  return rows.some(r => r.substitute_for != null)
    ? rows.filter(r => r.substitute_for == null)
    : rows;
}

/**
 * Risolve ricorsivamente tutti gli ingredienti di una ricetta
 * scalando le quantità per il numero di porzioni richieste.
 */
async function resolveIngredients(
  recipeId: UUID,
  requestedServings: number,
  baseServings: number,
  chain: string[],
  depth: number,
  visited: Set<UUID>,
  preload?: MatrioskaPreload
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
  const rows = await loadRecipeIngredients(recipeId, preload);

  const resolved: ResolvedIngredient[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    // ── Ingrediente semplice ────────────────────────────────────────────
    if (row.ingredient_id) {
      if (row.quantity == null && !row.quantity_text) {
        warnings.push(
          `⚠️ Quantità mancante per "${row.ingredient_name}" in ${chain[chain.length - 1] ?? "?"}`
        );
      }

      if (row.quantity_text && row.quantity == null) {
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
          `ℹ️ Quantità vaga "${row.quantity_text}" per "${row.ingredient_name}" in ${chain[chain.length - 1] ?? "?"}`
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
        warnings.push(
          `⚠️ Impossibile convertire l'unità per "${subTitle}" in ${chain[chain.length - 1] ?? "?"} — imposta la resa (yield) della sotto-ricetta nella stessa unità (peso o volume), oppure usa un'unità "porzioni"/nessuna unità.`
        );
        subRequestedServings = row.quantity * scaleFactor;
      } else {
        subRequestedServings = row.quantity != null
          ? row.quantity * scaleFactor
          : requestedServings;
      }

      const sub = await resolveIngredients(
        row.sub_recipe_id,
        subRequestedServings,
        subBaseServings,
        [...chain, subTitle],
        depth + 1,
        new Set(visited),
        preload
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
  requestedServings: number,
  /** Optional rows for the whole library — see preloadMatrioska(). Omit it
   *  when resolving one recipe; pass it when resolving many. */
  preload?: MatrioskaPreload
): Promise<PortionCalculationResult> {
  const recipeRow = preload
    ? preload.recipes.get(recipeId)
    : (await query<{ title: string; servings: number }>(
        "SELECT title, servings FROM recipes WHERE id = $1",
        [recipeId]
      ))[0];

  if (!recipeRow) {
    throw new Error(`Ricetta ${recipeId} non trovata`);
  }

  const { title, servings: baseServings } = recipeRow;

  const { ingredients, warnings } = await resolveIngredients(
    recipeId,
    requestedServings,
    baseServings,
    [title],
    0,
    new Set(),
    preload
  );

  const scaleFactor = baseServings > 0 ? requestedServings / baseServings : 1;
  if (scaleFactor > LARGE_SCALE_FACTOR || scaleFactor < SMALL_SCALE_FACTOR) {
    warnings.push(
      `⚠️ Ricetta scalata di ${scaleFactor.toFixed(2)}x rispetto alla resa originale — i tempi di cottura, le dimensioni di teglie/pentole e alcuni ingredienti (es. lievito, spezie) potrebbero non scalare linearmente. Controlla i passaggi prima di procedere.`
    );
  }

  const aggregated = aggregateIngredients(ingredients);

  return {
    recipeId,
    recipeTitle: title,
    requestedServings,
    resolvedIngredients: aggregated,
    warnings,
  };
}
