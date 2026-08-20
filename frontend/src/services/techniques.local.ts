// ════════════════════════════════════════════════════════════════════════
// SmartChef — Cooking techniques (standalone port)
// Ported from backend/src/routes/techniques.ts, following the same
// flat-fetch-then-assemble pattern as ingredients.local.ts's tool catalog
// CRUD (json_agg(...) translations subquery -> a separate flat query
// assembled here in TS). Was missing entirely until now — standalone mode
// had no local-router route for /api/techniques at all, so LibraryTechniques.tsx
// had no offline path (see localRouter.ts's dispatchTechniques()).
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale.
async function syncTechnique(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM techniques WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('techniques', id, row);
  } catch (err) {
    console.error('SmartChef sync (technique) failed:', err);
  }
}

export async function listTechniques({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM techniques WHERE deleted_at IS NULL ORDER BY name`);
  const result = [];
  for (const row of rows) {
    const translations = await query<{ language_code: string; name: string; description: string | null }>(
      `SELECT language_code, name, description FROM technique_translations WHERE technique_id = $1`,
      [row.id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null;
    result.push({
      ...row,
      image_urls: JSON.parse((row.image_urls as string) ?? '[]'),
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
    });
  }
  return result;
}

export interface TechniqueInput {
  id?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  imageUrls?: string[];
  translations?: Array<{ lang: string; name?: string | null; description?: string | null }>;
}

async function upsertTechniqueTranslations(techniqueId: string, translations?: TechniqueInput['translations']) {
  if (!translations) return;
  await query("DELETE FROM technique_translations WHERE technique_id=$1", [techniqueId]);
  for (const t of translations) {
    if (!t.lang || (!t.name && !t.description)) continue;
    await query(
      `INSERT INTO technique_translations (id, technique_id, language_code, name, description) VALUES ($1, $2, $3, $4, $5)`,
      [newId(), techniqueId, t.lang, t.name || null, t.description || null]
    );
  }
}

export async function createTechnique(d: TechniqueInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    "INSERT INTO techniques (id, name, description, icon, image_urls) VALUES ($1, $2, $3, $4, $5)",
    [id, d.name, d.description || null, d.icon || null, d.imageUrls || []]
  );
  await upsertTechniqueTranslations(id, d.translations);
  await syncTechnique(id);
  return { id };
}

export async function updateTechnique(id: string, d: TechniqueInput): Promise<void> {
  await query(
    "UPDATE techniques SET name=$1, description=$2, icon=$3, image_urls=$4, updated_at=now() WHERE id=$5",
    [d.name, d.description || null, d.icon || null, d.imageUrls || [], id]
  );
  await upsertTechniqueTranslations(id, d.translations);
  await syncTechnique(id);
}

// Matches the real backend route: a real soft delete (unlike tools' route,
// which never got switched over from a hard DELETE despite having the same
// deleted_at tombstone column — see ingredients.local.ts's deleteTool()).
export async function deleteTechnique(id: string): Promise<void> {
  await query("UPDATE techniques SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
  await syncTechnique(id);
}
