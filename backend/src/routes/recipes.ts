// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Ricette
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool";
import { calculatePortions } from "../services/matrioska.engine";
import { parseRecipeWithLLM } from "../services/llm.parser";
import { v4 as uuidv4 } from "uuid";

export const recipeRouter = Router();

// ── Validazione ────────────────────────────────────────────────────────

const RecipeIngredientSchema = z.object({
  sortOrder: z.number().int().default(0),
  ingredientId: z.string().uuid().optional(),
  subtypeId: z.string().uuid().optional(),
  subRecipeId: z.string().uuid().optional(),
  quantity: z.number().positive().optional(),
  quantityText: z.string().optional(),
  unitId: z.string().uuid().optional(),
  notes: z.string().optional(),
  isOptional: z.boolean().default(false),
}).refine(d => d.ingredientId || d.subRecipeId, {
  message: "Deve essere presente ingredientId o subRecipeId",
});

const TranslationSchema = z.object({
  lang: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const StepIngredientRefSchema = z.object({
  ingredientSortOrder: z.number().int().min(0),
  portion: z.number().positive().max(1).default(1),
  notes: z.string().optional(),
});

const RecipeStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().min(1),
  durationMin: z.number().int().positive().optional(),
  toolIds: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
  translations: z.array(TranslationSchema).optional(),
  stepIngredients: z.array(StepIngredientRefSchema).default([]),
});

const CreateRecipeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  difficulty: z.enum(["easy","medium","hard","expert"]).default("medium"),
  servings: z.number().int().positive().default(4),
  prepTimeMin: z.number().int().positive().optional(),
  cookTimeMin: z.number().int().positive().optional(),
  restTimeMin: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
  coverImageUrl: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  isComponent: z.boolean().default(false),
  ingredients: z.array(RecipeIngredientSchema).default([]),
  steps: z.array(RecipeStepSchema).default([]),
  toolIds: z.array(z.string().uuid()).default([]),
  translations: z.array(TranslationSchema).optional(),
});

async function upsertRecipeTranslations(client: PoolClient, recipeId: string, translations?: Array<z.infer<typeof TranslationSchema>>) {
  if (!translations) return;
  await client.query("DELETE FROM recipe_translations WHERE recipe_id=$1", [recipeId]);
  for (const t of translations) {
    if (!t.lang || (!t.title && !t.description)) continue;
    await client.query(
      `INSERT INTO recipe_translations (recipe_id, language_code, title, description) VALUES ($1, $2, $3, $4)`,
      [recipeId, t.lang, t.title || null, t.description || null]
    );
  }
}

async function insertStepTranslations(client: PoolClient, stepId: string, translations?: Array<z.infer<typeof TranslationSchema>>) {
  if (!translations) return;
  for (const t of translations) {
    if (!t.lang || (!t.title && !t.description)) continue;
    await client.query(
      `INSERT INTO recipe_step_translations (step_id, language_code, title, description) VALUES ($1, $2, $3, $4)`,
      [stepId, t.lang, t.title || null, t.description || null]
    );
  }
}

// ── GET /recipes ───────────────────────────────────────────────────────

recipeRouter.get("/", async (req: Request, res: Response) => {
  const { q, tag, difficulty, component, lang } = req.query;

  const params: unknown[] = [];
  let langJoin = "";
  let translatedCols = "NULL AS translated_title, NULL AS translated_description";
  if (lang) {
    params.push(lang);
    langJoin = `LEFT JOIN recipe_translations rt ON rt.recipe_id = r.id AND rt.language_code = $${params.length}`;
    translatedCols = "rt.title AS translated_title, rt.description AS translated_description";
  }

  let sql = `
    SELECT r.*, ${translatedCols},
           COUNT(ri.id) AS ingredient_count
    FROM recipes r
    LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    ${langJoin}
    WHERE r.sync_status != 'deleted'
  `;

  if (q) {
    params.push(`%${q}%`);
    sql += ` AND r.title ILIKE $${params.length}`;
  }
  if (tag) {
    params.push(tag);
    sql += ` AND $${params.length} = ANY(r.tags)`;
  }
  if (difficulty) {
    params.push(difficulty);
    sql += ` AND r.difficulty = $${params.length}`;
  }
  if (component !== undefined) {
    params.push(component === "true");
    sql += ` AND r.is_component = $${params.length}`;
  }

  sql += ` GROUP BY r.id${lang ? ", rt.title, rt.description" : ""} ORDER BY r.updated_at DESC`;

  const recipes = await query(sql, params);
  res.json({ data: recipes, total: recipes.length });
});

// ── GET /recipes/:id ───────────────────────────────────────────────────

recipeRouter.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { lang } = req.query;

  // Salta se non è un UUID valido (es. "new")
  if (!id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(404).json({ error: "ID non valido o non trovato" });
  }

  const params: unknown[] = [id];
  let langJoin = "";
  let translatedCols = "NULL AS translated_title, NULL AS translated_description";
  let stepTranslatedTitle = "NULL";
  let stepTranslatedDescription = "NULL";
  let toolTranslatedName = "NULL";
  let ingredientNameCol = "i.name";
  if (lang) {
    params.push(lang);
    langJoin = `LEFT JOIN recipe_translations rct ON rct.recipe_id = r.id AND rct.language_code = $2`;
    translatedCols = "rct.title AS translated_title, rct.description AS translated_description";
    stepTranslatedTitle = "rst.title";
    stepTranslatedDescription = "rst.description";
    toolTranslatedName = "tt.name";
    ingredientNameCol = "COALESCE(it_lang.translated_name, i.name)";
  }

  const recipe = await queryOne(
    `SELECT r.*, ${translatedCols},
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', ri.id, 'sortOrder', ri.sort_order,
              'ingredientId', ri.ingredient_id,
              'ingredientName', ${ingredientNameCol},
              'subRecipeId', ri.sub_recipe_id,
              'subRecipeTitle', sr.title,
              'quantity', ri.quantity,
              'quantityText', ri.quantity_text,
              'unitSymbol', u.symbol, 'unitId', ri.unit_id,
              'isOptional', ri.is_optional,
              'notes', ri.notes
            )) FILTER (WHERE ri.id IS NOT NULL), '[]'::json) AS ingredients,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', rs.id, 'stepNumber', rs.step_number,
              'title', rs.title, 'description', rs.description,
              'translatedTitle', ${stepTranslatedTitle},
              'translatedDescription', ${stepTranslatedDescription},
              'durationMin', rs.duration_min,
              'toolIds', rs.tool_ids,
              'notes', rs.notes,
              'stepIngredients', rs.step_ingredients
            )) FILTER (WHERE rs.id IS NOT NULL), '[]'::json) AS steps,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', t.id, 'name', t.name, 'icon', t.icon,
              'translated_name', ${toolTranslatedName}
            )) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS tools
     FROM recipes r
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     ${lang ? "LEFT JOIN ingredient_translations it_lang ON it_lang.ingredient_id = i.id AND it_lang.language_code = $2" : ""}
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u ON u.id = ri.unit_id
     LEFT JOIN recipe_steps rs ON rs.recipe_id = r.id
     ${lang ? "LEFT JOIN recipe_step_translations rst ON rst.step_id = rs.id AND rst.language_code = $2" : ""}
     LEFT JOIN recipe_tools rtl ON rtl.recipe_id = r.id
     LEFT JOIN tools t ON t.id = rtl.tool_id
     ${lang ? "LEFT JOIN tool_translations tt ON tt.tool_id = t.id AND tt.language_code = $2" : ""}
     ${langJoin}
     WHERE r.id = $1
     GROUP BY r.id${lang ? ", rct.title, rct.description" : ""}`,
    params
  );


  if (!recipe) return res.status(404).json({ error: "Ricetta non trovata" });
  res.json({ data: recipe });
});

// ── POST /recipes ──────────────────────────────────────────────────────

recipeRouter.post("/", async (req: Request, res: Response) => {
  const parsed = CreateRecipeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const d = parsed.data;
  const recipeId = uuidv4();

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO recipes (id,title,description,difficulty,servings,prep_time_min,
           cook_time_min,rest_time_min,tags,cover_image_url,source_url,is_component,crdt_clock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}')`,
        [recipeId,d.title,d.description,d.difficulty,d.servings,d.prepTimeMin,
         d.cookTimeMin,d.restTimeMin,d.tags,d.coverImageUrl,d.sourceUrl,d.isComponent]
      );

      // Inserisci ingredienti
      for (const ing of d.ingredients) {
        await client.query(
          `INSERT INTO recipe_ingredients
             (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
              quantity,quantity_text,unit_id,notes,is_optional)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [uuidv4(),recipeId,ing.sortOrder,ing.ingredientId??null,
           ing.subtypeId??null,ing.subRecipeId??null,ing.quantity??null,
           ing.quantityText??null,ing.unitId??null,ing.notes??null,ing.isOptional]
        );
      }

      // Inserisci step
      for (const step of d.steps) {
        const stepId = uuidv4();
        await client.query(
          `INSERT INTO recipe_steps
             (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,step_ingredients)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [stepId,recipeId,step.stepNumber,step.title??null,
           step.description,step.durationMin??null,step.toolIds??[],step.notes??null,
           JSON.stringify(step.stepIngredients)]
        );
        await insertStepTranslations(client, stepId, step.translations);
      }

      // Associa strumenti
      for (const toolId of d.toolIds) {
        await client.query(
          "INSERT INTO recipe_tools (recipe_id,tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [recipeId, toolId]
        );
      }

      await upsertRecipeTranslations(client, recipeId, d.translations);
    });
  } catch (err) {
    console.error("Recipe create failed:", err);
    return res.status(500).json({ error: "Impossibile creare la ricetta" });
  }

  res.status(201).json({ data: { id: recipeId } });
});

// ── GET /recipes/:id/portions?servings=N ─────────────────────────────

recipeRouter.get("/:id/portions", async (req: Request, res: Response) => {
  const servings = parseInt(String(req.query.servings ?? "4"), 10);
  if (isNaN(servings) || servings < 1 || servings > 1000) {
    return res.status(400).json({ error: "servings deve essere tra 1 e 1000" });
  }

  const result = await calculatePortions(req.params.id, servings);
  res.json({ data: result });
});

// ── POST /recipes/parse (LLM) ─────────────────────────────────────────

recipeRouter.post("/parse", async (req: Request, res: Response) => {
  const schema = z.object({
    input: z.string().min(1),
    inputType: z.enum(["url", "text"]),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const result = await parseRecipeWithLLM(parsed.data);
  res.json({ data: result });
});

// ── PUT /recipes/:id ──────────────────────────────────────────────────

recipeRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = CreateRecipeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const d = parsed.data;

  try {
    await withTransaction(async (client) => {
      // Update ricetta principale
      await client.query(
        `UPDATE recipes SET
           title=$2, description=$3, difficulty=$4, servings=$5,
           prep_time_min=$6, cook_time_min=$7, rest_time_min=$8,
           tags=$9, cover_image_url=$10, source_url=$11, is_component=$12,
           updated_at=now()
         WHERE id=$1`,
        [id, d.title, d.description, d.difficulty, d.servings, d.prepTimeMin,
         d.cookTimeMin, d.restTimeMin, d.tags, d.coverImageUrl, d.sourceUrl, d.isComponent]
      );

      // Rimpiazza ingredienti (drop + reinsert)
      await client.query("DELETE FROM recipe_ingredients WHERE recipe_id=$1", [id]);
      for (const ing of d.ingredients) {
        await client.query(
          `INSERT INTO recipe_ingredients
             (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
              quantity,quantity_text,unit_id,notes,is_optional)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [uuidv4(), id, ing.sortOrder, ing.ingredientId??null,
           ing.subtypeId??null, ing.subRecipeId??null, ing.quantity??null,
           ing.quantityText??null, ing.unitId??null, ing.notes??null, ing.isOptional]
        );
      }

      // Rimpiazza steps (drop + reinsert; recipe_step_translations cascade with them)
      await client.query("DELETE FROM recipe_steps WHERE recipe_id=$1", [id]);
      for (const step of d.steps) {
        const stepId = uuidv4();
        await client.query(
          `INSERT INTO recipe_steps
             (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,step_ingredients)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [stepId, id, step.stepNumber, step.title??null,
           step.description, step.durationMin??null, step.toolIds??[], step.notes??null,
           JSON.stringify(step.stepIngredients)]
        );
        await insertStepTranslations(client, stepId, step.translations);
      }

      // Rimpiazza tools
      await client.query("DELETE FROM recipe_tools WHERE recipe_id=$1", [id]);
      for (const toolId of d.toolIds) {
        await client.query(
          "INSERT INTO recipe_tools (recipe_id,tool_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [id, toolId]
        );
      }

      await upsertRecipeTranslations(client, id, d.translations);
    });
  } catch (err) {
    console.error("Recipe update failed:", err);
    return res.status(500).json({ error: "Impossibile aggiornare la ricetta" });
  }

  res.json({ data: { id } });
});

// ── DELETE /recipes/:id ────────────────────────────────────────────────

recipeRouter.delete("/:id", async (req: Request, res: Response) => {
  await query(
    "UPDATE recipes SET sync_status='deleted', updated_at=now() WHERE id=$1",
    [req.params.id]
  );
  res.status(204).send();
});
