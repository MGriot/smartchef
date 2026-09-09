// ════════════════════════════════════════════════════════════════════════
// SmartChef — Recipe collections + cook history, standalone mode
//
// Ports backend/src/routes/collections.ts and the read side of
// backend/src/routes/cook-log.ts onto local SQLite. Both had no entry in
// localRouter.ts, so in standalone mode the Gallery's Collections tab, the
// "Add to collection" action on a recipe and the History calendar all
// silently made HTTP calls against a server that isn't there.
//
// The server's queries lean on Postgres json_agg to nest recipes inside a
// collection; SQLite has no equivalent worth using here, so the nesting is
// done in JS. The shapes are unchanged — snake_case rows with camelCase
// nested objects — because Home.tsx / CollectionDetail.tsx / RecipeDetail.tsx
// read them directly.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne, inPlaceholders, chunk } from '../db/local';

function newId(): string {
  return crypto.randomUUID();
}

/** Gallery list: each collection plus its item count and up to four cover
 *  images for the stacked thumbnail. */
export async function listCollections(): Promise<Array<Record<string, unknown>>> {
  const rows = await query<Record<string, unknown>>(
    `SELECT c.*, COUNT(cr.recipe_id) AS item_count
       FROM collections c
       LEFT JOIN collection_recipes cr ON cr.collection_id = c.id
      WHERE c.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
  );

  // One read for the whole page's cover thumbnails rather than one per
  // collection — the same batching listIngredients() and getRecipe() use,
  // and worth doing here too because every one of these is a native bridge
  // round-trip in standalone mode.
  const coversByCollection = new Map<string, string[]>();
  for (const batch of chunk(rows.map((r) => r.id as string))) {
    const p: unknown[] = [];
    const covers = await query<{ collection_id: string; cover: string | null }>(
      `SELECT cr.collection_id, r.cover_image_url AS cover
         FROM collection_recipes cr
         JOIN recipes r ON r.id = cr.recipe_id
        WHERE cr.collection_id IN (${inPlaceholders(p, batch)}) AND r.sync_status != 'deleted'
        ORDER BY cr.collection_id, cr.sort_order`,
      p,
    );
    // The four are picked here rather than with a LIMIT, which one query
    // cannot apply per collection without a window function.
    for (const c of covers) {
      if (!c.cover) continue;
      const list = coversByCollection.get(c.collection_id);
      if (!list) coversByCollection.set(c.collection_id, [c.cover]);
      else if (list.length < 4) list.push(c.cover);
    }
  }
  for (const row of rows) row.cover_images = coversByCollection.get(row.id as string) ?? [];
  return rows;
}

export async function getCollection(id: string): Promise<Record<string, unknown> | null> {
  const collection = await queryOne<Record<string, unknown>>(
    'SELECT * FROM collections WHERE id=$1 AND deleted_at IS NULL',
    [id],
  );
  if (!collection) return null;

  const recipes = await query<Record<string, unknown>>(
    `SELECT r.id, r.title, NULL AS translated_title, r.cover_image_url,
            r.difficulty, r.prep_time_min, r.cook_time_min
       FROM collection_recipes cr
       JOIN recipes r ON r.id = cr.recipe_id
      WHERE cr.collection_id = $1 AND r.sync_status != 'deleted'
      ORDER BY cr.sort_order`,
    [id],
  );
  return { ...collection, recipes };
}

export async function createCollection(input: { name: string; description?: string | null }): Promise<{ id: string }> {
  const id = newId();
  await query('INSERT INTO collections (id, name, description) VALUES ($1,$2,$3)', [
    id, input.name, input.description || null,
  ]);
  return { id };
}

export async function updateCollection(id: string, input: { name: string; description?: string | null }): Promise<boolean> {
  const existing = await queryOne<{ id: string }>('SELECT id FROM collections WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!existing) return false;
  await query(
    "UPDATE collections SET name=$1, description=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3",
    [input.name, input.description || null, id],
  );
  return true;
}

/** Soft delete, matching the server — the row stays so a later sync or an
 *  undo has something to work with. */
export async function deleteCollection(id: string): Promise<boolean> {
  const existing = await queryOne<{ id: string }>('SELECT id FROM collections WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!existing) return false;
  await query(
    "UPDATE collections SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [id],
  );
  return true;
}

export async function addRecipeToCollection(collectionId: string, recipeId: string): Promise<boolean> {
  const owned = await queryOne<{ id: string }>('SELECT id FROM collections WHERE id=$1 AND deleted_at IS NULL', [collectionId]);
  if (!owned) return false;
  const next = await queryOne<{ next: number }>(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM collection_recipes WHERE collection_id=$1',
    [collectionId],
  );
  // The composite primary key makes re-adding a no-op rather than an error,
  // same as the server's ON CONFLICT DO NOTHING.
  await query(
    'INSERT OR IGNORE INTO collection_recipes (collection_id, recipe_id, sort_order) VALUES ($1,$2,$3)',
    [collectionId, recipeId, next?.next ?? 0],
  );
  return true;
}

export async function removeRecipeFromCollection(collectionId: string, recipeId: string): Promise<void> {
  await query('DELETE FROM collection_recipes WHERE collection_id=$1 AND recipe_id=$2', [collectionId, recipeId]);
}

// ── Cook history ────────────────────────────────────────────────────────

/** Read side of the cook log, for the History calendar. The write side
 *  already worked offline — recipes.local.ts writes cook_log rows on "mark
 *  as cooked" — so this was a library people were filling up and could
 *  never read back. */
export async function listCookLog(from?: string | null, to?: string | null): Promise<Array<Record<string, unknown>>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from) {
    params.push(from);
    conditions.push(`cl.cooked_at >= $${params.length}`);
  }
  if (to) {
    // The server compares against `to::date + 1 day`; SQLite has no date
    // arithmetic operator here, so bound with the day AFTER `to` by string
    // comparison — cooked_at is stored as an ISO timestamp, so a plain
    // 'YYYY-MM-DD' bound is lexicographically correct.
    params.push(`${to}T99`);
    conditions.push(`cl.cooked_at < $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return query(
    `SELECT cl.id, cl.recipe_id AS recipeId, r.title AS recipeTitle,
            r.cover_image_url AS coverImageUrl, cl.cooked_at AS cookedAt,
            cl.cooked_by_name AS cookedByName
       FROM cook_log cl
       JOIN recipes r ON r.id = cl.recipe_id
       ${where}
      ORDER BY cl.cooked_at DESC`,
    params,
  );
}
