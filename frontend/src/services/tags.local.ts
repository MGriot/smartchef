// ════════════════════════════════════════════════════════════════════════
// SmartChef — Auto-tagging + tag catalog CRUD (standalone port)
// Auto-tagging ported from backend/src/services/tags.service.ts. Only real
// change: `exclude_tag_ids` is a JSON-encoded TEXT column here (not a
// Postgres UUID[]), so the `array_length(...) > 0` filter becomes a plain
// not-empty-JSON-array check plus a JS-side JSON.parse — everything else,
// including the presence-tag query, is unchanged.
//
// The catalog CRUD below (list/create/update/delete) is ported from
// backend/src/routes/tags.ts, following the same pattern as
// ingredients.local.ts's category/unit/tool CRUD — was missing entirely
// until now, which meant /api/tags had no local-router route at all and
// fell through to the native fetch path, throwing "No server configured"
// in standalone mode (caught individually where callers guard it, but
// fatal inside a Promise.all with sibling requests, e.g.
// LibraryIngredients.tsx's combined ingredients+categories+tags fetch).
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne, type LocalClient } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale.
async function syncTag(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM tags WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('tags', id, row);
  } catch (err) {
    console.error('SmartChef sync (tag) failed:', err);
  }
}

// ── Tag catalog CRUD ─────────────────────────────────────────────────────

export async function listTags({ lang, q }: { lang?: string; q?: string }) {
  const params: unknown[] = [];
  let where = `WHERE deleted_at IS NULL`;
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    where += ` AND (name LIKE $${params.length - 1} OR synonyms LIKE $${params.length})`;
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM tags ${where} ORDER BY sort_order, name`, params
  );
  const result = [];
  for (const row of rows) {
    const translations = await query<{ language_code: string; name: string }>(
      `SELECT language_code, name FROM tag_translations WHERE tag_id = $1`,
      [row.id]
    );
    const translatedName = lang ? translations.find(t => t.language_code.toLowerCase() === lang.toLowerCase())?.name ?? null : null;
    result.push({
      ...row,
      exclude_tag_ids: JSON.parse((row.exclude_tag_ids as string) ?? '[]'),
      synonyms: JSON.parse((row.synonyms as string) ?? '[]'),
      translated_name: translatedName,
      translations: translations.map(t => ({ lang: t.language_code, name: t.name })),
    });
  }
  return result;
}

export interface TagInput {
  id?: string;
  name: string;
  groupName?: string;
  color?: string | null;
  icon?: string | null;
  excludeTagIds?: string[];
  synonyms?: string[];
  translations?: Array<{ lang: string; name?: string }>;
}

async function upsertTagTranslations(tagId: string, translations?: TagInput['translations']) {
  if (!translations) return;
  await query("DELETE FROM tag_translations WHERE tag_id=$1", [tagId]);
  for (const t of translations) {
    if (!t.lang || !t.name) continue;
    await query(
      `INSERT INTO tag_translations (id, tag_id, language_code, name) VALUES ($1, $2, $3, $4)`,
      [newId(), tagId, t.lang, t.name]
    );
  }
}

export async function createTag(d: TagInput): Promise<{ id: string }> {
  const id = d.id ?? newId();
  await query(
    "INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids, synonyms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds ?? [], d.synonyms ?? []]
  );
  await upsertTagTranslations(id, d.translations);
  await syncTag(id);
  return { id };
}

export async function updateTag(id: string, d: TagInput): Promise<void> {
  await query(
    "UPDATE tags SET name=$1, group_name=$2, color=$3, icon=$4, exclude_tag_ids=$5, synonyms=$6, updated_at=now() WHERE id=$7",
    [d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds ?? [], d.synonyms ?? [], id]
  );
  await upsertTagTranslations(id, d.translations);
  await syncTag(id);
}

/** Strips `name` (case-insensitive) out of every recipe's tags array —
 *  used both when a catalog tag is deleted (below) and when a free-text
 *  custom tag is deleted directly (deleteCustomTagFromRecipes()), since
 *  either way the tag needs to actually stop appearing on recipes, not
 *  just disappear from wherever it happened to be managed. */
async function removeTagNameFromRecipes(name: string): Promise<{ recipesUpdated: number }> {
  const key = name.trim().toLowerCase();
  const recipes = await query<{ id: string; tags: string }>("SELECT id, tags FROM recipes WHERE sync_status != 'deleted'");
  const { syncRecipe } = await import('./recipes.local');
  let recipesUpdated = 0;
  for (const r of recipes) {
    const tagsArr: string[] = JSON.parse(r.tags ?? '[]');
    if (!tagsArr.some(t => t.trim().toLowerCase() === key)) continue;
    const filtered = tagsArr.filter(t => t.trim().toLowerCase() !== key);
    await query("UPDATE recipes SET tags=$1, updated_at=now() WHERE id=$2", [filtered, r.id]);
    await syncRecipe(r.id);
    recipesUpdated++;
  }
  return { recipesUpdated };
}

export async function deleteTag(id: string): Promise<{ recipesUpdated: number }> {
  const tag = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [id]);
  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
  await syncTag(id);
  return tag ? await removeTagNameFromRecipes(tag.name) : { recipesUpdated: 0 };
}

/** Deletes a free-text custom tag (no catalog row to tombstone) by simply
 *  stripping it out of every recipe that carries it. */
export async function deleteCustomTag(name: string): Promise<{ recipesUpdated: number }> {
  return removeTagNameFromRecipes(name);
}

/** Folds a mistakenly-duplicated catalog tag into another one — every
 *  recipe carrying it (by name — recipes.tags is free text, not ids),
 *  every ingredient tagged with it, and every other tag's `excludeTagIds`
 *  (the diet auto-tag exclusion list) referencing it are all repointed to
 *  the target, then the source is tombstoned. Same shape as
 *  mergeIngredients() in ingredients.local.ts. */
export async function mergeTags(sourceId: string, targetId: string): Promise<{ recipesUpdated: number }> {
  if (sourceId === targetId) throw new Error('Cannot merge a tag into itself');
  const source = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [sourceId]);
  const target = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [targetId]);
  if (!source || !target) throw new Error('Tag not found');

  await query(
    "INSERT INTO ingredient_tags (ingredient_id, tag_id) SELECT ingredient_id, $1 FROM ingredient_tags WHERE tag_id=$2 ON CONFLICT DO NOTHING",
    [targetId, sourceId]
  );
  await query("DELETE FROM ingredient_tags WHERE tag_id=$1", [sourceId]);

  for (const row of await query<{ id: string; exclude_tag_ids: string }>("SELECT id, exclude_tag_ids FROM tags WHERE exclude_tag_ids != '[]'")) {
    const ids: string[] = JSON.parse(row.exclude_tag_ids || '[]');
    if (!ids.includes(sourceId)) continue;
    const replaced = Array.from(new Set(ids.map(id => id === sourceId ? targetId : id)));
    await query("UPDATE tags SET exclude_tag_ids=$1 WHERE id=$2", [replaced, row.id]);
  }

  const { recipesUpdated } = await mergeCustomTagIntoTag(source.name, targetId);

  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [sourceId]);
  await syncTag(sourceId);
  await syncTag(targetId);
  return { recipesUpdated };
}

/** Reassigns every tag currently filed under `sourceGroup` to
 *  `targetGroup` instead — group_name is free text with no separate
 *  "groups" table (LibraryTags.tsx's own datalist just suggests existing
 *  values), so "merging" two groups is just a bulk rename of that column
 *  across whichever tags carried the old name. */
export async function mergeTagGroups(sourceGroup: string, targetGroup: string): Promise<{ tagsUpdated: number }> {
  const rows = await query<{ id: string }>("SELECT id FROM tags WHERE group_name=$1 AND deleted_at IS NULL", [sourceGroup]);
  for (const row of rows) {
    await query("UPDATE tags SET group_name=$1, updated_at=now() WHERE id=$2", [targetGroup, row.id]);
    await syncTag(row.id);
  }
  return { tagsUpdated: rows.length };
}

// ── Custom (not-in-catalog) tags ─────────────────────────────────────────
// recipes.tags is free TEXT (a JSON array of plain names, not tag ids) —
// nothing stops a recipe from carrying a name that was never added to the
// managed catalog (typed straight into TagPicker's "by name" mode, or
// inherited from an import). Surfaced here so Library > Tags can offer
// "add to catalog" / "merge into an existing tag" for whatever's actually
// in use but not yet managed, the same idea as mergeIngredients() in
// ingredients.local.ts but keyed by name instead of id since that's all a
// free-text recipe tag ever has.

export interface CustomTagUsage { name: string; count: number }

export async function listCustomTagsInUse(): Promise<CustomTagUsage[]> {
  const catalogNames = new Set(
    (await query<{ name: string }>("SELECT name FROM tags WHERE deleted_at IS NULL")).map(t => t.name.toLowerCase())
  );
  const recipes = await query<{ tags: string }>("SELECT tags FROM recipes WHERE sync_status != 'deleted'");
  const counts = new Map<string, { name: string; count: number }>();
  for (const r of recipes) {
    const tags: string[] = JSON.parse(r.tags ?? '[]');
    for (const raw of tags) {
      const name = raw.trim();
      if (!name || catalogNames.has(name.toLowerCase())) continue;
      const key = name.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { name, count: 1 });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Rewrites every recipe carrying `customName` (case-insensitive) to carry
 *  `targetTagId`'s canonical name instead — the free-text equivalent of
 *  ingredients.local.ts's mergeIngredients(). Doesn't touch the catalog
 *  (there's no catalog row for a name that was never added to it). */
export async function mergeCustomTagIntoTag(customName: string, targetTagId: string): Promise<{ recipesUpdated: number }> {
  const target = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1 AND deleted_at IS NULL", [targetTagId]);
  if (!target) throw new Error('Target tag not found');

  const key = customName.trim().toLowerCase();
  const recipes = await query<{ id: string; tags: string }>("SELECT id, tags FROM recipes WHERE sync_status != 'deleted'");
  const { syncRecipe } = await import('./recipes.local');
  let recipesUpdated = 0;
  for (const r of recipes) {
    const tags: string[] = JSON.parse(r.tags ?? '[]');
    if (!tags.some(t => t.trim().toLowerCase() === key)) continue;
    const merged = new Map<string, string>();
    for (const t of tags) {
      const trimmed = t.trim().toLowerCase() === key ? target.name : t.trim();
      if (!trimmed) continue;
      merged.set(trimmed.toLowerCase(), trimmed);
    }
    await query("UPDATE recipes SET tags=$1, updated_at=now() WHERE id=$2", [Array.from(merged.values()), r.id]);
    await syncRecipe(r.id);
    recipesUpdated++;
  }
  return { recipesUpdated };
}

export async function computeAutoTagNames(client: LocalClient, recipeId: string): Promise<string[]> {
  const presentRows = await client.query<{ id: string; name: string }>(
    `SELECT DISTINCT t.id, t.name
     FROM recipe_ingredients ri
     JOIN ingredient_tags it ON it.ingredient_id = ri.ingredient_id
     JOIN tags t ON t.id = it.tag_id
     WHERE ri.recipe_id = $1 AND ri.ingredient_id IS NOT NULL`,
    [recipeId]
  );
  const presentTagIds = new Set(presentRows.rows.map(r => r.id));
  const names = new Set(presentRows.rows.map(r => r.name));

  const dietRows = await client.query<{ name: string; exclude_tag_ids: string }>(
    `SELECT name, exclude_tag_ids FROM tags WHERE exclude_tag_ids != '[]'`
  );
  for (const tag of dietRows.rows) {
    const excludeIds: string[] = JSON.parse(tag.exclude_tag_ids || '[]');
    const excluded = excludeIds.some(id => presentTagIds.has(id));
    if (!excluded) names.add(tag.name);
  }

  return Array.from(names);
}

/** Case-insensitive union, keeping the first-seen casing for each name. */
export function unionTagNames(...lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const name of list) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values());
}
