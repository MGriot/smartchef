import { Router, Request, Response } from "express";
import { query, queryOne } from "../db/pool";
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
    `SELECT i.*, ic.name AS category_name, ic.icon AS category_icon,
            ${lang ? "COALESCE(ict.name, ic.name)" : "ic.name"} AS translated_category_name,
            ${lang ? "it_lang.translated_name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', t.language_code, 'text', t.translated_name))
               FROM ingredient_translations t WHERE t.ingredient_id = i.id),
              '[]'::json
            ) AS translations
     FROM ingredients i
     LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
     ${lang ? `LEFT JOIN ingredient_translations it_lang ON it_lang.ingredient_id = i.id AND it_lang.language_code = $1` : ""}
     ${lang ? `LEFT JOIN ingredient_category_translations ict ON ict.category_id = i.category_id AND ict.language_code = $1` : ""}
     WHERE i.sync_status != 'deleted'
       ${q ? `AND i.name ILIKE $${params.length}` : ""}
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
     ${lang ? "LEFT JOIN ingredient_category_translations ct ON ct.category_id = c.id AND ct.language_code = $1" : ""}
     ORDER BY c.sort_order, c.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

const CategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
});

async function upsertCategoryTranslations(categoryId: string, translations?: Array<{ lang: string; name?: string; description?: string }>) {
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
    "INSERT INTO ingredient_categories (id, name, description, icon) VALUES ($1, $2, $3, $4)",
    [id, parsed.data.name, parsed.data.description || null, parsed.data.icon || null]
  );
  await upsertCategoryTranslations(id, parsed.data.translations);
  res.json({ data: { id } });
});

ingredientsRouter.put("/categories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = CategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await query(
    "UPDATE ingredient_categories SET name=$1, description=$2, icon=$3, updated_at=now() WHERE id=$4",
    [parsed.data.name, parsed.data.description || null, parsed.data.icon || null, id]
  );
  await upsertCategoryTranslations(id, parsed.data.translations);
  res.json({ success: true });
});

ingredientsRouter.delete("/categories/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await query("DELETE FROM ingredient_categories WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Cannot delete category in use." });
  }
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
     ${lang ? "LEFT JOIN unit_translations ut ON ut.unit_id = u.id AND ut.language_code = $1" : ""}
     ORDER BY u.unit_type, u.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

// GET /tools
toolsRouter.get("/", async (req: Request, res: Response) => {
  const { lang } = req.query;
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name, 'description', tr.description))
               FROM tool_translations tr WHERE tr.tool_id = t.id),
              '[]'::json
            ) AS translations
     FROM tools t
     ${lang ? "LEFT JOIN tool_translations tt ON tt.tool_id = t.id AND tt.language_code = $1" : ""}
     ORDER BY t.category, t.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});


// ── Ingredients Mutazioni ──────────────────────────────────────────────

const IngredientSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().uuid(),
  description: z.string().optional(),
  icon: z.string().optional(),
  imageUrls: z.array(z.string().url()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    text: z.string()
  })).optional()
});

ingredientsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = IngredientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    `INSERT INTO ingredients (id, name, category_id, description, icon, image_urls)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || []]
  );

  if (d.translations && d.translations.length > 0) {
    for (const t of d.translations) {
      await query(
        `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, t.lang, t.text]
      );
    }
  }

  res.json({ data: { id } });
});

ingredientsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = IngredientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    `UPDATE ingredients SET name=$1, category_id=$2, description=$3, icon=$4, image_urls=$5, updated_at=now()
     WHERE id=$6`,
    [d.name, d.categoryId, d.description || null, d.icon || null, d.imageUrls || [], id]
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

  res.json({ success: true });
});

ingredientsRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("UPDATE ingredients SET sync_status='deleted', updated_at=now() WHERE id=$1", [id]);
  res.json({ success: true });
});

// ── Tools Mutazioni ────────────────────────────────────────────────────

const ToolSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  imageUrls: z.array(z.string().url()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
});

async function upsertToolTranslations(toolId: string, translations?: Array<{ lang: string; name?: string; description?: string }>) {
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
    "INSERT INTO tools (id, name, category, description, icon, image_urls) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || []]
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
    "UPDATE tools SET name=$1, category=$2, description=$3, icon=$4, image_urls=$5 WHERE id=$6",
    [d.name, d.category || null, d.description || null, d.icon || null, d.imageUrls || [], id]
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
    name: z.string().optional(),
  })).optional(),
});

async function upsertUnitTranslations(unitId: string, translations?: Array<{ lang: string; name?: string }>) {
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
