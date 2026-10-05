import { Router, Request, Response } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { calculateMenuNutrition } from "../services/nutrition.service";

export const menuRouter = Router();

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

// An event menu's courses, in order — see db/migrations/043_event_menus.sql.
const coursesSchema = z.array(z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(120),
  // Which meal of a day menu the course belongs to. Absent = the menu's one meal.
  mealType: z.enum(MEAL_TYPES).optional(),
})).max(60);

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
         'notes', mi.notes,
         'courseId', mi.course_id,
         'sortOrder', mi.sort_order
       ) ORDER BY mi.day_of_week, mi.sort_order, mi.created_at) FILTER (WHERE mi.id IS NOT NULL), '[]'::json) AS items
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
    // 'week' = the Monday-to-Sunday plan; 'event' = one meal, by course.
    kind: z.enum(["week", "event"]).default("week"),
    mealType: z.enum(MEAL_TYPES).optional(),
    guests: z.number().int().positive().max(500).optional(),
    courses: coursesSchema.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuidv4();
  const d = parsed.data;
  await query(
    `INSERT INTO menus (id,name,week_start,notes,crdt_clock,owner_id,kind,meal_type,guests,courses)
     VALUES ($1,$2,$3,$4,'{}',$5,$6,$7,$8,$9)`,
    [id, d.name, d.weekStart, d.notes ?? null, req.userId, d.kind,
     d.mealType ?? null, d.guests ?? null, JSON.stringify(d.courses ?? [])]
  );
  res.status(201).json({ data: { id, ...d } });
});

// PATCH /menus/:id — rename a menu, change an event's date, meal or
// guests, or rewrite its course list (rename, reorder, add, remove).
menuRouter.patch("/:id", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    weekStart: z.string().optional(),
    notes: z.string().nullable().optional(),
    mealType: z.enum(MEAL_TYPES).nullable().optional(),
    guests: z.number().int().positive().max(500).nullable().optional(),
    courses: coursesSchema.optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  // undefined = leave alone, so each column is only written when sent.
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column}=$${params.length}`); };
  if (d.name !== undefined) set("name", d.name);
  if (d.weekStart !== undefined) set("week_start", d.weekStart);
  if (d.notes !== undefined) set("notes", d.notes);
  if (d.mealType !== undefined) set("meal_type", d.mealType);
  if (d.guests !== undefined) set("guests", d.guests);
  if (d.courses !== undefined) set("courses", JSON.stringify(d.courses));
  if (sets.length === 0) return res.json({ success: true });

  params.push(req.params.id, req.userId);
  const updated = await queryOne(
    `UPDATE menus SET ${sets.join(", ")}, updated_at=now()
      WHERE id=$${params.length - 1} AND owner_id=$${params.length}
      RETURNING id`,
    params
  );
  if (!updated) return res.status(404).json({ error: "Menù non trovato" });
  res.json({ success: true });
});

// POST /menus/:id/items
menuRouter.post("/:id/items", async (req: Request, res: Response) => {
  const schema = z.object({
    recipeId: z.string().uuid(),
    // An event menu's dishes have no weekday; they sit in a course instead.
    dayOfWeek: z.number().int().min(0).max(6).default(0),
    mealType: z.enum(MEAL_TYPES).default("dinner"),
    servings: z.number().int().positive().default(4),
    notes: z.string().optional(),
    courseId: z.string().max(64).optional(),
    sortOrder: z.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const owned = await queryOne("SELECT id FROM menus WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  if (!owned) return res.status(404).json({ error: "Menù non trovato" });

  const id = uuidv4();
  const d = parsed.data;
  // A dish added without a position goes to the end of its course.
  const sortOrder = d.sortOrder ?? Number((await queryOne<{ next: string }>(
    `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM menu_items
      WHERE menu_id=$1 AND course_id IS NOT DISTINCT FROM $2`,
    [req.params.id, d.courseId ?? null]
  ))?.next ?? 0);
  await query(
    `INSERT INTO menu_items (id,menu_id,recipe_id,day_of_week,meal_type,servings,notes,course_id,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, req.params.id, d.recipeId, d.dayOfWeek, d.mealType, d.servings, d.notes ?? null,
     d.courseId ?? null, sortOrder]
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
    mealType: z.enum(MEAL_TYPES).optional(),
    servings: z.number().int().positive().optional(),
    // Event menus: move a dish to another course, or within one.
    courseId: z.string().max(64).optional(),
    sortOrder: z.number().int().min(0).optional(),
    notes: z.string().nullable().optional(),
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
            servings    = COALESCE($3, servings),
            course_id   = COALESCE($4, course_id),
            sort_order  = COALESCE($5, sort_order),
            notes       = CASE WHEN $6::boolean THEN $7 ELSE notes END
      WHERE id=$8 AND menu_id=$9
      RETURNING id`,
    [d.dayOfWeek ?? null, d.mealType ?? null, d.servings ?? null, d.courseId ?? null, d.sortOrder ?? null,
     d.notes !== undefined, d.notes ?? null, req.params.itemId, req.params.menuId]
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
