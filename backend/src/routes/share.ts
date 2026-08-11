// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Share (file-based recipe/collection export & import)
// Packages a recipe (or several, or a whole collection) — together with the
// ingredients/tools it actually depends on — into a portable JSON bundle,
// so one SmartChef instance can hand a recipe to a completely separate
// instance and it imports cleanly. Sub-recipes (Matrioska) are walked
// recursively so a composed recipe stays runnable after import. Tags are
// carried as plain strings (recipes.tags is already just TEXT[] of names —
// no catalog round-trip needed, the target's own tag catalog resolves
// matching names and unknown ones degrade to a plain chip, same as any
// legacy free-text tag). Techniques aren't included: nothing in the schema
// links a recipe/step to a technique row, so there's nothing structural to
// recreate for them.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool";
import { similarity } from "../services/ingredient.matcher";
import { computeAutoTagNames, unionTagNames } from "../services/tags.service";
import { v4 as uuidv4 } from "uuid";

export const shareRouter = Router();

const FORMAT_VERSION = 1;

// ── Bundle shape ──────────────────────────────────────────────────────

interface BundleIngredient {
  id: string;
  name: string;
  categoryName: string;
  description: string | null;
  densityGPerMl: number | null;
  defaultUnit: string | null;
  imageUrls: string[];
  icon: string | null;
  caloriesKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
  translations: Array<{ lang: string; name: string }>;
}

interface BundleTool {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  imageUrls: string[];
  translations: Array<{ lang: string; name?: string | null; description?: string | null }>;
}

interface BundleRecipeIngredient {
  sortOrder: number;
  ingredientId?: string;
  subRecipeId?: string;
  quantity: number | null;
  quantityText: string | null;
  unitSymbol: string | null;
  notes: string | null;
  isOptional: boolean;
}

interface BundleRecipeStep {
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: string[];
  notes: string | null;
  imageUrl: string | null;
  stepIngredients: unknown;
  translations: Array<{ lang: string; title?: string | null; description?: string | null }>;
}

interface BundleRecipe {
  id: string;
  title: string;
  description: string | null;
  difficulty: string;
  servings: number;
  prepTimeMin: number | null;
  cookTimeMin: number | null;
  restTimeMin: number | null;
  rating: number | null;
  tags: string[];
  coverImageUrl: string | null;
  sourceUrl: string | null;
  sources: unknown[];
  isComponent: boolean;
  languageCode: string | null;
  ingredients: BundleRecipeIngredient[];
  steps: BundleRecipeStep[];
  toolIds: string[];
  translations: Array<{ lang: string; title?: string | null; description?: string | null }>;
}

interface Bundle {
  formatVersion: number;
  exportedAt: string;
  recipes: BundleRecipe[];
  ingredients: BundleIngredient[];
  tools: BundleTool[];
}

// ── Export ────────────────────────────────────────────────────────────

/** Walks sub_recipe_id references, returning recipe ids in dependency
 *  (child-before-parent) order so replaying them at import time never
 *  references a not-yet-created recipe. */
async function collectRecipeClosure(rootIds: string[]): Promise<string[]> {
  const visited = new Set<string>();
  const order: string[] = [];

  async function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const subRows = await query<{ sub_recipe_id: string }>(
      `SELECT DISTINCT sub_recipe_id FROM recipe_ingredients
       WHERE recipe_id=$1 AND sub_recipe_id IS NOT NULL`,
      [id]
    );
    for (const row of subRows) await visit(row.sub_recipe_id);
    order.push(id);
  }

  for (const id of rootIds) await visit(id);
  return order;
}

async function loadBundleRecipe(id: string): Promise<BundleRecipe> {
  const r = await queryOne<any>("SELECT * FROM recipes WHERE id=$1", [id]);
  if (!r) throw new Error(`Recipe ${id} not found`);

  const ingredientRows = await query<any>(
    `SELECT ri.sort_order, ri.ingredient_id, ri.sub_recipe_id, ri.quantity, ri.quantity_text,
            ri.notes, ri.is_optional, u.symbol AS unit_symbol
     FROM recipe_ingredients ri LEFT JOIN units u ON u.id = ri.unit_id
     WHERE ri.recipe_id=$1 ORDER BY ri.sort_order`,
    [id]
  );

  const stepRows = await query<any>(
    `SELECT id, step_number, title, description, duration_min, tool_ids, notes, image_url, step_ingredients
     FROM recipe_steps WHERE recipe_id=$1 ORDER BY step_number`,
    [id]
  );
  const steps: BundleRecipeStep[] = [];
  for (const s of stepRows) {
    const translations = await query<any>(
      "SELECT language_code AS lang, title, description FROM recipe_step_translations WHERE step_id=$1",
      [s.id]
    );
    steps.push({
      stepNumber: s.step_number,
      title: s.title,
      description: s.description,
      durationMin: s.duration_min,
      toolIds: s.tool_ids ?? [],
      notes: s.notes,
      imageUrl: s.image_url,
      stepIngredients: s.step_ingredients ?? [],
      translations,
    });
  }

  const toolRows = await query<{ tool_id: string }>(
    "SELECT tool_id FROM recipe_tools WHERE recipe_id=$1", [id]
  );
  const translations = await query<any>(
    "SELECT language_code AS lang, title, description FROM recipe_translations WHERE recipe_id=$1", [id]
  );

  return {
    id: r.id,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    servings: r.servings,
    prepTimeMin: r.prep_time_min,
    cookTimeMin: r.cook_time_min,
    restTimeMin: r.rest_time_min,
    rating: r.rating,
    tags: r.tags ?? [],
    coverImageUrl: r.cover_image_url,
    sourceUrl: r.source_url,
    sources: r.sources ?? [],
    isComponent: r.is_component,
    languageCode: r.language_code,
    ingredients: ingredientRows.map((i: any) => ({
      sortOrder: i.sort_order,
      ingredientId: i.ingredient_id ?? undefined,
      subRecipeId: i.sub_recipe_id ?? undefined,
      // recipe_ingredients.quantity is NUMERIC — node-pg returns numeric
      // columns as strings to avoid precision loss, so this must be
      // parsed explicitly or the import-side Zod schema rejects it.
      quantity: i.quantity !== null ? Number(i.quantity) : null,
      quantityText: i.quantity_text,
      unitSymbol: i.unit_symbol,
      notes: i.notes,
      isOptional: i.is_optional,
    })),
    steps,
    toolIds: toolRows.map((t) => t.tool_id),
    translations,
  };
}

async function loadBundleIngredient(id: string): Promise<BundleIngredient> {
  const row = await queryOne<any>(
    `SELECT i.*, c.name AS category_name FROM ingredients i
     JOIN ingredient_categories c ON c.id = i.category_id WHERE i.id=$1`,
    [id]
  );
  const translations = await query<any>(
    "SELECT language_code AS lang, translated_name AS name FROM ingredient_translations WHERE ingredient_id=$1",
    [id]
  );
  return {
    id: row.id,
    name: row.name,
    categoryName: row.category_name,
    description: row.description,
    densityGPerMl: row.density_g_per_ml !== null ? Number(row.density_g_per_ml) : null,
    defaultUnit: row.default_unit,
    imageUrls: row.image_urls ?? [],
    icon: row.icon,
    caloriesKcal: row.calories_kcal !== null ? Number(row.calories_kcal) : null,
    proteinG: row.protein_g !== null ? Number(row.protein_g) : null,
    carbsG: row.carbs_g !== null ? Number(row.carbs_g) : null,
    fatG: row.fat_g !== null ? Number(row.fat_g) : null,
    fiberG: row.fiber_g !== null ? Number(row.fiber_g) : null,
    sugarG: row.sugar_g !== null ? Number(row.sugar_g) : null,
    sodiumMg: row.sodium_mg !== null ? Number(row.sodium_mg) : null,
    translations,
  };
}

async function loadBundleTool(id: string): Promise<BundleTool> {
  const row = await queryOne<any>("SELECT * FROM tools WHERE id=$1", [id]);
  const translations = await query<any>(
    "SELECT language_code AS lang, name, description FROM tool_translations WHERE tool_id=$1",
    [id]
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    imageUrls: row.image_urls ?? [],
    translations,
  };
}

async function buildBundle(rootRecipeIds: string[]): Promise<Bundle> {
  const recipeIds = await collectRecipeClosure(rootRecipeIds);
  const recipes: BundleRecipe[] = [];
  for (const id of recipeIds) recipes.push(await loadBundleRecipe(id));

  const ingredientIds = new Set<string>();
  const toolIds = new Set<string>();
  for (const r of recipes) {
    for (const ing of r.ingredients) if (ing.ingredientId) ingredientIds.add(ing.ingredientId);
    for (const tid of r.toolIds) toolIds.add(tid);
    for (const s of r.steps) for (const tid of s.toolIds) toolIds.add(tid);
  }

  const ingredients: BundleIngredient[] = [];
  for (const id of ingredientIds) ingredients.push(await loadBundleIngredient(id));
  const tools: BundleTool[] = [];
  for (const id of toolIds) tools.push(await loadBundleTool(id));

  return { formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), recipes, ingredients, tools };
}

shareRouter.get("/recipes/:id/export", async (req: Request, res: Response) => {
  const exists = await queryOne("SELECT id FROM recipes WHERE id=$1 AND sync_status != 'deleted'", [req.params.id]);
  if (!exists) return res.status(404).json({ error: "Ricetta non trovata" });
  const bundle = await buildBundle([req.params.id]);
  res.json({ data: bundle });
});

const ExportBulkSchema = z.object({ recipeIds: z.array(z.string().uuid()).min(1) });

shareRouter.post("/recipes/export-bulk", async (req: Request, res: Response) => {
  const parsed = ExportBulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const bundle = await buildBundle(parsed.data.recipeIds);
  res.json({ data: bundle });
});

shareRouter.get("/collections/:id/export", async (req: Request, res: Response) => {
  const recipeRows = await query<{ recipe_id: string }>(
    "SELECT recipe_id FROM collection_recipes WHERE collection_id=$1 ORDER BY sort_order",
    [req.params.id]
  );
  if (!recipeRows.length) return res.status(404).json({ error: "Collezione non trovata o vuota" });
  const bundle = await buildBundle(recipeRows.map((r) => r.recipe_id));
  res.json({ data: bundle });
});

// ── Import ────────────────────────────────────────────────────────────

const BundleIngredientSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  categoryName: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  densityGPerMl: z.number().optional().nullable(),
  defaultUnit: z.string().optional().nullable(),
  imageUrls: z.array(z.string()).optional().nullable(),
  icon: z.string().optional().nullable(),
  caloriesKcal: z.number().optional().nullable(),
  proteinG: z.number().optional().nullable(),
  carbsG: z.number().optional().nullable(),
  fatG: z.number().optional().nullable(),
  fiberG: z.number().optional().nullable(),
  sugarG: z.number().optional().nullable(),
  sodiumMg: z.number().optional().nullable(),
  translations: z.array(z.object({ lang: z.string(), name: z.string().optional().nullable() })).optional(),
});

const BundleToolSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  imageUrls: z.array(z.string()).optional().nullable(),
  translations: z.array(z.object({
    lang: z.string(), name: z.string().optional().nullable(), description: z.string().optional().nullable(),
  })).optional(),
});

const BundleRecipeIngredientSchema = z.object({
  sortOrder: z.number().default(0),
  ingredientId: z.string().optional(),
  subRecipeId: z.string().optional(),
  quantity: z.number().optional().nullable(),
  quantityText: z.string().optional().nullable(),
  unitSymbol: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isOptional: z.boolean().default(false),
});

const BundleRecipeStepSchema = z.object({
  stepNumber: z.number(),
  title: z.string().optional().nullable(),
  description: z.string().min(1),
  durationMin: z.number().optional().nullable(),
  toolIds: z.array(z.string()).optional(),
  notes: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  stepIngredients: z.any().optional(),
  translations: z.array(z.object({
    lang: z.string(), title: z.string().optional().nullable(), description: z.string().optional().nullable(),
  })).optional(),
});

const BundleRecipeSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  difficulty: z.enum(["easy", "medium", "hard", "expert"]).default("medium"),
  servings: z.number().int().positive().default(4),
  prepTimeMin: z.number().optional().nullable(),
  cookTimeMin: z.number().optional().nullable(),
  restTimeMin: z.number().optional().nullable(),
  rating: z.number().int().min(0).max(5).optional().nullable(),
  tags: z.array(z.string()).default([]),
  coverImageUrl: z.string().optional().nullable(),
  sourceUrl: z.string().optional().nullable(),
  sources: z.array(z.any()).default([]),
  isComponent: z.boolean().default(false),
  languageCode: z.string().optional().nullable(),
  ingredients: z.array(BundleRecipeIngredientSchema).default([]),
  steps: z.array(BundleRecipeStepSchema).default([]),
  toolIds: z.array(z.string()).default([]),
  translations: z.array(z.object({
    lang: z.string(), title: z.string().optional().nullable(), description: z.string().optional().nullable(),
  })).optional(),
});

const BundleSchema = z.object({
  formatVersion: z.number(),
  exportedAt: z.string().optional(),
  recipes: z.array(BundleRecipeSchema).min(1),
  ingredients: z.array(BundleIngredientSchema).default([]),
  tools: z.array(BundleToolSchema).default([]),
});

async function matchOrCreateIngredient(
  client: PoolClient,
  ing: z.infer<typeof BundleIngredientSchema>
): Promise<{ targetId: string; isNew: boolean; confidence: number }> {
  const exact = await client.query<{ id: string }>(
    "SELECT id FROM ingredients WHERE LOWER(name)=LOWER($1) AND sync_status != 'deleted' LIMIT 1",
    [ing.name]
  );
  if (exact.rows[0]) return { targetId: exact.rows[0].id, isNew: false, confidence: 1 };

  const all = await client.query<{ id: string; name: string }>(
    "SELECT id, name FROM ingredients WHERE sync_status != 'deleted'"
  );
  let best: { id: string; score: number } | null = null;
  for (const row of all.rows) {
    const score = similarity(ing.name, row.name);
    if (score > 0.7 && (!best || score > best.score)) best = { id: row.id, score };
  }
  if (best) return { targetId: best.id, isNew: false, confidence: best.score };

  const categoryName = ing.categoryName || "Altro";
  let categoryRow = await client.query<{ id: string }>(
    "SELECT id FROM ingredient_categories WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1",
    [categoryName]
  );
  if (!categoryRow.rows[0]) {
    const newCategoryId = uuidv4();
    await client.query(
      "INSERT INTO ingredient_categories (id, name) VALUES ($1, $2) ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING",
      [newCategoryId, categoryName]
    );
    categoryRow = await client.query<{ id: string }>(
      "SELECT id FROM ingredient_categories WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1",
      [categoryName]
    );
  }
  const categoryId = categoryRow.rows[0].id;

  const newId = uuidv4();
  await client.query(
    `INSERT INTO ingredients (id, category_id, name, description, density_g_per_ml, default_unit, image_urls, icon,
       calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (category_id, name) DO NOTHING`,
    [newId, categoryId, ing.name, ing.description ?? null, ing.densityGPerMl ?? null, ing.defaultUnit ?? null,
     ing.imageUrls ?? [], ing.icon ?? null, ing.caloriesKcal ?? null, ing.proteinG ?? null, ing.carbsG ?? null,
     ing.fatG ?? null, ing.fiberG ?? null, ing.sugarG ?? null, ing.sodiumMg ?? null]
  );
  const finalRow = await client.query<{ id: string }>(
    "SELECT id FROM ingredients WHERE LOWER(name)=LOWER($1) LIMIT 1", [ing.name]
  );
  const finalId = finalRow.rows[0]?.id ?? newId;

  for (const t of ing.translations ?? []) {
    if (!t.lang || !t.name) continue;
    await client.query(
      `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name)
       VALUES ($1,$2,$3) ON CONFLICT (ingredient_id, language_code) DO NOTHING`,
      [finalId, t.lang, t.name]
    );
  }

  return { targetId: finalId, isNew: true, confidence: 1 };
}

async function matchOrCreateTool(
  client: PoolClient,
  tool: z.infer<typeof BundleToolSchema>
): Promise<{ targetId: string; isNew: boolean }> {
  const exact = await client.query<{ id: string }>(
    "SELECT id FROM tools WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1", [tool.name]
  );
  if (exact.rows[0]) return { targetId: exact.rows[0].id, isNew: false };

  const all = await client.query<{ id: string; name: string }>("SELECT id, name FROM tools WHERE deleted_at IS NULL");
  let best: { id: string; score: number } | null = null;
  for (const row of all.rows) {
    const score = similarity(tool.name, row.name);
    if (score > 0.7 && (!best || score > best.score)) best = { id: row.id, score };
  }
  if (best) return { targetId: best.id, isNew: false };

  const newId = uuidv4();
  await client.query(
    `INSERT INTO tools (id, name, description, icon, category, image_urls) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING`,
    [newId, tool.name, tool.description ?? null, tool.icon ?? null, tool.category ?? null, tool.imageUrls ?? []]
  );
  const finalRow = await client.query<{ id: string }>(
    "SELECT id FROM tools WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1", [tool.name]
  );
  const finalId = finalRow.rows[0]?.id ?? newId;

  for (const t of tool.translations ?? []) {
    if (!t.lang || !t.name) continue;
    await client.query(
      `INSERT INTO tool_translations (tool_id, language_code, name, description)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tool_id, language_code) DO NOTHING`,
      [finalId, t.lang, t.name, t.description ?? null]
    );
  }

  return { targetId: finalId, isNew: true };
}

async function createRecipeFromBundle(
  client: PoolClient,
  r: z.infer<typeof BundleRecipeSchema>,
  ingredientIdMap: Map<string, string>,
  toolIdMap: Map<string, string>,
  recipeIdMap: Map<string, string>
): Promise<string> {
  const newRecipeId = uuidv4();
  await client.query(
    `INSERT INTO recipes (id,title,description,difficulty,servings,prep_time_min,cook_time_min,rest_time_min,rating,
       tags,cover_image_url,source_url,sources,is_component,language_code,crdt_clock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'{}')`,
    [newRecipeId, r.title, r.description ?? null, r.difficulty, r.servings, r.prepTimeMin ?? null,
     r.cookTimeMin ?? null, r.restTimeMin ?? null, r.rating ?? null, r.tags ?? [], r.coverImageUrl ?? null, r.sourceUrl ?? null,
     JSON.stringify(r.sources ?? []), r.isComponent, r.languageCode ?? null]
  );

  for (const ing of r.ingredients) {
    const targetIngredientId = ing.ingredientId ? ingredientIdMap.get(ing.ingredientId) ?? null : null;
    const targetSubRecipeId = ing.subRecipeId ? recipeIdMap.get(ing.subRecipeId) ?? null : null;
    if (!targetIngredientId && !targetSubRecipeId) continue; // dangling reference, skip defensively

    let unitId: string | null = null;
    if (ing.unitSymbol) {
      const u = await client.query<{ id: string }>("SELECT id FROM units WHERE symbol=$1", [ing.unitSymbol]);
      unitId = u.rows[0]?.id ?? null;
    }

    await client.query(
      `INSERT INTO recipe_ingredients (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
         quantity,quantity_text,unit_id,notes,is_optional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), newRecipeId, ing.sortOrder, targetIngredientId, null, targetSubRecipeId,
       ing.quantity ?? null, ing.quantityText ?? null, unitId, ing.notes ?? null, ing.isOptional]
    );
  }

  for (const step of r.steps) {
    const stepId = uuidv4();
    const remappedToolIds = (step.toolIds ?? [])
      .map((tid) => toolIdMap.get(tid))
      .filter((x): x is string => !!x);
    await client.query(
      `INSERT INTO recipe_steps (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,image_url,step_ingredients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [stepId, newRecipeId, step.stepNumber, step.title ?? null, step.description, step.durationMin ?? null,
       remappedToolIds, step.notes ?? null, step.imageUrl ?? null, JSON.stringify(step.stepIngredients ?? [])]
    );
    for (const t of step.translations ?? []) {
      if (!t.lang || (!t.title && !t.description)) continue;
      await client.query(
        "INSERT INTO recipe_step_translations (step_id, language_code, title, description) VALUES ($1,$2,$3,$4)",
        [stepId, t.lang, t.title ?? null, t.description ?? null]
      );
    }
  }

  const remappedToolIds = new Set<string>();
  for (const tid of r.toolIds ?? []) {
    const mapped = toolIdMap.get(tid);
    if (mapped) remappedToolIds.add(mapped);
  }
  for (const toolId of remappedToolIds) {
    await client.query(
      "INSERT INTO recipe_tools (recipe_id,tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [newRecipeId, toolId]
    );
  }

  for (const t of r.translations ?? []) {
    if (!t.lang || (!t.title && !t.description)) continue;
    await client.query(
      "INSERT INTO recipe_translations (recipe_id, language_code, title, description) VALUES ($1,$2,$3,$4)",
      [newRecipeId, t.lang, t.title ?? null, t.description ?? null]
    );
  }

  const autoTags = await computeAutoTagNames(client, newRecipeId);
  const finalTags = unionTagNames(r.tags ?? [], autoTags);
  await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, newRecipeId]);

  return newRecipeId;
}

shareRouter.post("/recipes/import-bundle", async (req: Request, res: Response) => {
  const parsed = BundleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const bundle = parsed.data;
  if (bundle.formatVersion !== FORMAT_VERSION) {
    return res.status(400).json({ error: `Versione del file non supportata (${bundle.formatVersion})` });
  }

  const matchedIngredients: Array<{ ingredientId: string; ingredientName: string; confidence: number; isNew: boolean }> = [];
  const matchedTools: Array<{ toolId: string; toolName: string; isNew: boolean }> = [];
  const warnings: string[] = [];
  const createdRecipeIds: string[] = [];

  try {
    await withTransaction(async (client) => {
      const ingredientIdMap = new Map<string, string>();
      for (const ing of bundle.ingredients) {
        const { targetId, isNew, confidence } = await matchOrCreateIngredient(client, ing);
        ingredientIdMap.set(ing.id, targetId);
        matchedIngredients.push({ ingredientId: targetId, ingredientName: ing.name, confidence, isNew });
        if (isNew) warnings.push(`🆕 Nuovo ingrediente creato: "${ing.name}"`);
        else if (confidence < 0.9) {
          warnings.push(`ℹ️ "${ing.name}" mappato a un ingrediente esistente (similarità: ${(confidence * 100).toFixed(0)}%)`);
        }
      }

      const toolIdMap = new Map<string, string>();
      for (const tool of bundle.tools) {
        const { targetId, isNew } = await matchOrCreateTool(client, tool);
        toolIdMap.set(tool.id, targetId);
        matchedTools.push({ toolId: targetId, toolName: tool.name, isNew });
        if (isNew) warnings.push(`🆕 Nuovo strumento creato: "${tool.name}"`);
      }

      const recipeIdMap = new Map<string, string>();
      for (const r of bundle.recipes) {
        const newId = await createRecipeFromBundle(client, r, ingredientIdMap, toolIdMap, recipeIdMap);
        recipeIdMap.set(r.id, newId);
        createdRecipeIds.push(newId);
      }
    });
  } catch (err) {
    console.error("Bundle import failed:", err);
    return res.status(500).json({ error: "Impossibile importare il file" });
  }

  res.status(201).json({
    data: { recipeIds: createdRecipeIds, matchedIngredients, matchedTools, warnings },
  });
});
