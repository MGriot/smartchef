// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: the pantry
//
// Per-user, like the shopping list and the planner. The matching itself
// lives in services/pantry.service.ts and is shared with the long-reserved
// POST /recipes/filter-by-pantry, whose request contract this honours
// exactly rather than inventing a parallel one.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";

export const pantryRouter = Router();

pantryRouter.get("/", async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT p.id, p.ingredient_id, i.name AS ingredient_name,
            ic.name AS category_name, ic.color AS category_color,
            p.quantity, p.unit_id, u.symbol AS unit_symbol,
            p.expires_at, p.note
       FROM pantry_items p
       LEFT JOIN ingredients i ON i.id = p.ingredient_id
       LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
       LEFT JOIN units u ON u.id = p.unit_id
      WHERE p.owner_id = $1
      ORDER BY ic.sort_order, i.name`,
    [req.userId]
  );
  res.json({ data: rows });
});

const PutSchema = z.object({
  ingredientId: z.string().uuid(),
  quantity: z.number().positive().nullable().optional(),
  unitId: z.string().uuid().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

// PUT / — upsert by ingredient, so topping up the flour edits the row
// rather than adding a second "flour" the matcher would have to sum.
pantryRouter.put("/", async (req: Request, res: Response) => {
  const parsed = PutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO pantry_items (owner_id, ingredient_id, quantity, unit_id, expires_at, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_id, ingredient_id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           unit_id = EXCLUDED.unit_id,
           expires_at = EXCLUDED.expires_at,
           note = EXCLUDED.note,
           updated_at = now()
     RETURNING id`,
    [req.userId, d.ingredientId, d.quantity ?? null, d.unitId ?? null, d.expiresAt || null, d.note ?? null]
  );
  res.json({ data: row });
});

pantryRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("DELETE FROM pantry_items WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  res.json({ success: true });
});
