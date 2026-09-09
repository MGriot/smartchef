import { Router, Request, Response } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { calculateMenuNutrition } from "../services/nutrition.service";

export const menuRouter = Router();

// GET /menus
menuRouter.get("/", async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT m.*, COUNT(mi.id) AS item_count
     FROM menus m
     LEFT JOIN menu_items mi ON mi.menu_id = m.id
     WHERE m.owner_id = $1
     GROUP BY m.id
     ORDER BY m.week_start DESC`,
    [req.userId]
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
     WHERE m.id = $1 AND m.owner_id = $2
     GROUP BY m.id`,
    [req.params.id, req.userId]
  );
  if (!menu) return res.status(404).json({ error: "Menù non trovato" });
  res.json({ data: menu });
});

// GET /menus/:id/nutrition
menuRouter.get("/:id/nutrition", async (req: Request, res: Response) => {
  const owned = await queryOne("SELECT id FROM menus WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  if (!owned) return res.status(404).json({ error: "Menù non trovato" });

  const result = await calculateMenuNutrition(req.params.id);
  res.json({ data: result });
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
    "INSERT INTO menus (id,name,week_start,notes,crdt_clock,owner_id) VALUES ($1,$2,$3,$4,'{}',$5)",
    [id, parsed.data.name, parsed.data.weekStart, parsed.data.notes ?? null, req.userId]
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

  const owned = await queryOne("SELECT id FROM menus WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  if (!owned) return res.status(404).json({ error: "Menù non trovato" });

  const id = uuidv4();
  const d = parsed.data;
  await query(
    `INSERT INTO menu_items (id,menu_id,recipe_id,day_of_week,meal_type,servings,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, req.params.id, d.recipeId, d.dayOfWeek, d.mealType, d.servings, d.notes ?? null]
  );
  res.status(201).json({ data: { id } });
});

// PATCH /menus/:menuId/items/:itemId — move a planned recipe.
//
// Exists for drag-and-drop: dropping a meal on another day is a move, and
// delete-then-recreate would lose the item's identity (and its servings and
// notes) for what the user experiences as dragging one card.
menuRouter.patch("/:menuId/items/:itemId", async (req: Request, res: Response) => {
  const schema = z.object({
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    mealType: z.enum(["breakfast","lunch","dinner","snack"]).optional(),
    servings: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const owned = await queryOne(
    "SELECT id FROM menus WHERE id=$1 AND owner_id=$2",
    [req.params.menuId, req.userId]
  );
  if (!owned) return res.status(404).json({ error: "Menù non trovato" });

  const d = parsed.data;
  const updated = await queryOne(
    `UPDATE menu_items
        SET day_of_week = COALESCE($1, day_of_week),
            meal_type   = COALESCE($2, meal_type),
            servings    = COALESCE($3, servings)
      WHERE id=$4 AND menu_id=$5
      RETURNING id`,
    [d.dayOfWeek ?? null, d.mealType ?? null, d.servings ?? null, req.params.itemId, req.params.menuId]
  );
  if (!updated) return res.status(404).json({ error: "Item non trovato" });
  res.json({ success: true });
});

// DELETE /menus/:menuId/items/:itemId
menuRouter.delete("/:menuId/items/:itemId", async (req: Request, res: Response) => {
  await query(
    `DELETE FROM menu_items
     WHERE id=$1 AND menu_id=$2
       AND menu_id IN (SELECT id FROM menus WHERE owner_id=$3)`,
    [req.params.itemId, req.params.menuId, req.userId]
  );
  res.status(204).send();
});

// DELETE /menus/:id
menuRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("DELETE FROM menus WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  res.status(204).send();
});
