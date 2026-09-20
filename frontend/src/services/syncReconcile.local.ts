// ════════════════════════════════════════════════════════════════════════
// SmartChef — two-way reconciliation between Local Storage and the repo
//
// A sync compares git trees. It never looked at whether this device's own
// database still matched its own files, and the two drifted apart in both
// directions, silently, for good:
//   - database ahead of the repo: a save whose file write failed (the
//     serializers swallow their errors), or a row changed by a path that
//     never re-serialized. Nothing re-published it, so other devices never
//     heard of the change;
//   - repo ahead of the database: a merge whose database write threw, or an
//     entity that failed to be created. The merge commit already records
//     the change as taken, so no later merge brings it again.
//
// Every sync now settles both, the way `git status` finds what differs
// between working copy and HEAD — but cheaply, without re-reading every file:
//   - push: sync_index remembers each row's updated_at as of its last file
//     write. A row whose updated_at moved since is re-serialized, committed
//     and pushed with the rest of the cycle.
//   - pull: entities in HEAD with no row here, and every entity a merge
//     failed to write (sync_repair), are applied from HEAD.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import { getEntityTable, resyncEntityToGit, forceApplyEntity } from './conflicts.local';
import { unitSymbolsFromSteps } from '../lib/sync/referenceHeal';

/** Every synced entity type, in the order writes must happen: categories
 *  and units before the ingredients that name them, and so on — the same
 *  order mergeBridge.ts merges in. */
export const RECONCILE_TYPES = ['category', 'unit', 'tag', 'tool', 'technique', 'ingredient', 'profile', 'recipe'] as const;

/** Records that `entityType:id`'s file now reflects the row as of `updatedAt`. */
/** Bookkeeping only: never fails the write it is recording — at worst the
 *  row is re-published once more than needed. */
export async function recordSynced(entityType: string, entityId: string, updatedAt: unknown): Promise<void> {
  try {
    if (!getEntityTable(entityType)) return;
    await query(
      `INSERT INTO sync_index (entity_type, entity_id, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET updated_at = excluded.updated_at`,
      [entityType, entityId, typeof updatedAt === 'string' ? updatedAt : null]
    );
  } catch (err) {
    console.warn('SmartChef: recording sync state failed:', err);
  }
}

/** Declares every current row in step with the repo — after a replace or a
 *  repair has just made the two identical. */
export async function markAllInSync(): Promise<void> {
  try {
    for (const entityType of RECONCILE_TYPES) {
      const info = getEntityTable(entityType);
      if (!info?.hasUpdatedAt) continue;
      await query(
        `INSERT INTO sync_index (entity_type, entity_id, updated_at)
         SELECT $1, id, updated_at FROM ${info.table} WHERE true
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET updated_at = excluded.updated_at`,
        [entityType]
      );
    }
  } catch (err) {
    console.warn('SmartChef: recording sync state failed:', err);
  }
}

/** Rows changed since their file was last written — never written at all
 *  included. Units have no updated_at and are published by their own
 *  writes only. */
export async function findRowsAheadOfRepo(): Promise<Array<{ entityType: string; entityId: string }>> {
  const out: Array<{ entityType: string; entityId: string }> = [];
  for (const entityType of RECONCILE_TYPES) {
    const info = getEntityTable(entityType);
    if (!info?.hasUpdatedAt) continue;
    const rows = await query<{ id: string }>(
      `SELECT t.id FROM ${info.table} t
         LEFT JOIN sync_index s ON s.entity_type = $1 AND s.entity_id = t.id
        WHERE (s.entity_id IS NULL OR s.updated_at IS NOT t.updated_at)
          -- A row waiting on a repair is BEHIND the repo, not ahead of it:
          -- publishing it would undo the merge it failed to take.
          AND NOT EXISTS (SELECT 1 FROM sync_repair r WHERE r.entity_type = $1 AND r.entity_id = t.id)`,
      [entityType]
    );
    for (const r of rows) out.push({ entityType, entityId: r.id });
  }
  return out;
}

/** Push direction: re-serializes every row ahead of the repo. Must run
 *  OUTSIDE the git queue — each write queues on it itself. */
export async function publishRowsAheadOfRepo(): Promise<number> {
  const rows = await findRowsAheadOfRepo();
  for (const { entityType, entityId } of rows) await resyncEntityToGit(entityType, entityId);
  return rows.length;
}

/** Every column that references a unit — the list db/local.ts's portable
 *  rekey rewrites too. */
const UNIT_REFERENCES = [
  ['recipe_ingredients', 'unit_id'], ['recipes', 'yield_unit_id'],
  ['pantry_items', 'unit_id'], ['shopping_list_items', 'unit_id'],
] as const;

/** Rows pointing at a unit this device doesn't have — a pre-portable id
 *  from some device's old random seed — show their amounts with no unit.
 *  The merge-time heal (referenceHeal.ts) only sees the recipe being merged
 *  and only when it is merged, so a row nobody's copy of that recipe could
 *  resolve stays broken on every device. Step amounts anywhere in the
 *  library still pair such ids with their symbol: resolve against all of
 *  them, rewrite the rows, and bump the recipes so their files carry the
 *  fix to the other devices. */
export async function repairUnknownUnitRefs(): Promise<{ fixed: number; unresolved: number }> {
  const stepRows = await query<{ step_ingredients: string | null }>(
    `SELECT step_ingredients FROM recipe_steps WHERE step_ingredients LIKE '%unitSymbol%'`
  );
  const symbols = unitSymbolsFromSteps(stepRows);
  const bySymbol = new Map<string, string>();
  for (const u of await query<{ id: string; symbol: string }>(`SELECT id, symbol FROM units`)) {
    const key = u.symbol?.toLowerCase();
    // Prefer the portable id when a symbol has both.
    if (key && (!bySymbol.has(key) || u.id.startsWith('unit-'))) bySymbol.set(key, u.id);
  }

  let fixed = 0;
  let unresolved = 0;
  const touchedRecipes = new Set<string>();
  for (const [table, column] of UNIT_REFERENCES) {
    const dangling = await query<{ id: string; n: number }>(
      `SELECT t.${column} AS id, COUNT(*) AS n FROM ${table} t
         LEFT JOIN units u ON u.id = t.${column}
        WHERE t.${column} IS NOT NULL AND t.${column} <> '' AND u.id IS NULL
        GROUP BY t.${column}`
    );
    for (const { id, n } of dangling) {
      const symbol = symbols.get(id);
      const target = symbol ? bySymbol.get(symbol.toLowerCase()) : undefined;
      if (!target) {
        unresolved += Number(n);
        continue;
      }
      if (table === 'recipe_ingredients' || table === 'recipes') {
        const owner = table === 'recipes' ? 'id' : 'recipe_id';
        for (const r of await query<{ rid: string }>(`SELECT DISTINCT ${owner} AS rid FROM ${table} WHERE ${column} = $1`, [id])) {
          touchedRecipes.add(r.rid);
        }
      }
      await query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [target, id]);
      fixed += Number(n);
    }
  }
  for (const rid of touchedRecipes) await query(`UPDATE recipes SET updated_at = now() WHERE id = $1`, [rid]);
  return { fixed, unresolved };
}

/** Two seeds of the same twelve categories met in one library — the
 *  Italian-named one every device created on first run ("Carni") and the
 *  portable English one ("Meat", whose Italian translation is "Carni") —
 *  and cleaning up by hand deleted one of each pair, but not consistently:
 *  "Meat" was deleted while still holding every meat ingredient, "Carni"
 *  was kept empty. Deleting a category never moved its ingredients, so they
 *  fell out of every category into "Uncategorized".
 *
 *  Settled here, every sync, by two rules:
 *   - a category whose name is another category's translation is that
 *     category twice: its ingredients move over and it is deleted;
 *   - a deleted category that still holds ingredients is restored — a
 *     category is only really gone once nothing is filed under it. */
export async function repairCategories(): Promise<{ moved: number; restored: number; folded: number }> {
  const cats = await query<{ id: string; name: string; deleted_at: string | null }>(`SELECT id, name, deleted_at FROM ingredient_categories`);
  const trs = await query<{ category_id: string; name: string }>(`SELECT category_id, name FROM ingredient_category_translations`);
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLocaleLowerCase();
  const namesOf = new Map<string, Set<string>>();
  for (const c of cats) namesOf.set(c.id, new Set([norm(c.name)]));
  for (const t of trs) namesOf.get(t.category_id)?.add(norm(t.name));

  let moved = 0;
  let folded = 0;
  for (const twin of cats) {
    const key = norm(twin.name);
    // The canonical category lists this name among its translations, while
    // the twin knows nothing of the canonical one's own name.
    const target = cats.find((c) => c.id !== twin.id && namesOf.get(c.id)!.has(key) && norm(c.name) !== key
      && !namesOf.get(twin.id)!.has(norm(c.name)));
    if (!target) continue;
    const n = (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ingredients WHERE category_id = $1`, [twin.id]))?.n ?? 0;
    if (n > 0) {
      await query(`UPDATE ingredients SET category_id = $1, updated_at = now() WHERE category_id = $2`, [target.id, twin.id]);
      moved += Number(n);
    }
    if (!twin.deleted_at) {
      await query(`UPDATE ingredient_categories SET deleted_at = now(), updated_at = now() WHERE id = $1`, [twin.id]);
      folded++;
    }
  }

  const orphaned = await query<{ id: string }>(
    `SELECT c.id FROM ingredient_categories c
      WHERE c.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM ingredients i WHERE i.category_id = c.id AND COALESCE(i.sync_status, '') != 'deleted')`
  );
  for (const c of orphaned) await query(`UPDATE ingredient_categories SET deleted_at = NULL, updated_at = now() WHERE id = $1`, [c.id]);
  return { moved, restored: orphaned.length, folded };
}

export async function queueRepair(entityType: string, entityId: string, error: string): Promise<void> {
  try {
    await query(
      `INSERT INTO sync_repair (entity_type, entity_id, error, attempts) VALUES ($1, $2, $3, 0)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET error = excluded.error`,
      [entityType, entityId, error]
    );
  } catch (err) {
    console.warn('SmartChef: queueing a repair failed:', err);
  }
}

/** Ids of the rows this device holds, per type. */
async function localIds(entityType: string): Promise<Set<string>> {
  const info = getEntityTable(entityType);
  if (!info) return new Set();
  return new Set((await query<{ id: string }>(`SELECT id FROM ${info.table}`)).map((r) => r.id));
}

export interface PullOutcome {
  applied: number;
  failed: Array<{ entityType: string; entityId: string; error: string }>;
}

/** Pull direction: makes the database hold what HEAD holds, for every
 *  entity HEAD has and this database lacks, and every queued repair.
 *  `headIds` lists HEAD's entity ids per type; `readHead` reads one entity
 *  file from HEAD. Units are skipped for missing rows — a unit is the one
 *  thing this app hard-deletes, and recreating it would undo the delete. */
export async function pullRepoIntoDatabase(
  headIds: Map<string, string[]>,
  readHead: (entityType: string, entityId: string) => Promise<Record<string, unknown> | null>,
): Promise<PullOutcome> {
  const outcome: PullOutcome = { applied: 0, failed: [] };
  const repairs = await query<{ entity_type: string; entity_id: string }>(`SELECT entity_type, entity_id FROM sync_repair`);
  const repairKeys = new Set(repairs.map((r) => `${r.entity_type}:${r.entity_id}`));

  for (const entityType of RECONCILE_TYPES) {
    const have = await localIds(entityType);
    const wanted = new Set(repairs.filter((r) => r.entity_type === entityType).map((r) => r.entity_id));
    if (entityType !== 'unit') {
      for (const id of headIds.get(entityType) ?? []) if (!have.has(id)) wanted.add(id);
    }
    const entries: Array<{ entityId: string; json: Record<string, unknown> | null }> = [];
    for (const entityId of wanted) entries.push({ entityId, json: await readHead(entityType, entityId).catch(() => null) });
    // Base ingredients before their varieties, as mergeBridge.ts writes them.
    entries.sort((a, b) => Number(!!a.json?.parent_ingredient_id) - Number(!!b.json?.parent_ingredient_id));
    for (const { entityId, json } of entries) {
      const key = `${entityType}:${entityId}`;
      try {
        if (!json) {
          if (repairKeys.has(key)) await query(`DELETE FROM sync_repair WHERE entity_type = $1 AND entity_id = $2`, [entityType, entityId]);
          continue;
        }
        await forceApplyEntity(entityType, entityId, json);
        const info = getEntityTable(entityType);
        const row = info?.hasUpdatedAt ? await queryOne<{ updated_at: string | null }>(`SELECT updated_at FROM ${info.table} WHERE id = $1`, [entityId]) : null;
        await recordSynced(entityType, entityId, row?.updated_at ?? json.updated_at);
        await query(`DELETE FROM sync_repair WHERE entity_type = $1 AND entity_id = $2`, [entityType, entityId]);
        outcome.applied++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await query(
          `INSERT INTO sync_repair (entity_type, entity_id, error, attempts) VALUES ($1, $2, $3, 1)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET error = excluded.error, attempts = sync_repair.attempts + 1`,
          [entityType, entityId, error]
        );
        outcome.failed.push({ entityType, entityId, error });
      }
    }
  }
  return outcome;
}
