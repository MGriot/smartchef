// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Ricette
// ════════════════════════════════════════════════════════════════════════

import express, { Router, Request, Response } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/pool";
import { calculatePortions, resolveCookSequence } from "../services/matrioska.engine";
import { calculateRecipeNutrition } from "../services/nutrition.service";
import { computeAutoTagNames, unionTagNames } from "../services/tags.service";
import { parseRecipeWithLLM, translateRecipeContent, fetchUrlHtml, MediaNotSupportedError } from "../services/llm.parser";
import { filterByPantry } from "../services/pantry.service";
import { proposeIngredientMatches, proposeToolMatches, proposeTechniqueMatches } from "../services/ingredient.matcher";
import { v4 as uuidv4 } from "uuid";

export const recipeRouter = Router();

// ── Validazione ────────────────────────────────────────────────────────

const IngredientNoteTranslationSchema = z.object({
  lang: z.string(),
  notes: z.string().optional().nullable(),
});

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
  groupName: z.string().optional().nullable(),
  /** sort_order of the ingredient this row is an alternative to — see
   *  db/migrations/042_recipe_ingredient_substitutes.sql. */
  substituteFor: z.number().int().min(0).optional().nullable(),
  translations: z.array(IngredientNoteTranslationSchema).optional(),
}).refine(d => d.ingredientId || d.subRecipeId, {
  message: "Deve essere presente ingredientId o subRecipeId",
});

const RecipeSourceSchema = z.object({
  type: z.enum(["url", "book", "video", "other"]).default("url"),
  label: z.string().optional(),
  url: z.string().optional(),
}).refine(d => d.label || d.url, {
  message: "Deve essere presente label o url",
});

const TranslationSchema = z.object({
  lang: z.string(),
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const StepIngredientRefSchema = z.object({
  ingredientSortOrder: z.number().int().min(0),
  amountMode: z.enum(["fraction", "absolute"]).default("fraction"),
  portion: z.number().positive().max(1).default(1),
  quantity: z.number().positive().optional(),
  unitId: z.string().uuid().optional(),
  unitSymbol: z.string().optional(),
  notes: z.string().optional(),
});

const RecipeStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  title: z.string().optional().nullable(),
  description: z.string().min(1),
  durationMin: z.number().int().positive().optional().nullable(),
  toolIds: z.array(z.string().uuid()).optional(),
  techniqueIds: z.array(z.string().uuid()).optional(),
  notes: z.string().optional().nullable(),
  imageUrl: z.string().nullable().optional(),
  translations: z.array(TranslationSchema).optional(),
  stepIngredients: z.array(StepIngredientRefSchema).default([]),
});

const CreateRecipeSchema = z.object({
  // Optional client-supplied id — lets a native client that queued this
  // create while offline hand back a stable id immediately (used by the
  // offline outbox in frontend/src/lib/api.ts) instead of only finding out
  // the real id once the queued request actually replays.
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  difficulty: z.enum(["easy","medium","hard","expert"]).default("medium"),
  servings: z.number().int().positive().default(4),
  prepTimeMin: z.number().int().positive().optional().nullable(),
  cookTimeMin: z.number().int().positive().optional().nullable(),
  restTimeMin: z.number().int().positive().optional().nullable(),
  rating: z.number().int().min(0).max(5).optional().nullable(),
  yieldAmount: z.number().positive().optional().nullable(),
  yieldUnitId: z.string().uuid().optional().nullable(),
  tags: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  // Keyed by lowercased region label — coords for free-text regions
  // (e.g. "sardinia") resolved via /api/geocode; country entries don't
  // need this, their centroid comes from the static countries.ts list.
  regionCoords: z.record(z.object({ lat: z.number(), lng: z.number() })).default({}),
  coverImageUrl: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  sources: z.array(RecipeSourceSchema).default([]),
  isComponent: z.boolean().default(false),
  languageCode: z.string().optional().describe("Language the base title/description/steps were authored in, e.g. 'en'"),
  storageInstructions: z.string().optional().nullable(),
  tips: z.string().optional().nullable(),
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
    if (!t.lang || (!t.title && !t.description && !t.notes)) continue;
    await client.query(
      `INSERT INTO recipe_step_translations (step_id, language_code, title, description, notes) VALUES ($1, $2, $3, $4, $5)`,
      [stepId, t.lang, t.title || null, t.description || null, t.notes || null]
    );
  }
}

async function insertIngredientTranslations(client: PoolClient, recipeIngredientId: string, translations?: Array<z.infer<typeof IngredientNoteTranslationSchema>>) {
  if (!translations) return;
  for (const t of translations) {
    if (!t.lang || !t.notes) continue;
    await client.query(
      `INSERT INTO recipe_ingredient_translations (recipe_ingredient_id, language_code, notes) VALUES ($1, $2, $3)`,
      [recipeIngredientId, t.lang, t.notes]
    );
  }
}

// ── GET /recipes ───────────────────────────────────────────────────────

const SORT_OPTIONS: Record<string, string> = {
  "recently-edited": "r.updated_at DESC",
  "newest": "r.created_at DESC",
  "oldest": "r.created_at ASC",
  "alphabetical": "r.title ASC",
};

recipeRouter.get("/", async (req: Request, res: Response) => {
  const { q, tag, tags, ingredientCategories, regions, difficulty, component, lang, sort, seasonalOnly, seasonalMonth } = req.query;

  const params: unknown[] = [];
  let langJoin = "";
  let translatedCols = "NULL AS translated_title, NULL AS translated_description";
  let langParamIndex: number | null = null;
  if (lang) {
    params.push(lang);
    langParamIndex = params.length;
    langJoin = `LEFT JOIN recipe_translations rt ON rt.recipe_id = r.id AND rt.language_code = $${langParamIndex}`;
    translatedCols = "rt.title AS translated_title, rt.description AS translated_description";
  }

  const tagsDisplaySql = `
    COALESCE(
      (SELECT json_agg(json_build_object(
         'name', tag_name,
         'translated_name', COALESCE(${langParamIndex ? `tt.name` : "NULL"}, t.name, tag_name),
         'color', t.color
       ))
       FROM unnest(r.tags) AS tag_name
       LEFT JOIN tags t ON lower(t.name) = lower(tag_name)
       ${langParamIndex ? `LEFT JOIN tag_translations tt ON tt.tag_id = t.id AND tt.language_code = $${langParamIndex}` : ""}
      ), '[]'::json
    ) AS tags_display`;

  let sql = `
    SELECT r.*, ${translatedCols}, ${tagsDisplaySql},
           COUNT(ri.id) AS ingredient_count,
           acc.name AS creator_name, acc.avatar_url AS creator_avatar_url
    FROM recipes r
    LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    LEFT JOIN account acc ON acc.id = r.creator_id
    ${langJoin}
    WHERE r.sync_status != 'deleted'
  `;

  if (q) {
    params.push(`%${q}%`);
    const p = params.length;
    sql += ` AND (
      r.title ILIKE $${p} OR r.description ILIKE $${p} OR EXISTS (
        SELECT 1 FROM recipe_ingredients qri
        JOIN ingredients qi ON qi.id = qri.ingredient_id
        LEFT JOIN ingredient_translations qit ON qit.ingredient_id = qi.id
        WHERE qri.recipe_id = r.id AND (qi.name ILIKE $${p} OR qit.translated_name ILIKE $${p})
      )
    )`;
  }
  if (ingredientCategories) {
    const catList = String(ingredientCategories).split(",").map(c => c.trim()).filter(Boolean);
    if (catList.length > 0) {
      params.push(catList);
      sql += ` AND EXISTS (
        SELECT 1 FROM recipe_ingredients cri
        JOIN ingredients ci ON ci.id = cri.ingredient_id
        WHERE cri.recipe_id = r.id AND ci.category_id = ANY($${params.length}::uuid[])
      )`;
    }
  }
  if (tag) {
    params.push(tag);
    sql += ` AND $${params.length} = ANY(r.tags)`;
  }
  if (tags) {
    const tagList = String(tags).split(",").map(t => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      params.push(tagList);
      sql += ` AND EXISTS (SELECT 1 FROM unnest(r.tags) rt_name WHERE lower(rt_name) = ANY(SELECT lower(unnest($${params.length}::text[]))))`;
    }
  }
  if (regions) {
    const regionList = String(regions).split(",").map(r => r.trim()).filter(Boolean);
    if (regionList.length > 0) {
      params.push(regionList);
      sql += ` AND r.regions && $${params.length}::text[]`;
    }
  }
  if (difficulty) {
    params.push(difficulty);
    sql += ` AND r.difficulty = $${params.length}`;
  }
  if (component !== undefined) {
    params.push(component === "true");
    sql += ` AND r.is_component = $${params.length}`;
  }
  if (seasonalOnly === "true") {
    // In season = none of this recipe's seasonal-tagged ingredients falls
    // outside the target month. An ingredient with no seasonality data
    // (NULL or empty array) never excludes a recipe — see
    // db/migrations/034_ingredient_seasonality.sql.
    const month = seasonalMonth ? Number(seasonalMonth) : new Date().getMonth() + 1;
    params.push(month);
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM recipe_ingredients sri
      JOIN ingredients si ON si.id = sri.ingredient_id
      WHERE sri.recipe_id = r.id
        AND si.seasonal_months IS NOT NULL AND array_length(si.seasonal_months, 1) > 0
        AND NOT (si.seasonal_months @> ARRAY[$${params.length}]::int[])
    )`;
  }

  const orderBy = sort === "alphabetical" && langParamIndex
    ? "COALESCE(rt.title, r.title) ASC"
    : SORT_OPTIONS[String(sort)] ?? SORT_OPTIONS["recently-edited"];
  sql += ` GROUP BY r.id, acc.name, acc.avatar_url${lang ? ", rt.title, rt.description" : ""} ORDER BY ${orderBy}`;

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
  let stepTranslatedNotes = "NULL";
  let toolTranslatedName = "NULL";
  let ingredientNameCol = "i.name";
  let ingredientPluralNameCol = "i.plural_name";
  let ingredientTranslatedNotes = "NULL";
  if (lang) {
    params.push(lang);
    langJoin = `LEFT JOIN recipe_translations rct ON rct.recipe_id = r.id AND LOWER(rct.language_code) = LOWER($2)`;
    translatedCols = "rct.title AS translated_title, rct.description AS translated_description";
    stepTranslatedTitle = "rst.title";
    stepTranslatedDescription = "rst.description";
    stepTranslatedNotes = "rst.notes";
    toolTranslatedName = "tt.name";
    ingredientNameCol = "COALESCE(it_lang.translated_name, i.name)";
    ingredientPluralNameCol = "COALESCE(it_lang.plural_translation, i.plural_name)";
    ingredientTranslatedNotes = "rit_lang.notes";
  }

  const recipe = await queryOne(
    `SELECT r.*, ${translatedCols},
            acc.name AS creator_name, acc.avatar_url AS creator_avatar_url,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'name', tag_name,
                 'translated_name', COALESCE(${lang ? "tt_tag.name" : "NULL"}, t.name, tag_name),
                 'color', t.color
               ))
               FROM unnest(r.tags) AS tag_name
               LEFT JOIN tags t ON lower(t.name) = lower(tag_name)
               ${lang ? "LEFT JOIN tag_translations tt_tag ON tt_tag.tag_id = t.id AND LOWER(tt_tag.language_code) = LOWER($2)" : ""}
              ), '[]'::json
            ) AS tags_display,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', rt2.language_code, 'title', rt2.title, 'description', rt2.description))
               FROM recipe_translations rt2 WHERE rt2.recipe_id = r.id),
              '[]'::json
            ) AS translations,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', ri.id, 'sortOrder', ri.sort_order,
              'ingredientId', ri.ingredient_id,
              'ingredientName', ${ingredientNameCol},
              'ingredientPluralName', ${ingredientPluralNameCol},
              'subRecipeId', ri.sub_recipe_id,
              'subRecipeTitle', sr.title,
              'quantity', ri.quantity,
              'quantityText', ri.quantity_text,
              'unitSymbol', u.symbol, 'unitId', ri.unit_id,
              'isOptional', ri.is_optional,
              'notes', ri.notes,
              'groupName', ri.group_name,
              'substituteFor', ri.substitute_for,
              'translatedNotes', ${ingredientTranslatedNotes},
              'translations', COALESCE(
                (SELECT json_agg(json_build_object('lang', rit2.language_code, 'notes', rit2.notes))
                 FROM recipe_ingredient_translations rit2 WHERE rit2.recipe_ingredient_id = ri.id),
                '[]'::json
              )
            )) FILTER (WHERE ri.id IS NOT NULL), '[]'::json) AS ingredients,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', rs.id, 'stepNumber', rs.step_number,
              'title', rs.title, 'description', rs.description,
              'translatedTitle', ${stepTranslatedTitle},
              'translatedDescription', ${stepTranslatedDescription},
              'translatedNotes', ${stepTranslatedNotes},
              'durationMin', rs.duration_min,
              'toolIds', rs.tool_ids,
              'techniqueIds', rs.technique_ids,
              'notes', rs.notes,
              'imageUrl', rs.image_url,
              'stepIngredients', rs.step_ingredients,
              'translations', COALESCE(
                (SELECT json_agg(json_build_object('lang', rst2.language_code, 'title', rst2.title, 'description', rst2.description, 'notes', rst2.notes))
                 FROM recipe_step_translations rst2 WHERE rst2.step_id = rs.id),
                '[]'::json
              )
            )) FILTER (WHERE rs.id IS NOT NULL), '[]'::json) AS steps,
            COALESCE(json_agg(DISTINCT jsonb_build_object(
              'id', t.id, 'name', t.name, 'icon', t.icon,
              'translated_name', ${toolTranslatedName}
            )) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS tools
     FROM recipes r
     LEFT JOIN account acc ON acc.id = r.creator_id
     LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     LEFT JOIN ingredients i ON i.id = ri.ingredient_id
     ${lang ? "LEFT JOIN ingredient_translations it_lang ON it_lang.ingredient_id = i.id AND LOWER(it_lang.language_code) = LOWER($2)" : ""}
     ${lang ? "LEFT JOIN recipe_ingredient_translations rit_lang ON rit_lang.recipe_ingredient_id = ri.id AND LOWER(rit_lang.language_code) = LOWER($2)" : ""}
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     LEFT JOIN units u ON u.id = ri.unit_id
     LEFT JOIN recipe_steps rs ON rs.recipe_id = r.id
     ${lang ? "LEFT JOIN recipe_step_translations rst ON rst.step_id = rs.id AND LOWER(rst.language_code) = LOWER($2)" : ""}
     LEFT JOIN recipe_tools rtl ON rtl.recipe_id = r.id
     LEFT JOIN tools t ON t.id = rtl.tool_id
     ${lang ? "LEFT JOIN tool_translations tt ON tt.tool_id = t.id AND LOWER(tt.language_code) = LOWER($2)" : ""}
     ${langJoin}
     WHERE r.id = $1
     GROUP BY r.id, acc.name, acc.avatar_url${lang ? ", rct.title, rct.description" : ""}`,
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
  const recipeId = d.id ?? uuidv4();

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO recipes (id,title,description,difficulty,servings,prep_time_min,
           cook_time_min,rest_time_min,rating,yield_amount,yield_unit_id,tags,regions,region_coords,cover_image_url,source_url,sources,is_component,language_code,creator_id,crdt_clock,storage_instructions,tips)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'{}',$21,$22)`,
        [recipeId,d.title,d.description,d.difficulty,d.servings,d.prepTimeMin,
         d.cookTimeMin,d.restTimeMin,d.rating??null,d.yieldAmount??null,d.yieldUnitId??null,d.tags,d.regions,JSON.stringify(d.regionCoords),d.coverImageUrl,d.sourceUrl,JSON.stringify(d.sources),d.isComponent,d.languageCode??null,req.userId??null,
         d.storageInstructions??null,d.tips??null]
      );

      // Inserisci ingredienti
      for (const ing of d.ingredients) {
        const recipeIngredientId = uuidv4();
        await client.query(
          `INSERT INTO recipe_ingredients
             (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
              quantity,quantity_text,unit_id,notes,is_optional,group_name,substitute_for)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [recipeIngredientId,recipeId,ing.sortOrder,ing.ingredientId??null,
           ing.subtypeId??null,ing.subRecipeId??null,ing.quantity??null,
           ing.quantityText??null,ing.unitId??null,ing.notes??null,ing.isOptional,ing.groupName??null,
           ing.substituteFor??null]
        );
        await insertIngredientTranslations(client, recipeIngredientId, ing.translations);
      }

      // Inserisci step
      for (const step of d.steps) {
        const stepId = uuidv4();
        await client.query(
          `INSERT INTO recipe_steps
             (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,image_url,step_ingredients,technique_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [stepId,recipeId,step.stepNumber,step.title??null,
           step.description,step.durationMin??null,step.toolIds??[],step.notes??null,
           step.imageUrl??null,JSON.stringify(step.stepIngredients),step.techniqueIds??[]]
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

      // Unisce i tag manuali con quelli derivati automaticamente dagli
      // ingredienti (deve avvenire dopo l'inserimento di recipe_ingredients)
      const autoTags = await computeAutoTagNames(client, recipeId);
      const finalTags = unionTagNames(d.tags, autoTags);
      await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, recipeId]);

      await upsertRecipeTranslations(client, recipeId, d.translations);
    });
  } catch (err) {
    console.error("Recipe create failed:", err);
    return res.status(500).json({ error: "Impossibile creare la ricetta" });
  }

  res.status(201).json({ data: { id: recipeId } });
});

// ── GET /recipes/:id/collections ──────────────────────────────────────
// Which collections already contain this recipe (drives the "Add to
// Collection" membership checklist on the recipe page).

recipeRouter.get("/:id/collections", async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT c.id, c.name FROM collections c
     JOIN collection_recipes cr ON cr.collection_id = c.id
     WHERE cr.recipe_id = $1 AND c.owner_id = $2
     ORDER BY c.name`,
    [req.params.id, req.userId]
  );
  res.json({ data: rows });
});

// ── POST /recipes/:id/translate/:lang ───────────────────────────────────
// AI-translates title/description/step content/ingredient notes into the
// given language using whichever LLM provider the account has configured.
// Always overwrites any existing translation for that language (no manual-
// edit preservation) — recipes are shared/attribution-only, so any logged-in
// user can trigger this on any recipe, same as editing one.
const SUPPORTED_TRANSLATION_LANGS = ["en", "it", "fr", "es"];

recipeRouter.post("/:id/translate/:lang", async (req: Request, res: Response) => {
  const { id, lang } = req.params;
  if (!SUPPORTED_TRANSLATION_LANGS.includes(lang)) {
    return res.status(400).json({ error: `Unsupported language: ${lang}` });
  }

  const recipe = await queryOne<{ title: string; description: string | null }>(
    "SELECT title, description FROM recipes WHERE id=$1 AND sync_status != 'deleted'",
    [id]
  );
  if (!recipe) return res.status(404).json({ error: "Ricetta non trovata" });

  const steps = await query<{ id: string; title: string | null; description: string; notes: string | null }>(
    "SELECT id, title, description, notes FROM recipe_steps WHERE recipe_id=$1 ORDER BY step_number",
    [id]
  );
  const ingredientNotes = await query<{ id: string; notes: string }>(
    "SELECT id, notes FROM recipe_ingredients WHERE recipe_id=$1 AND notes IS NOT NULL AND notes != ''",
    [id]
  );

  try {
    const translated = await translateRecipeContent(
      { title: recipe.title, description: recipe.description, steps, ingredientNotes },
      lang
    );

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO recipe_translations (recipe_id, language_code, title, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (recipe_id, language_code) DO UPDATE SET title=$3, description=$4, updated_at=now()`,
        [id, lang, translated.title, translated.description]
      );
      for (const step of translated.steps) {
        await client.query(
          `INSERT INTO recipe_step_translations (step_id, language_code, title, description, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (step_id, language_code) DO UPDATE SET title=$3, description=$4, notes=$5, updated_at=now()`,
          [step.id, lang, step.title, step.description, step.notes]
        );
      }
      for (const note of translated.ingredientNotes) {
        await client.query(
          `INSERT INTO recipe_ingredient_translations (recipe_ingredient_id, language_code, notes)
           VALUES ($1, $2, $3)
           ON CONFLICT (recipe_ingredient_id, language_code) DO UPDATE SET notes=$3, updated_at=now()`,
          [note.id, lang, note.notes]
        );
      }
    });

    res.json({ data: { lang, ...translated } });
  } catch (err) {
    console.error("Recipe translation failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Traduzione fallita" });
  }
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

// ── GET /recipes/:id/cook-sequence ────────────────────────────────────
// Kitchen Mode step order: sub-recipes (Matrioska) fully prepared before
// the main recipe that uses them.

recipeRouter.get("/:id/cook-sequence", async (req: Request, res: Response) => {
  const sections = await resolveCookSequence(req.params.id);
  res.json({ data: { sections } });
});

// ── GET /recipes/:id/nutrition?servings=N ────────────────────────────

recipeRouter.get("/:id/nutrition", async (req: Request, res: Response) => {
  const servings = parseInt(String(req.query.servings ?? "4"), 10);
  if (isNaN(servings) || servings < 1 || servings > 1000) {
    return res.status(400).json({ error: "servings deve essere tra 1 e 1000" });
  }

  const result = await calculateRecipeNutrition(req.params.id, servings);
  res.json({ data: result });
});

// ── POST /recipes/fetch-page ──────────────────────────────────────────
//
// Hands the raw HTML of a recipe URL back to the client, which then reads
// its schema.org JSON-LD locally (frontend/src/services/recipeStructuredData.ts)
// and only falls back to POST /parse below when the page carries none.
//
// The fetch stays server-side for two reasons that both still apply: the
// browser cannot fetch arbitrary recipe sites cross-origin, and the SSRF
// guard (assertSafeImportUrl) belongs where the request actually
// originates. The extractor is client-side because it has to be shared with
// standalone mode, which has no backend at all — see that file's header.
recipeRouter.post("/fetch-page", async (req: Request, res: Response) => {
  const parsed = z.object({ url: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const html = await fetchUrlHtml(parsed.data.url);
    res.json({ data: { html } });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not fetch that page" });
  }
});

// ── POST /recipes/parse (LLM) ─────────────────────────────────────────

// The global express.json() cap is 5 MB (see index.ts), which is right for
// every other endpoint and far too small here: a file arrives base64-encoded
// inside the JSON body, inflating ~4/3, so 5 MB of body is under 4 MB of
// actual file — fine for a photo, nowhere near a voice note or a clip. This
// route gets its own parser at 25 MB, which leaves room for the 18 MB file
// ceiling llm.parser.ts enforces plus the encoding overhead. Deliberately
// route-scoped: raising the global limit would hand every other endpoint
// the same memory exposure for no reason.
//
// Worth knowing if uploads fail at a size below this: a reverse proxy in
// front of the API has its own limit (nginx's client_max_body_size defaults
// to 1 MB), and that one rejects the request before Express ever sees it.
const parseBodyParser = express.json({ limit: "25mb" });

recipeRouter.post("/parse", parseBodyParser, async (req: Request, res: Response) => {
  const schema = z
    .object({
      // Empty for a media parse: the file is the recipe, and `input` only
      // carries whatever extra context the user typed.
      input: z.string(),
      inputType: z.enum(["url", "text", "media"]),
      media: z
        .object({
          mimeType: z.string().min(1),
          data: z.string().min(1),
          fileName: z.string().optional(),
        })
        .optional(),
      // Which language to label the library catalog in when it is handed
      // to the model — see importCatalog.service.ts.
      lang: z.string().optional(),
    })
    .refine((v) => v.inputType === "media" || v.input.trim().length > 0, {
      message: "Paste a recipe or a link first.",
      path: ["input"],
    })
    .refine((v) => v.inputType !== "media" || !!v.media, {
      message: "Attach a photo, PDF, audio file or video first.",
      path: ["media"],
    });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    // Returns the raw LLM result unmatched — matching now happens via the
    // Review Matches step (POST /recipes/match-suggestions below), the same
    // pipeline the local/non-AI parser path uses, so a recipe never gets a
    // new ingredient/tool/technique silently created without the user
    // seeing it first.
    const llmResult = await parseRecipeWithLLM(parsed.data);
    res.json({ data: llmResult });
  } catch (err) {
    // A file the configured provider cannot read (or one too large to send)
    // is the caller's problem and the caller can fix it — answering 502
    // would present a fixable mistake as a broken server and bury the
    // sentence that says which provider to switch to.
    if (err instanceof MediaNotSupportedError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Recipe parse failed:", err);
    res.status(502).json({ error: err instanceof Error ? err.message : "Impossibile analizzare la ricetta" });
  }
});

// ── POST /recipes/match-suggestions ───────────────────────────────────
// Read-only fuzzy-match suggestions for a parsed-but-not-yet-matched
// recipe's ingredient/tool/technique names — used by the Import screen's
// Review Matches step after either the AI path (POST /parse above) or the
// frontend's local template/JSON parser. Never writes to the DB; the
// frontend commits chosen/created items itself via the existing
// POST /ingredients, /tools, /techniques endpoints.
recipeRouter.post("/match-suggestions", async (req: Request, res: Response) => {
  const schema = z.object({
    ingredientNames: z.array(z.string()).default([]),
    toolNames: z.array(z.string()).default([]),
    techniqueNames: z.array(z.string()).default([]),
    // Content language, so suggestions are scored and labelled in the
    // language the app is showing rather than always in base English.
    lang: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { lang } = parsed.data;
  const [ingredients, tools, techniques] = await Promise.all([
    proposeIngredientMatches(parsed.data.ingredientNames, lang),
    proposeToolMatches(parsed.data.toolNames, lang),
    proposeTechniqueMatches(parsed.data.techniqueNames, lang),
  ]);
  res.json({ data: { ingredients, tools, techniques } });
});

// Deliberately unimplemented — the future integration point for a planned
// separate pantry/household-inventory app: given the ingredients (and
// quantities) someone actually has on hand, return recipes they can make.
// The request/response shape is fixed now (and validated) so that future
// app has a stable contract to build against even though the matching
// logic itself doesn't exist yet. Kept in this router (not a separate
// file) since it's still fundamentally a recipes query, same as GET /.
const FilterByPantrySchema = z.object({
  ingredients: z.array(z.object({
    ingredientId: z.string().uuid(),
    // Omitted quantity/unit = "I have some, don't check amounts" — a
    // future implementation should treat this the same as "quantity
    // sufficient", not reject/require it.
    quantity: z.number().positive().optional(),
    unit: z.string().optional(),
  })).min(1),
  // Loosen ingredient-vs-recipe matching: 1.0 = every non-optional
  // ingredient must be on hand in sufficient quantity; lower values allow
  // recipes missing a few things. Left to a future implementation to
  // define precisely — reserved here so the request shape doesn't need to
  // change later.
  minMatchRatio: z.number().min(0).max(1).optional(),
});

recipeRouter.post("/filter-by-pantry", async (req: Request, res: Response) => {
  const parsed = FilterByPantrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  // Implemented at last, against the contract that was reserved for it —
  // see services/pantry.service.ts.
  const { ingredients, minMatchRatio } = parsed.data;
  try {
    const results = await filterByPantry(
      ingredients,
      minMatchRatio ?? 1,
      typeof req.query.lang === "string" ? req.query.lang : null,
    );
    res.json({ data: results });
  } catch (err) {
    console.error("Pantry match failed:", err);
    res.status(500).json({ error: "Could not work out what you can cook." });
  }
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
           prep_time_min=$6, cook_time_min=$7, rest_time_min=$8, rating=$9,
           yield_amount=$10, yield_unit_id=$11, tags=$12, regions=$13, region_coords=$14, cover_image_url=$15, source_url=$16, sources=$17, is_component=$18,
           language_code=$19, storage_instructions=$20, tips=$21, updated_at=now()
         WHERE id=$1`,
        [id, d.title, d.description, d.difficulty, d.servings, d.prepTimeMin,
         d.cookTimeMin, d.restTimeMin, d.rating ?? null, d.yieldAmount ?? null, d.yieldUnitId ?? null, d.tags, d.regions, JSON.stringify(d.regionCoords), d.coverImageUrl, d.sourceUrl, JSON.stringify(d.sources), d.isComponent,
         d.languageCode ?? null, d.storageInstructions ?? null, d.tips ?? null]
      );

      // Rimpiazza ingredienti (drop + reinsert; recipe_ingredient_translations cascade with them)
      await client.query("DELETE FROM recipe_ingredients WHERE recipe_id=$1", [id]);
      for (const ing of d.ingredients) {
        const recipeIngredientId = uuidv4();
        await client.query(
          `INSERT INTO recipe_ingredients
             (id,recipe_id,sort_order,ingredient_id,subtype_id,sub_recipe_id,
              quantity,quantity_text,unit_id,notes,is_optional,group_name,substitute_for)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [recipeIngredientId, id, ing.sortOrder, ing.ingredientId??null,
           ing.subtypeId??null, ing.subRecipeId??null, ing.quantity??null,
           ing.quantityText??null, ing.unitId??null, ing.notes??null, ing.isOptional, ing.groupName??null,
           ing.substituteFor??null]
        );
        await insertIngredientTranslations(client, recipeIngredientId, ing.translations);
      }

      // Rimpiazza steps (drop + reinsert; recipe_step_translations cascade with them)
      await client.query("DELETE FROM recipe_steps WHERE recipe_id=$1", [id]);
      for (const step of d.steps) {
        const stepId = uuidv4();
        await client.query(
          `INSERT INTO recipe_steps
             (id,recipe_id,step_number,title,description,duration_min,tool_ids,notes,image_url,step_ingredients,technique_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [stepId, id, step.stepNumber, step.title??null,
           step.description, step.durationMin??null, step.toolIds??[], step.notes??null,
           step.imageUrl??null, JSON.stringify(step.stepIngredients), step.techniqueIds??[]]
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

      // Unisce i tag manuali con quelli derivati automaticamente dagli
      // ingredienti (deve avvenire dopo il reinserimento di recipe_ingredients)
      const autoTags = await computeAutoTagNames(client, id);
      const finalTags = unionTagNames(d.tags, autoTags);
      await client.query("UPDATE recipes SET tags=$1 WHERE id=$2", [finalTags, id]);

      await upsertRecipeTranslations(client, id, d.translations);
    });
  } catch (err) {
    console.error("Recipe update failed:", err);
    return res.status(500).json({ error: "Impossibile aggiornare la ricetta" });
  }

  res.json({ data: { id } });
});

// ── PATCH /recipes/:id/rating ──────────────────────────────────────────
// Fast one-tap rating from the recipe view page — doesn't require opening
// the full editor. null = "not tried" (N/A).

recipeRouter.patch("/:id/rating", async (req: Request, res: Response) => {
  const schema = z.object({ rating: z.number().int().min(0).max(5).nullable() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await query("UPDATE recipes SET rating=$1, updated_at=now() WHERE id=$2", [parsed.data.rating, req.params.id]);
  res.json({ success: true });
});

// ── POST /recipes/:id/cooked ───────────────────────────────────────────
// Logs one more time the user has cooked this recipe. Doesn't touch
// updated_at — cooking it isn't editing it, and shouldn't bump it to the
// top of a "recently edited" sort.

recipeRouter.post("/:id/cooked", async (req: Request, res: Response) => {
  const rows = await query<{ times_cooked: number }>(
    "UPDATE recipes SET times_cooked = times_cooked + 1 WHERE id=$1 RETURNING times_cooked",
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Recipe not found" });
  await query("INSERT INTO cook_log (recipe_id, cooked_by) VALUES ($1, $2)", [req.params.id, req.userId ?? null]);
  res.json({ data: { timesCooked: rows[0].times_cooked } });
});

// ── DELETE /recipes/:id ────────────────────────────────────────────────

recipeRouter.delete("/:id", async (req: Request, res: Response) => {
  await query(
    "UPDATE recipes SET sync_status='deleted', updated_at=now() WHERE id=$1",
    [req.params.id]
  );
  res.status(204).send();
});
