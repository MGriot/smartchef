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
  const { lang, q } = req.query;
  const params: unknown[] = [];
  if (lang) params.push(lang);
  if (q) params.push(`%${q}%`);
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name, 'description', tr.description))
               FROM technique_translations tr WHERE tr.technique_id = t.id),
              '[]'::json
            ) AS translations
     FROM techniques t
     ${lang ? "LEFT JOIN technique_translations tt ON tt.technique_id = t.id AND LOWER(tt.language_code) = LOWER($1)" : ""}
     WHERE t.deleted_at IS NULL
       ${q ? `AND (t.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(t.synonyms) syn WHERE syn ILIKE $${params.length}))` : ""}
     ORDER BY t.name`,
    params
  );
  res.json({ data: rows });
});

const TechniqueSchema = z.object({
  name: z.string().min(1),
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

async function upsertTechniqueTranslations(techniqueId: string, translations?: Array<{ lang: string; name?: string | null; description?: string | null }>) {
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
    "INSERT INTO techniques (id, name, description, icon, image_urls, synonyms) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, d.name, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? []]
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
    "UPDATE techniques SET name=$1, description=$2, icon=$3, image_urls=$4, synonyms=$5, updated_at=now() WHERE id=$6",
    [d.name, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? [], id]
  );
  await upsertTechniqueTranslations(id, d.translations);
  res.json({ success: true });
});

// POST /techniques/:id/merge — folds a duplicated technique into another.
// Registered before DELETE/PUT /:id so the literal "merge" segment can't be
// swallowed as an :id. Mirrors POST /tools/:id/merge and
// POST /ingredients/:id/merge; see techniques.local.ts's mergeTechniques()
// for the standalone twin.
//
// The catalogue collects duplicates on its own: Smart Import creates a
// technique per parsed step name, so an Italian recipe leaves "Bollitura"
// sitting next to the "Boil" an English one created. Unlike tools, a
// technique has no join table — only recipe_steps.technique_ids — so this
// is a single array rewrite.
const MergeTechniqueSchema = z.object({ targetId: z.string().uuid() });
techniquesRouter.post("/:id/merge", async (req: Request, res: Response) => {
  const { id: sourceId } = req.params;
  const parsed = MergeTechniqueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { targetId } = parsed.data;
  if (sourceId === targetId) return res.status(400).json({ error: "Cannot merge a technique into itself" });

  const rows = await query<{ id: string }>(
    "SELECT id FROM techniques WHERE id = ANY($1::uuid[])",
    [[sourceId, targetId]]
  );
  if (rows.length < 2) return res.status(404).json({ error: "Technique not found" });

  const affected = new Set<string>();
  for (const step of await query<{ id: string; recipe_id: string; technique_ids: string[] }>(
    "SELECT id, recipe_id, technique_ids FROM recipe_steps WHERE $1 = ANY(technique_ids)",
    [sourceId]
  )) {
    // Deduped: a step already listing BOTH must not end up with the target
    // twice.
    const replaced = Array.from(
      new Set((step.technique_ids ?? []).map((tid) => (tid === sourceId ? targetId : tid)))
    );
    await query("UPDATE recipe_steps SET technique_ids=$1 WHERE id=$2", [replaced, step.id]);
    affected.add(step.recipe_id);
  }

  await query("UPDATE techniques SET deleted_at=now(), updated_at=now() WHERE id=$1", [sourceId]);
  res.json({ data: { recipesUpdated: affected.size } });
});

techniquesRouter.delete("/:id", async (req: Request, res: Response) => {
  await query("UPDATE techniques SET deleted_at=now(), updated_at=now() WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});
