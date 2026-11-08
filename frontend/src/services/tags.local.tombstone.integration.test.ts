// ════════════════════════════════════════════════════════════════════════
// A deleted tag stays deleted, and deleting one never waits on git.
//
// Deleted tags kept coming back: the reconcile pass force-applied a stale
// file published under an aliased id onto the live tombstone every sync,
// and auto-tagging still read tombstoned tags (through ingredient links the
// delete left behind). Tag edits also awaited gitSync's shared queue, so a
// running sync froze the Tags page. Real SQLite via node:sqlite.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string) => { db.exec(sql); },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected in this test');
      },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

// A git queue stuck behind a sync cycle that never finishes.
vi.mock('../lib/sync/gitSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sync/gitSync')>()),
  writeEntityFile: () => new Promise(() => {}),
}));

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

async function seed() {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  await query(`INSERT INTO tags (id, name, group_name, deleted_at) VALUES ('tag-dolce', 'Dolce', 'Portata', '2026-10-20 10:00:00')`);
  await query(`INSERT INTO tags (id, name, group_name, exclude_tag_ids) VALUES ('tag-vegano', 'Vegano', 'Dieta', '["tag-uova"]')`);
  await query(`INSERT INTO tags (id, name, group_name) VALUES ('tag-uova', 'Uova', 'Contiene')`);
  return query;
}

describe('pullRepoIntoDatabase', () => {
  it('leaves a tombstone alone when HEAD only holds it under an aliased id', async () => {
    const query = await seed();
    await query(`INSERT INTO sync_alias (entity_type, foreign_id, local_id) VALUES ('tag', 'legacy-dolce', 'tag-dolce')`);
    const { pullRepoIntoDatabase } = await import('./syncReconcile.local');

    const readHead = vi.fn(async () => ({ id: 'legacy-dolce', name: 'Dolce', group_name: 'Portata', deleted_at: null, updated_at: '2026-01-01 00:00:00' }));
    await pullRepoIntoDatabase(new Map([['tag', ['tag-dolce', 'legacy-dolce']]]), readHead);

    expect(readHead).not.toHaveBeenCalled();
    const row = await query<{ deleted_at: string | null }>(`SELECT deleted_at FROM tags WHERE id = 'tag-dolce'`);
    expect(row[0].deleted_at).toBe('2026-10-20 10:00:00');
  });
});

describe('deleteTag', () => {
  it('answers without waiting for the git queue, and drops its ingredient links', async () => {
    const query = await seed();
    const [cat] = await query<{ id: string }>(`SELECT id FROM ingredient_categories LIMIT 1`);
    await query(`INSERT INTO ingredients (id, category_id, name) VALUES ('egg', $1, 'Egg')`, [cat.id]);
    await query(`INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ('egg', 'tag-uova')`);
    const { deleteTag } = await import('./tags.local');

    // Resolves although writeEntityFile never does.
    await expect(deleteTag('tag-uova')).resolves.toEqual({ recipesUpdated: 0 });
    expect(await query(`SELECT * FROM ingredient_tags WHERE tag_id = 'tag-uova'`)).toEqual([]);
  });
});

describe('computeAutoTagNames', () => {
  it('never stamps a deleted tag back onto a recipe', async () => {
    const query = await seed();
    await query(`UPDATE tags SET deleted_at = now() WHERE id = 'tag-vegano'`);
    await query(`INSERT INTO recipes (id, title) VALUES ('r1', 'Insalata')`);
    const { computeAutoTagNames } = await import('./tags.local');
    const client = { query: async (sql: string, params?: unknown[]) => ({ rows: await query(sql, params) }) };

    expect(await computeAutoTagNames(client as never, 'r1')).toEqual([]);
  });
});
