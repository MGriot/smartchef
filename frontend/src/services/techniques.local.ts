// ════════════════════════════════════════════════════════════════════════
// SmartChef — Cooking techniques (standalone port)
// Ported from backend/src/routes/techniques.ts, following the same
// flat-fetch-then-assemble pattern as ingredients.local.ts's tool catalog
// CRUD (json_agg(...) translations subquery -> a separate flat query
// assembled here in TS). Was missing entirely until now — standalone mode
// had no local-router route for /api/techniques at all, so LibraryTechniques.tsx
// had no offline path (see localRouter.ts's dispatchTechniques()).
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne, chunk, inPlaceholders } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale — also exported for conflicts.local.ts, same
// reason as ingredients.local.ts's syncIngredient()/syncTool().
export async function syncTechnique(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM techniques WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('techniques', id, row);
  } catch (err) {
    console.error('SmartChef sync (technique) failed:', err);
  }
}

/** Re-serializes every technique into the Hidden Clone — see
 *  tags.local.ts's resyncAllTags() for why this was missing and what it's
 *  for. Includes soft-deleted techniques too, matching
 *  ingredients.local.ts's resyncAllTools(). */
export async function resyncAllTechniques(onProgress?: (done: number, total: number) => void): Promise<number> {
  const rows = await query<{ id: string }>('SELECT id FROM techniques');
  for (let i = 0; i < rows.length; i++) {
    await syncTechnique(rows[i].id);
    onProgress?.(i + 1, rows.length);
  }
  return rows.length;
}

export async function listTechniques({ lang, q }: { lang?: string; q?: string }) {
  const params: unknown[] = [];
  let where = `WHERE deleted_at IS NULL`;
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    let clause = `name LIKE $${params.length - 1} OR synonyms LIKE $${params.length}`;
    // Same translated-name search as ingredients.local.ts's listIngredients()
    // — the Import review step searches techniques through the same UI.
    if (lang) {
      params.push(`%${q}%`, lang);
      clause += ` OR EXISTS (SELECT 1 FROM technique_translations tr
                             WHERE tr.technique_id = techniques.id
                               AND tr.name LIKE $${params.length - 1}
                               AND LOWER(tr.language_code) = LOWER($${params.length}))`;
    }
    where += ` AND (${clause})`;
  }
  const rows = await query<Record<string, unknown>>(`SELECT * FROM techniques ${where} ORDER BY name`, params);
  // Batched rather than one translation query per technique. This list is on
  // the recipe page's critical path — RecipeDetail.tsx fetches
  // /api/techniques on every recipe open, in every mode, because it needs
  // them to resolve {{tech:id}} tokens in step text — so the per-row version
  // put one Capacitor bridge round-trip per technique in front of every
  // recipe the user opened, growing with the technique catalog rather than
  // with the recipe.
  const translationsByTechniqueId = new Map<string, Array<{ language_code: string; name: string; description: string | null }>>();
  for (const batch of chunk(rows.map(r => r.id as string))) {
    const p: unknown[] = [];
    const trs = await query<{ technique_id: string; language_code: string; name: string; description: string | null }>(
      `SELECT technique_id, language_code, name, description FROM technique_translations
       WHERE technique_id IN (${inPlaceholders(p, batch)}) ORDER BY rowid`,
      p
    );
    for (const t of trs) {
      const list = translationsByTechniqueId.get(t.technique_id);
      if (list) list.push(t);
      else translationsByTechniqueId.set(t.technique_id, [t]);
    }
  }

  return rows.map(row => {
    const translations = translationsByTechniqueId.get(row.id as string) ?? [];
    return {
      ...row,
      image_urls: JSON.parse((row.image_urls as string) ?? '[]'),
      synonyms: JSON.parse((row.synonyms as string) ?? '[]'),
      translated_name: lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name, description: t.description })),
    };
  });
}

export interface TechniqueInput {
  id?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  imageUrls?: string[];
  synonyms?: string[];
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
    "INSERT INTO techniques (id, name, description, icon, image_urls, synonyms) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, d.name, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? []]
  );
  await upsertTechniqueTranslations(id, d.translations);
  await syncTechnique(id);
  return { id };
}

export async function updateTechnique(id: string, d: TechniqueInput): Promise<void> {
  await query(
    "UPDATE techniques SET name=$1, description=$2, icon=$3, image_urls=$4, synonyms=$5, updated_at=now() WHERE id=$6",
    [d.name, d.description || null, d.icon || null, d.imageUrls || [], d.synonyms ?? [], id]
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

/** Folds a duplicated technique into another one — the catalogue fills up
 *  with the same technique under two names (Smart Import creates one per
 *  parsed step name, so an Italian recipe leaves "Bollitura" next to the
 *  "Boil" an English one created), and merging is what puts that right
 *  without breaking the steps already pointing at either.
 *
 *  Simpler than the tool merge next door: a technique has no join table at
 *  all, only `recipe_steps.technique_ids`, a JSON array of ids. Translations
 *  and photos on the source are discarded — the target's own are what a
 *  merge keeps, same rule as everywhere else. */
export async function mergeTechniques(sourceId: string, targetId: string): Promise<{ recipesUpdated: number }> {
  if (sourceId === targetId) throw new Error('Cannot merge a technique into itself');
  const source = await queryOne<{ id: string }>("SELECT id FROM techniques WHERE id=$1", [sourceId]);
  const target = await queryOne<{ id: string }>("SELECT id FROM techniques WHERE id=$1 AND deleted_at IS NULL", [targetId]);
  if (!source || !target) throw new Error('Technique not found');

  const affected = new Set<string>();
  for (const step of await query<{ id: string; recipe_id: string; technique_ids: string }>(
    "SELECT id, recipe_id, technique_ids FROM recipe_steps WHERE technique_ids LIKE $1", [`%${sourceId}%`],
  )) {
    const ids: string[] = JSON.parse(step.technique_ids || '[]');
    if (!ids.includes(sourceId)) continue;
    // Deduped: a step that already listed BOTH must not end up with the
    // target twice.
    const replaced = Array.from(new Set(ids.map((id) => (id === sourceId ? targetId : id))));
    await query("UPDATE recipe_steps SET technique_ids=$1 WHERE id=$2", [replaced, step.id]);
    affected.add(step.recipe_id);
  }

  await deleteTechnique(sourceId);
  await syncTechnique(targetId);

  const { syncRecipe } = await import('./recipes.local');
  for (const recipeId of affected) await syncRecipe(recipeId);

  return { recipesUpdated: affected.size };
}
