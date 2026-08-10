import { Router, Request, Response } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";

export const menuRouter = Router();

// GET /menus
menuRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT m.*, COUNT(mi.id) AS item_count
     FROM menus m
     LEFT JOIN menu_items mi ON mi.menu_id = m.id
     GROUP BY m.id
     ORDER BY m.week_start DESC`
  );
  res.json({ data: rows });
});

// GET /menus/:id
menuRouter.get("/:id", async (req: Request, res: Response) => {
  const menu = await queryOne(
    `SELECT m.*,
       COALESCE(json_agg(jsonb_build_object(
         'id', mi.id,
         'recipeId', mi.recipe_id,
         'recipe_title', r.title,
         'dayOfWeek', mi.day_of_week,
         'mealType', mi.meal_type,
         'servings', mi.servings,
         'notes', mi.notes
       )) FILTER (WHERE mi.id IS NOT NULL), '[]'::json) AS items
     FROM menus m
     LEFT JOIN menu_items mi ON mi.menu_id = m.id
     LEFT JOIN recipes r ON r.id = mi.recipe_id
     WHERE m.id = $1
     GROUP BY m.id`,
    [req.params.id]
  );
  if (!menu) return res.status(404).json({ error: "Menù non trovato" });
  res.json({ data: menu });
});

// POST /menus
menuRouter.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1),
    weekStart: z.string(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuidv4();
  await query(
    "INSERT INTO menus (id,name,week_start,notes,crdt_clock) VALUES ($1,$2,$3,$4,'{}')",
    [id, parsed.data.name, parsed.data.weekStart, parsed.data.notes ?? null]
  );
  res.status(201).json({ data: { id, ...parsed.data } });
});

// POST /menus/:id/items
menuRouter.post("/:id/items", async (req: Request, res: Response) => {
  const schema = z.object({
    recipeId: z.string().uuid(),
    dayOfWeek: z.number().int().min(0).max(6),
    mealType: z.enum(["breakfast","lunch","dinner","snack"]).default("dinner"),
    servings: z.number().int().positive().default(4),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuidv4();
  const d = parsed.data;
  await query(
    `INSERT INTO menu_items (id,menu_id,recipe_id,day_of_week,meal_type,servings,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, req.params.id, d.recipeId, d.dayOfWeek, d.mealType, d.servings, d.notes ?? null]
  );
  res.status(201).json({ data: { id } });
});

// DELETE /menus/:menuId/items/:itemId
menuRouter.delete("/:menuId/items/:itemId", async (req: Request, res: Response) => {
  await query("DELETE FROM menu_items WHERE id=$1 AND menu_id=$2",
    [req.params.itemId, req.params.menuId]);
  res.status(204).send();
});

// DELETE /menus/:id
menuRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("DELETE FROM menus WHERE id=$1", [req.params.id]);
  res.status(204).send();
});
