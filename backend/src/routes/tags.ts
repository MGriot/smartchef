// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Tag Catalog
// Stesso pattern di techniques/tools: riga base + traduzioni. `excludeTagIds`
// rende un tag "auto/dieta": non vuoto significa "applica automaticamente
// questo tag a meno che la ricetta non contenga uno di questi altri tag"
// (calcolato in tags.service.ts a partire dagli ingredient_tags).
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { query } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const tagsRouter = Router();

// GET /tags
tagsRouter.get("/", async (req: Request, res: Response) => {
  const { lang } = req.query;
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name))
               FROM tag_translations tr WHERE tr.tag_id = t.id),
              '[]'::json
            ) AS translations
     FROM tags t
     ${lang ? "LEFT JOIN tag_translations tt ON tt.tag_id = t.id AND tt.language_code = $1" : ""}
     WHERE t.deleted_at IS NULL
     ORDER BY t.sort_order, t.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

const TagSchema = z.object({
  name: z.string().min(1),
  groupName: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  excludeTagIds: z.array(z.string().uuid()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional(),
  })).optional(),
});

async function upsertTagTranslations(tagId: string, translations?: Array<{ lang: string; name?: string }>) {
  if (!translations) return;
  await query("DELETE FROM tag_translations WHERE tag_id=$1", [tagId]);
  for (const t of translations) {
    if (!t.lang || !t.name) continue;
    await query(
      `INSERT INTO tag_translations (tag_id, language_code, name) VALUES ($1, $2, $3)`,
      [tagId, t.lang, t.name]
    );
  }
}

tagsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = TagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    `INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds || []]
  );
  await upsertTagTranslations(id, d.translations);
  res.json({ data: { id } });
});

tagsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = TagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    `UPDATE tags SET name=$1, group_name=$2, color=$3, icon=$4, exclude_tag_ids=$5, updated_at=now()
     WHERE id=$6`,
    [d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds || [], id]
  );
  await upsertTagTranslations(id, d.translations);
  res.json({ success: true });
});

tagsRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});
