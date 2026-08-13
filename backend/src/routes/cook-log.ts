// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Cook history (cook_log read side)
// Write side lives in recipes.ts's POST /:id/cooked; this router is
// read-only, feeding the frontend's month-calendar view.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { query } from "../db/pool";

export const cookLogRouter = Router();

// GET /cook-log?from=YYYY-MM-DD&to=YYYY-MM-DD
cookLogRouter.get("/", async (req: Request, res: Response) => {
  const { from, to } = req.query;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (typeof from === "string") {
    params.push(from);
    conditions.push(`cl.cooked_at >= $${params.length}`);
  }
  if (typeof to === "string") {
    params.push(to);
    conditions.push(`cl.cooked_at < ($${params.length}::date + interval '1 day')`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await query(
    `SELECT cl.id, cl.recipe_id AS "recipeId", r.title AS "recipeTitle",
            r.cover_image_url AS "coverImageUrl", cl.cooked_at AS "cookedAt",
            acc.name AS "cookedByName"
     FROM cook_log cl
     JOIN recipes r ON r.id = cl.recipe_id
     LEFT JOIN account acc ON acc.id = cl.cooked_by
     ${where}
     ORDER BY cl.cooked_at DESC`,
    params
  );
  res.json({ data: rows });
});
