// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Collections
// Raccolte libere di ricette (non legate al calendario, a differenza di
// menus/menu_items) mostrate nella sottotab "Collections" della Gallery.
// Private per user — ogni utente vede e gestisce solo le proprie.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";

export const collectionsRouter = Router();

// GET /collections
collectionsRouter.get("/", async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT c.*, COUNT(cr.recipe_id) AS item_count,
            COALESCE(
              (SELECT json_agg(cover ORDER BY ord)
               FROM (
                 SELECT r.cover_image_url AS cover, cr2.sort_order AS ord
                 FROM collection_recipes cr2
                 JOIN recipes r ON r.id = cr2.recipe_id
                 WHERE cr2.collection_id = c.id AND r.sync_status != 'deleted'
                 ORDER BY cr2.sort_order LIMIT 4
               ) covers),
              '[]'::json
            ) AS cover_images
     FROM collections c
     LEFT JOIN collection_recipes cr ON cr.collection_id = c.id
     WHERE c.deleted_at IS NULL AND c.owner_id = $1
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
    [req.userId]
  );
  res.json({ data: rows });
});

// GET /collections/:id
collectionsRouter.get("/:id", async (req: Request, res: Response) => {
  const collection = await queryOne(
    `SELECT c.*,
       COALESCE(
         (SELECT json_agg(jsonb_build_object(
            'id', r.id, 'title', r.title, 'translated_title', NULL,
            'cover_image_url', r.cover_image_url, 'difficulty', r.difficulty,
            'prep_time_min', r.prep_time_min, 'cook_time_min', r.cook_time_min
          ) ORDER BY cr.sort_order)
          FROM collection_recipes cr
          JOIN recipes r ON r.id = cr.recipe_id
          WHERE cr.collection_id = c.id AND r.sync_status != 'deleted'),
         '[]'::json
       ) AS recipes
     FROM collections c
     WHERE c.id = $1 AND c.deleted_at IS NULL AND c.owner_id = $2`,
    [req.params.id, req.userId]
  );
  if (!collection) return res.status(404).json({ error: "Collection non trovata" });
  res.json({ data: collection });
});

const CollectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

collectionsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = CollectionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = uuidv4();
  await query(
    "INSERT INTO collections (id, name, description, owner_id) VALUES ($1, $2, $3, $4)",
    [id, parsed.data.name, parsed.data.description || null, req.userId]
  );
  res.status(201).json({ data: { id } });
});

collectionsRouter.put("/:id", async (req: Request, res: Response) => {
  const parsed = CollectionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await queryOne(
    "UPDATE collections SET name=$1, description=$2, updated_at=now() WHERE id=$3 AND owner_id=$4 RETURNING id",
    [parsed.data.name, parsed.data.description || null, req.params.id, req.userId]
  );
  if (!updated) return res.status(404).json({ error: "Collection non trovata" });
  res.json({ success: true });
});

collectionsRouter.delete("/:id", async (req: Request, res: Response) => {
  const deleted = await queryOne(
    "UPDATE collections SET deleted_at=now(), updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id",
    [req.params.id, req.userId]
  );
  if (!deleted) return res.status(404).json({ error: "Collection non trovata" });
  res.status(204).send();
});

// POST /collections/:id/recipes  { recipeId }
collectionsRouter.post("/:id/recipes", async (req: Request, res: Response) => {
  const schema = z.object({ recipeId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const owned = await queryOne("SELECT id FROM collections WHERE id=$1 AND owner_id=$2", [req.params.id, req.userId]);
  if (!owned) return res.status(404).json({ error: "Collection non trovata" });

  const nextSort = await queryOne<{ next: number }>(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM collection_recipes WHERE collection_id=$1",
    [req.params.id]
  );
  await query(
    `INSERT INTO collection_recipes (collection_id, recipe_id, sort_order)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [req.params.id, parsed.data.recipeId, nextSort?.next ?? 0]
  );
  res.status(201).json({ success: true });
});

// DELETE /collections/:id/recipes/:recipeId
collectionsRouter.delete("/:id/recipes/:recipeId", async (req: Request, res: Response) => {
  await query(
    `DELETE FROM collection_recipes
     WHERE collection_id=$1 AND recipe_id=$2
       AND collection_id IN (SELECT id FROM collections WHERE owner_id=$3)`,
    [req.params.id, req.params.recipeId, req.userId]
  );
  res.status(204).send();
});
