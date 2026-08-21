import { Router, Request, Response } from "express";
import { query, queryOne, withTransaction } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const ingredientsRouter = Router();
export const unitsRouter = Router();
export const toolsRouter = Router();

// GET /ingredients
ingredientsRouter.get("/", async (req: Request, res: Response) => {
  const { q, lang } = req.query;
  const params: unknown[] = [];
  if (lang) params.push(lang);
  if (q) params.push(`%${q}%`);

  const rows = await query(
    `SELECT i.*, ic.name AS category_name, ic.icon AS category_icon, ic.color AS category_color,
            p.name AS parent_name,
            ${lang ? "COALESCE(ict.name, ic.name)" : "ic.name"} AS translated_category_name,
            ${lang ? "it_lang.translated_name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', t.language_code, 'text', t.translated_name))
               FROM ingredient_translations t WHERE t.ingredient_id = i.id),
              '[]'::json
            ) AS translations,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'id', tg.id, 'name', tg.name,
                 'translated_name', ${lang ? "tgt.name" : "NULL"},
                 'color', tg.color, 'icon', tg.icon
               ))
               FROM ingredient_tags igt
               JOIN tags tg ON tg.id = igt.tag_id
               ${lang ? "LEFT JOIN tag_translations tgt ON tgt.tag_id = tg.id AND LOWER(tgt.language_code) = LOWER($1)" : ""}
               WHERE igt.ingredient_id = i.id),
              '[]'::json
            ) AS tags
     FROM ingredients i
     LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
     LEFT JOIN ingredients p ON p.id = i.parent_ingredient_id
     ${lang ? `LEFT JOIN ingredient_translations it_lang ON it_lang.ingredient_id = i.id AND LOWER(it_lang.language_code) = LOWER($1)` : ""}
     ${lang ? `LEFT JOIN ingredient_category_translations ict ON ict.category_id = i.category_id AND LOWER(ict.language_code) = LOWER($1)` : ""}
     WHERE i.sync_status != 'deleted'
       ${q ? `AND (i.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(i.synonyms) syn WHERE syn ILIKE $${params.length}))` : ""}
     ORDER BY COALESCE(ic.name, 'Uncategorized'), i.name
     LIMIT 200`,
    params
  );
  res.json({ data: rows });
});

// GET /ingredients/categories
ingredientsRouter.get("/categories", async (req: Request, res: Response) => {
  const { lang } = req.query;
  const rows = await query(
    `SELECT c.*, ${lang ? "ct.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', t.language_code, 'name', t.name, 'description', t.description))
               FROM ingredient_category_translations t WHERE t.category_id = c.id),
              '[]'::json
            ) AS translations
     FROM ingredient_categories c
     ${lang ? "LEFT JOIN ingredient_category_translations ct ON ct.category_id = c.id AND LOWER(ct.language_code) = LOWER($1)" : ""}
     WHERE c.deleted_at IS NULL
     ORDER BY c.sort_order, c.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

const CategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })).optional(),
});

async function upsertCategoryTranslations(categoryId: string, translations?: Array<{ lang: string; name?: string | null; description?: string | null }>) {
  if (!translations) return;
  await query("DELETE FROM ingredient_category_translations WHERE category_id=$1", [categoryId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(
      `INSERT INTO ingredient_category_translations (category_id, language_code, name, description)
       VALUES ($1, $2, $3, $4)`,
      [categoryId, t.lang, t.name || null, t.description || null]
    );
  }
}

ingredientsRouter.post("/categories", async (req: Request, res: Response) => {
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuidv4();
  await query(
    "INSERT INTO ingredient_categories (id, name, description, icon, color) VALUES ($1, $2, $3, $4, $5)",
    [id, parsed.data.name, parsed.data.description || null, parsed.data.icon || null, parsed.data.color || null]
  );
  await upsertCategoryTranslations(id, parsed.data.translations);
  res.json({ data: { id } });
});

ingredientsRouter.put("/categories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await query(
    "UPDATE ingredient_categories SET name=$1, description=$2, icon=$3, color=$4, updated_at=now() WHERE id=$5",
    [parsed.data.name, parsed.data.description || null, parsed.data.icon || null, parsed.data.color || null, id]
  );
  await upsertCategoryTranslations(id, parsed.data.translations);
  res.json({ success: true });
});

ingredientsRouter.delete("/categories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("UPDATE ingredient_categories SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
  res.json({ success: true });
});

// GET /units
unitsRouter.get("/", async (req: Request, res: Response) => {
  const { lang } = req.query;
  const rows = await query(
    `SELECT u.*, ${lang ? "ut.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', t.language_code, 'name', t.name))
               FROM unit_translations t WHERE t.unit_id = u.id),
              '[]'::json
            ) AS translations
     FROM units u
     ${lang ? "LEFT JOIN unit_translations ut ON ut.unit_id = u.id AND LOWER(ut.language_code) = LOWER($1)" : ""}
     ORDER BY u.unit_type, u.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

// GET /tools
toolsRouter.get("/", async (req: Request, res: Response) => {
  const { lang, q } = req.query;
  const params: unknown[] = [];
  if (lang) params.push(lang);
  if (q) params.push(`%${q}%`);
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name, 'description', tr.description))
               FROM tool_translations tr WHERE tr.tool_id = t.id),
              '[]'::json
            ) AS translations
     FROM tools t
     ${lang ? "LEFT JOIN tool_translations tt ON tt.tool_id = t.id AND LOWER(tt.language_code) = LOWER($1)" : ""}
     WHERE t.deleted_at IS NULL
       ${q ? `AND (t.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(t.synonyms) syn WHERE syn ILIKE $${params.length}))` : ""}
     ORDER BY t.category, t.name`,
    params
  );
  res.json({ data: rows });
});


// ── Ingredients Mutazioni ──────────────────────────────────────────────

const NutritionFieldsSchema = {
  caloriesKcal: z.number().nonnegative().optional(),
  proteinG: z.number().nonnegative().optional(),
  carbsG: z.number().nonnegative().optional(),
  fatG: z.number().nonnegative().optional(),
  fiberG: z.number().nonnegative().optional(),
  sugarG: z.number().nonnegative().optional(),
  sodiumMg: z.number().nonnegative().optional(),
};

const IngredientSchema = z.object({
  // Optional client-supplied id — see the identical field on
  // CreateRecipeSchema in recipes.ts for why (native offline-create outbox).
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  categoryId: z.string().uuid(),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  imageUrls: z.array(z.string().url()).optional(),
  tagIds: z.array(z.string().uuid()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    text: z.string()
  })).optional(),
  // Month numbers (1-12, Northern hemisphere) this ingredient is in season
  // for. Empty/omitted = no seasonality data, not "year-round" — see
  // db/migrations/034_ingredient_seasonality.sql.
  seasonalMonths: z.array(z.number().int().min(1).max(12)).optional(),
  // Alternate names, search-only — see db/migrations/035_synonyms.sql.
  synonyms: z.array(z.string()).optional(),
  // "This is a variety of" — see db/migrations/036_ingredient_parent.sql.
  parentIngredientId: z.string().uuid().optional().nullable(),
  ...NutritionFieldsSchema,
});

async function upsertIngredientTags(ingredientId: string, tagIds?: string[]) {
  if (!tagIds) return;
  await query("DELETE FROM ingredient_tags WHERE ingredient_id=$1", [ingredientId]);
  for (const tagId of tagIds) {
    await query(
      "INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [ingredientId, tagId]
    );
  }
}

ingredientsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = IngredientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = d.id ?? uuidv4();
  await query(
    `INSERT INTO ingredients (id, name, category_id, description, icon, image_urls,
       calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, seasonal_months,
       synonyms, parent_ingredient_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [id, d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? [],
     d.synonyms ?? [], d.parentIngredientId ?? null]
  );

  if (d.translations && d.translations.length > 0) {
    for (const t of d.translations) {
      await query(
        `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, t.lang, t.text]
      );
    }
  }
  await upsertIngredientTags(id, d.tagIds);

  res.json({ data: { id } });
});

ingredientsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = IngredientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;

  // Same self/ancestor-cycle guard as ingredients.local.ts's updateIngredient().
  let parentIngredientId = d.parentIngredientId ?? null;
  if (parentIngredientId) {
    let cursor: string | null = parentIngredientId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) { parentIngredientId = null; break; }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const ancestorRow: { parent_ingredient_id: string | null } | null = await queryOne("SELECT parent_ingredient_id FROM ingredients WHERE id=$1", [cursor]);
      cursor = ancestorRow?.parent_ingredient_id ?? null;
    }
  }

  await query(
    `UPDATE ingredients SET name=$1, category_id=$2, description=$3, icon=$4, image_urls=$5,
       calories_kcal=$6, protein_g=$7, carbs_g=$8, fat_g=$9, fiber_g=$10, sugar_g=$11, sodium_mg=$12,
       seasonal_months=$13, synonyms=$14, parent_ingredient_id=$15, updated_at=now()
     WHERE id=$16`,
    [d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [],
     d.caloriesKcal ?? null, d.proteinG ?? null, d.carbsG ?? null, d.fatG ?? null,
     d.fiberG ?? null, d.sugarG ?? null, d.sodiumMg ?? null, d.seasonalMonths ?? [],
     d.synonyms ?? [], parentIngredientId, id]
  );

  if (d.translations) {
    await query("DELETE FROM ingredient_translations WHERE ingredient_id=$1", [id]);
    for (const t of d.translations) {
      if (t.lang && t.text) {
        await query(
          `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name) VALUES ($1, $2, $3)`,
          [id, t.lang, t.text]
        );
      }
    }
  }
  await upsertIngredientTags(id, d.tagIds);

  res.json({ success: true });
});

ingredientsRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("UPDATE ingredients SET sync_status='deleted', updated_at=now() WHERE id=$1", [id]);
  res.json({ success: true });
});

const MergeIngredientsSchema = z.object({ targetId: z.string().uuid() });

// Folds a mistakenly-duplicated ingredient into another one — every recipe,
// shopping-list item, and per-ingredient unit conversion that referenced
// the source is repointed to the target instead (so nothing downstream is
// affected, it just correctly points at one ingredient going forward), and
// the source is tombstoned. Mirrors frontend/src/services/ingredients.local.ts's
// mergeIngredients() for standalone mode.
ingredientsRouter.post("/:id/merge", async (req: Request, res: Response) => {
  const { id: sourceId } = req.params;
  const parsed = MergeIngredientsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { targetId } = parsed.data;
  if (sourceId === targetId) return res.status(400).json({ error: "Cannot merge an ingredient into itself" });

  const recipesUpdated = await withTransaction(async (client) => {
    const affected = await client.query(
      "SELECT DISTINCT recipe_id FROM recipe_ingredients WHERE ingredient_id=$1",
      [sourceId]
    );
    await client.query("UPDATE recipe_ingredients SET ingredient_id=$1 WHERE ingredient_id=$2", [targetId, sourceId]);
    await client.query("UPDATE shopping_list_items SET ingredient_id=$1 WHERE ingredient_id=$2", [targetId, sourceId]);
    await client.query(
      "UPDATE unit_conversions SET ingredient_id=$1 WHERE ingredient_id=$2 AND NOT EXISTS (SELECT 1 FROM unit_conversions WHERE ingredient_id=$1 AND from_unit_id=unit_conversions.from_unit_id AND to_unit_id=unit_conversions.to_unit_id)",
      [targetId, sourceId]
    );
    await client.query("DELETE FROM unit_conversions WHERE ingredient_id=$1", [sourceId]);
    await client.query(
      "INSERT INTO ingredient_tags (ingredient_id, tag_id) SELECT $1, tag_id FROM ingredient_tags WHERE ingredient_id=$2 ON CONFLICT DO NOTHING",
      [targetId, sourceId]
    );
    await client.query("DELETE FROM ingredient_tags WHERE ingredient_id=$1", [sourceId]);
    await client.query("UPDATE ingredients SET sync_status='deleted', updated_at=now() WHERE id=$1", [sourceId]);
    return affected.rows.length;
  });

  res.json({ data: { recipesUpdated } });
});

// ── Tools Mutazioni ────────────────────────────────────────────────────

const ToolSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  imageUrls: z.array(z.string().url()).optional(),
  synonyms: z.array(z.string()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })).optional(),
});

async function upsertToolTranslations(toolId: string, translations?: Array<{ lang: string; name?: string | null; description?: string | null }>) {
  if (!translations) return;
  await query("DELETE FROM tool_translations WHERE tool_id=$1", [toolId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(
      `INSERT INTO tool_translations (tool_id, language_code, name, description) VALUES ($1, $2, $3, $4)`,
      [toolId, t.lang, t.name || null, t.description || null]
    );
  }
}

toolsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = ToolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    "INSERT INTO tools (id, name, category, description, icon, image_urls, synonyms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? []]
  );
  await upsertToolTranslations(id, d.translations);
  res.json({ data: { id } });
});

toolsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = ToolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    "UPDATE tools SET name=$1, category=$2, description=$3, icon=$4, image_urls=$5, synonyms=$6 WHERE id=$7",
    [d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? [], id]
  );
  await upsertToolTranslations(id, d.translations);
  res.json({ success: true });
});

toolsRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("DELETE FROM tools WHERE id=$1", [id]);
  res.json({ success: true });
});

// ── Units Mutazioni ────────────────────────────────────────────────────

const UnitSchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
  unitType: z.string().optional(),
  system: z.string().optional(),
  toBaseFactor: z.number().optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional().nullable(),
  })).optional(),
});

async function upsertUnitTranslations(unitId: string, translations?: Array<{ lang: string; name?: string | null }>) {
  if (!translations) return;
  await query("DELETE FROM unit_translations WHERE unit_id=$1", [unitId]);
  for (const t of translations) {
    if (!t.lang || !t.name) continue;
    await query(
      `INSERT INTO unit_translations (unit_id, language_code, name) VALUES ($1, $2, $3)`,
      [unitId, t.lang, t.name]
    );
  }
}

unitsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = UnitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    `INSERT INTO units (id, name, symbol, unit_type, system, to_base_factor)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, d.name, d.symbol, d.unitType || null, d.system || null, d.toBaseFactor ?? 1]
  );
  await upsertUnitTranslations(id, d.translations);
  res.json({ data: { id } });
});

unitsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = UnitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    `UPDATE units SET name=$1, symbol=$2, unit_type=$3, system=$4, to_base_factor=$5
     WHERE id=$6`,
    [d.name, d.symbol, d.unitType || null, d.system || null, d.toBaseFactor ?? 1, id]
  );
  await upsertUnitTranslations(id, d.translations);
  res.json({ success: true });
});

unitsRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("DELETE FROM units WHERE id=$1", [id]);
  res.json({ success: true });
});
