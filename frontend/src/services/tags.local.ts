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

export async function listTags({ lang }: { lang?: string }) {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY sort_order, name`
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
    "INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds ?? []]
  );
  await upsertTagTranslations(id, d.translations);
  await syncTag(id);
  return { id };
}

export async function updateTag(id: string, d: TagInput): Promise<void> {
  await query(
    "UPDATE tags SET name=$1, group_name=$2, color=$3, icon=$4, exclude_tag_ids=$5, updated_at=now() WHERE id=$6",
    [d.name, d.groupName || 'Altro', d.color || null, d.icon || null, d.excludeTagIds ?? [], id]
  );
  await upsertTagTranslations(id, d.translations);
  await syncTag(id);
}

export async function deleteTag(id: string): Promise<void> {
  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [id]);
  await syncTag(id);
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
