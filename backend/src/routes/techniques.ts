// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Tecniche di Cottura
// Stesso pattern di tools/ingredients: riga base + traduzioni + immagini
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { query } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const techniquesRouter = Router();

// GET /techniques
techniquesRouter.get("/", async (req: Request, res: Response) => {
  const { lang } = req.query;
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name, 'description', tr.description))
               FROM technique_translations tr WHERE tr.technique_id = t.id),
              '[]'::json
            ) AS translations
     FROM techniques t
     ${lang ? "LEFT JOIN technique_translations tt ON tt.technique_id = t.id AND tt.language_code = $1" : ""}
     ORDER BY t.name`,
    lang ? [lang] : []
  );
  res.json({ data: rows });
});

const TechniqueSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  imageUrls: z.array(z.string().url()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
});

async function upsertTechniqueTranslations(techniqueId: string, translations?: Array<{ lang: string; name?: string; description?: string }>) {
  if (!translations) return;
  await query("DELETE FROM technique_translations WHERE technique_id=$1", [techniqueId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(
      `INSERT INTO technique_translations (technique_id, language_code, name, description) VALUES ($1, $2, $3, $4)`,
      [techniqueId, t.lang, t.name || null, t.description || null]
    );
  }
}

techniquesRouter.post("/", async (req: Request, res: Response) => {
  const parsed = TechniqueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    "INSERT INTO techniques (id, name, description, icon, image_urls) VALUES ($1, $2, $3, $4, $5)",
    [id, d.name, d.description || null, d.icon || null, d.imageUrls || []]
  );
  await upsertTechniqueTranslations(id, d.translations);
  res.json({ data: { id } });
});

techniquesRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = TechniqueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    "UPDATE techniques SET name=$1, description=$2, icon=$3, image_urls=$4, updated_at=now() WHERE id=$5",
    [d.name, d.description || null, d.icon || null, d.imageUrls || [], id]
  );
  await upsertTechniqueTranslations(id, d.translations);
  res.json({ success: true });
});

techniquesRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("DELETE FROM techniques WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});
