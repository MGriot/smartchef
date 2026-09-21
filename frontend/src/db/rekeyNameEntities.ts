// ════════════════════════════════════════════════════════════════════════
// SmartChef — moving tools, techniques and tags onto portable ids
//
// The same story ADR 0006 already told about categories and units, one
// release late. These three were still created with crypto.randomUUID(),
// so the same real-world "Frusta" was an unrelated id on every device —
// and unlike a category, each of these tables carries a UNIQUE index on the
// active name, so the second device could not even insert the first
// device's row. That threw `UNIQUE constraint failed` inside the merge,
// which failed the entity, which was queued for repair, which was retried
// and failed identically on every single sync, forever.
//
// This moves existing rows onto `tool-<slug>` / `technique-<slug>` /
// `tag-<slug>` and repoints everything that references them. Runs at every
// start and is a no-op once every row is re-keyed.
//
// ── Two deliberate choices ──────────────────────────────────────────────
//
// 1. The loser id is recorded in `sync_alias`, NOT tombstoned. A category
//    id is private to its device, so rekeyPortableIds() can simply delete
//    the old row. A tool id is not: it is referenced from every other
//    device's recipes, and a Deletion Marker on it would delete a
//    not-yet-upgraded device's live tool. An alias absorbs the stale
//    entity files instead, for as long as they keep arriving.
//
// 2. Foreign keys stay ON. The obvious migration idiom is to switch them
//    off, but the write order below is FK-safe by construction — insert
//    the new parent, repoint the children, delete the old children, delete
//    the old parent — so disabling enforcement could only hide a genuine
//    mistake. It would also be unreliable: `PRAGMA foreign_keys` behaves
//    differently across the two platform plugins (see applyWriteJournalPragmas).
//
// Columns are read from PRAGMA table_info rather than written out here.
// rekeyPortableIds() hardcodes its column lists, which means any column a
// later release adds through addColumnIfMissing() is silently dropped by
// the re-key. That trap is not worth reproducing three more times.
// ════════════════════════════════════════════════════════════════════════

import type { SQLiteDBConnection } from '@capacitor-community/sqlite';

interface NameEntitySpec {
  table: 'tools' | 'techniques' | 'tags';
  /** The singular entity type, as mergeBridge.ts/sync_* tables spell it. */
  entityType: 'tool' | 'technique' | 'tag';
  prefix: string;
  /** Join tables with a composite primary key: union then delete, never a
   *  plain UPDATE — a recipe may already carry BOTH ids, and updating one
   *  onto the other trips the PK. */
  joins: Array<{ table: string; column: string; owner: string }>;
  /** Plain FK columns where a straight UPDATE is safe. Repointed BEFORE
   *  the old row is deleted: these cascade, so the other order would wipe
   *  every translation the row had. */
  refs: Array<{ table: string; column: string }>;
  /** JSON text arrays of ids. `owner` names the recipe column when the
   *  rewrite should mark a recipe as changed. */
  jsonRefs: Array<{ table: string; column: string; owner: string | null }>;
}

const SPECS: NameEntitySpec[] = [
  {
    table: 'tools',
    entityType: 'tool',
    prefix: 'tool-',
    joins: [{ table: 'recipe_tools', column: 'tool_id', owner: 'recipe_id' }],
    refs: [{ table: 'tool_translations', column: 'tool_id' }],
    jsonRefs: [{ table: 'recipe_steps', column: 'tool_ids', owner: 'recipe_id' }],
  },
  {
    table: 'techniques',
    entityType: 'technique',
    prefix: 'technique-',
    joins: [],
    refs: [{ table: 'technique_translations', column: 'technique_id' }],
    jsonRefs: [{ table: 'recipe_steps', column: 'technique_ids', owner: 'recipe_id' }],
  },
  {
    table: 'tags',
    entityType: 'tag',
    prefix: 'tag-',
    joins: [{ table: 'ingredient_tags', column: 'tag_id', owner: 'ingredient_id' }],
    refs: [{ table: 'tag_translations', column: 'tag_id' }],
    // recipes.tags holds tag NAMES, not ids (recipes.local.ts
    // unionTagNames), so it is deliberately absent here.
    jsonRefs: [{ table: 'tags', column: 'exclude_tag_ids', owner: null }],
  },
];

/** Must stay identical to syncExtras.local.ts's slugify() and
 *  db/local.ts's portableSlug(), or two devices derive different ids for
 *  the same name. Passed in rather than re-implemented for that reason. */
type Slugify = (text: string) => string;

async function tableColumns(db: SQLiteDBConnection, table: string): Promise<string[]> {
  const info = await db.query(`PRAGMA table_info(${table})`);
  return ((info.values ?? []) as Array<{ name: string }>).map((r) => r.name);
}

/** Rewrites one JSON id array, returning null when the id is not in it. */
function replaceInJsonArray(raw: string | null, oldId: string, newId: string): string | null {
  let ids: unknown;
  try {
    ids = JSON.parse(raw || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || !ids.includes(oldId)) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const mapped = id === oldId ? newId : id;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return JSON.stringify(out);
}

export async function rekeyNameEntityIds(db: SQLiteDBConnection, slugify: Slugify): Promise<number> {
  let rekeyed = 0;
  const touchedRecipes = new Set<string>();

  for (const spec of SPECS) {
    const rows = ((await db.query(`SELECT id, name FROM ${spec.table}`)).values ?? []) as Array<{ id: string; name: string }>;
    const taken = new Set(rows.map((r) => r.id));
    const columns = await tableColumns(db, spec.table);
    const carried = columns.filter((c) => c !== 'id' && c !== 'name');
    const carriedSql = carried.length ? `, ${carried.join(', ')}` : '';

    for (const row of rows) {
      if (!row.name || row.id.startsWith(spec.prefix)) continue;
      const target = `${spec.prefix}${slugify(row.name)}`;
      // Another row already owns that name's id — two genuinely different
      // things whose names slugify alike. It keeps its random id, exactly
      // as rekeyPortableIds() leaves such a row alone.
      if (taken.has(target)) continue;
      taken.add(target);

      // The active-name unique index would reject a second row with this
      // name while both exist, so the old one steps aside first.
      await db.run(`UPDATE ${spec.table} SET name = name || ' (rekey ' || id || ')' WHERE id = ?`, [row.id]);
      await db.run(
        `INSERT INTO ${spec.table} (id, name${carriedSql}) SELECT ?, ?${carriedSql} FROM ${spec.table} WHERE id = ?`,
        [target, row.name, row.id]
      );

      for (const ref of spec.refs) {
        await db.run(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`, [target, row.id]);
      }

      for (const join of spec.joins) {
        if (join.owner === 'recipe_id') {
          for (const r of ((await db.query(`SELECT recipe_id FROM ${join.table} WHERE ${join.column} = ?`, [row.id])).values ?? []) as Array<{ recipe_id: string }>) {
            touchedRecipes.add(r.recipe_id);
          }
        }
        await db.run(
          `INSERT INTO ${join.table} (${join.owner}, ${join.column}) SELECT ${join.owner}, ? FROM ${join.table} WHERE ${join.column} = ? ON CONFLICT DO NOTHING`,
          [target, row.id]
        );
        await db.run(`DELETE FROM ${join.table} WHERE ${join.column} = ?`, [row.id]);
      }

      for (const json of spec.jsonRefs) {
        const owner = json.owner ? `, ${json.owner}` : '';
        const hits = ((await db.query(
          `SELECT id, ${json.column}${owner} FROM ${json.table} WHERE ${json.column} LIKE ?`,
          [`%${row.id}%`]
        )).values ?? []) as Array<Record<string, string | null>>;
        for (const hit of hits) {
          const replaced = replaceInJsonArray(hit[json.column], row.id, target);
          if (replaced === null) continue;
          await db.run(`UPDATE ${json.table} SET ${json.column} = ? WHERE id = ?`, [replaced, hit.id]);
          if (json.owner && hit[json.owner]) touchedRecipes.add(hit[json.owner] as string);
        }
      }

      await db.run(
        `INSERT INTO sync_alias (entity_type, foreign_id, local_id) VALUES (?, ?, ?)
         ON CONFLICT(entity_type, foreign_id) DO UPDATE SET local_id = excluded.local_id`,
        [spec.entityType, row.id, target]
      );

      await db.run(`DELETE FROM ${spec.table} WHERE id = ?`, [row.id]);

      // The old id is gone: its sync bookkeeping names a row that no
      // longer exists, and leaving it would have reconciliation chase a
      // ghost and the Conflicts card list a field on nothing.
      for (const table of ['sync_index', 'sync_repair', 'sync_conflicts']) {
        await db.run(`DELETE FROM ${table} WHERE entity_type = ? AND entity_id = ?`, [spec.entityType, row.id]);
      }
      rekeyed++;
    }
  }

  // Every recipe whose tools or steps moved has to look edited, or
  // syncReconcile.local.ts's findRowsAheadOfRepo() will not republish it
  // and the new ids never leave this device — the same idiom
  // repairUnknownUnitRefs() uses.
  for (const recipeId of touchedRecipes) {
    await db.run(`UPDATE recipes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [recipeId]);
  }

  return rekeyed;
}
