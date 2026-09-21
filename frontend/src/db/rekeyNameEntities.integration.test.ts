// ════════════════════════════════════════════════════════════════════════
// Against REAL SQLite, deliberately — same harness as
// services/sync-entity-types.local.sync.integration.test.ts.
//
// What this migration touches is a hard FK (recipe_tools.tool_id) and two
// composite primary keys (recipe_tools, ingredient_tags). A mock that does
// not enforce those would pass every assertion below while the migration
// silently dropped every recipe-to-tool link — and a hard FK to per-device
// random data has already broken cross-device sync on this project once,
// precisely because it was only ever exercised against a mock.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';

let db: DatabaseSync;
let connection: SQLiteDBConnection;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => {
        connection = {
          open: async () => {},
          execute: async (sql: string, transaction = true) => {
            if (!transaction) {
              db.exec(sql);
              return;
            }
            db.exec('BEGIN');
            try {
              db.exec(sql);
              db.exec('COMMIT');
            } catch (err) {
              db.exec('ROLLBACK');
              throw err;
            }
          },
          query: async (sql: string, params: unknown[] = []) => {
            const stmt = db.prepare(sql);
            return { values: stmt.all(...(params as never[])) };
          },
          run: async (sql: string, params: unknown[] = []) => {
            db.prepare(sql).run(...(params as never[]));
          },
        } as unknown as SQLiteDBConnection;
        return connection;
      },
      retrieveConnection: async () => {
        throw new Error('not expected in this test — one connection, created once');
      },
    };
  }),
}));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

/** Schema first (the re-key inside it runs against an empty library), then
 *  the legacy rows, then the re-key on its own so each test can assert on
 *  exactly what it seeded. */
async function withSchema() {
  const local = await import('./local');
  await local.initLocalSchema();
  return local;
}

async function rekey() {
  const { rekeyNameEntityIds } = await import('./rekeyNameEntities');
  const { slugify } = await import('../services/syncExtras.local');
  return rekeyNameEntityIds(connection, slugify);
}

describe('rekeyNameEntityIds against real SQLite', () => {
  it('moves a random-id tool onto its portable id and keeps the recipe link', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['9d2f41aa6b1c4e6f8a0d3b77c5e21f04', 'Frusta']);
    await query('INSERT INTO recipes (id, title) VALUES ($1, $2)', ['r1', 'Meringa']);
    await query('INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2)', ['r1', '9d2f41aa6b1c4e6f8a0d3b77c5e21f04']);

    expect(await rekey()).toBe(1);

    expect(await queryOne('SELECT id FROM tools WHERE id=$1', ['tool-frusta'])).toBeTruthy();
    expect(await queryOne('SELECT id FROM tools WHERE id=$1', ['9d2f41aa6b1c4e6f8a0d3b77c5e21f04'])).toBeNull();
    // The link is the thing that must not be lost.
    const links = await query<{ tool_id: string }>('SELECT tool_id FROM recipe_tools WHERE recipe_id=$1', ['r1']);
    expect(links.map((l) => l.tool_id)).toEqual(['tool-frusta']);
  });

  it('records an alias rather than a deletion marker', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-1', 'Frusta']);

    await rekey();

    const alias = await queryOne<{ local_id: string }>(
      'SELECT local_id FROM sync_alias WHERE entity_type=$1 AND foreign_id=$2', ['tool', 'legacy-1']
    );
    // A tombstone on the loser id would delete the live tool on every
    // device that has not upgraded yet; an alias absorbs their stale files.
    expect(alias?.local_id).toBe('tool-frusta');
  });

  it('unions rather than updates when one recipe already carries both ids', async () => {
    const { query } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-2', 'Frusta']);
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['tool-pentola', 'Pentola']);
    await query('INSERT INTO recipes (id, title) VALUES ($1, $2)', ['r1', 'Meringa']);
    await query('INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2)', ['r1', 'legacy-2']);
    await query('INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2)', ['r1', 'tool-pentola']);

    // A plain UPDATE here trips PRIMARY KEY (recipe_id, tool_id).
    await expect(rekey()).resolves.toBe(1);

    const links = await query<{ tool_id: string }>('SELECT tool_id FROM recipe_tools WHERE recipe_id=$1 ORDER BY tool_id', ['r1']);
    expect(links.map((l) => l.tool_id)).toEqual(['tool-frusta', 'tool-pentola']);
  });

  it('rewrites the id inside a step JSON array and marks the recipe changed', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-3', 'Frusta']);
    await query('INSERT INTO recipes (id, title, updated_at) VALUES ($1, $2, $3)', ['r1', 'Meringa', '2020-01-01 00:00:00']);
    await query(
      'INSERT INTO recipe_steps (id, recipe_id, step_number, description, tool_ids) VALUES ($1, $2, $3, $4, $5)',
      ['s1', 'r1', 1, 'Monta', JSON.stringify(['legacy-3'])]
    );

    await rekey();

    const step = await queryOne<{ tool_ids: string }>('SELECT tool_ids FROM recipe_steps WHERE id=$1', ['s1']);
    expect(JSON.parse(step!.tool_ids)).toEqual(['tool-frusta']);
    // Without the bump, findRowsAheadOfRepo() never republishes the recipe
    // and the new ids never leave this device.
    const recipe = await queryOne<{ updated_at: string }>('SELECT updated_at FROM recipes WHERE id=$1', ['r1']);
    expect(recipe!.updated_at).not.toBe('2020-01-01 00:00:00');
  });

  it('keeps translations, which cascade on delete', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-4', 'Frusta']);
    await query(
      'INSERT INTO tool_translations (id, tool_id, language_code, name) VALUES ($1, $2, $3, $4)',
      ['t1', 'legacy-4', 'en', 'Whisk']
    );

    await rekey();

    // Repointed BEFORE the old row is deleted — the other order lets the
    // ON DELETE CASCADE take every translation with it.
    const row = await queryOne<{ name: string }>('SELECT name FROM tool_translations WHERE tool_id=$1', ['tool-frusta']);
    expect(row?.name).toBe('Whisk');
  });

  it('leaves a row alone when another already owns its portable id', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['tool-frusta', 'Frusta']);
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-5', 'FRUSTA!']);

    await rekey();

    // Two genuinely different things whose names slugify alike. Folding
    // them would be a guess; keeping the random id is not.
    expect(await queryOne('SELECT id FROM tools WHERE id=$1', ['legacy-5'])).toBeTruthy();
  });

  it('is a no-op on a second run', async () => {
    const { query } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-6', 'Frusta']);
    expect(await rekey()).toBe(1);
    expect(await rekey()).toBe(0);
  });

  it('clears the old id sync bookkeeping', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name) VALUES ($1, $2)', ['legacy-7', 'Frusta']);
    await query('INSERT INTO sync_index (entity_type, entity_id, updated_at) VALUES ($1, $2, $3)', ['tool', 'legacy-7', 'x']);
    await query('INSERT INTO sync_repair (entity_type, entity_id, error) VALUES ($1, $2, $3)', ['tool', 'legacy-7', 'boom']);

    await rekey();

    expect(await queryOne('SELECT entity_id FROM sync_index WHERE entity_id=$1', ['legacy-7'])).toBeNull();
    expect(await queryOne('SELECT entity_id FROM sync_repair WHERE entity_id=$1', ['legacy-7'])).toBeNull();
  });

  it('re-keys tags and techniques too, including a tag an ingredient references', async () => {
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tags (id, name) VALUES ($1, $2)', ['legacy-tag', 'Vegano']);
    await query('INSERT INTO techniques (id, name) VALUES ($1, $2)', ['legacy-tech', 'Sbattere']);
    // ingredients.category_id is NOT NULL; SEED_SQL already planted a
    // starting catalog, so borrow whichever category it created.
    const seedCategory = await queryOne<{ id: string }>('SELECT id FROM ingredient_categories LIMIT 1');
    await query('INSERT INTO ingredients (id, name, category_id) VALUES ($1, $2, $3)', ['i1', 'Uovo', seedCategory!.id]);
    await query('INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ($1, $2)', ['i1', 'legacy-tag']);

    await rekey();

    expect(await queryOne('SELECT id FROM tags WHERE id=$1', ['tag-vegano'])).toBeTruthy();
    expect(await queryOne('SELECT id FROM techniques WHERE id=$1', ['technique-sbattere'])).toBeTruthy();
    const link = await queryOne<{ tag_id: string }>('SELECT tag_id FROM ingredient_tags WHERE ingredient_id=$1', ['i1']);
    expect(link?.tag_id).toBe('tag-vegano');
  });

  it('carries a column a later release added, instead of dropping it', async () => {
    // rekeyPortableIds() hardcodes its column lists, so anything added by
    // addColumnIfMissing() after it was written is silently lost on
    // re-key. This migration reads PRAGMA table_info instead.
    const { query, queryOne } = await withSchema();
    await query('INSERT INTO tools (id, name, category, icon) VALUES ($1, $2, $3, $4)', ['legacy-8', 'Frusta', 'Manuali', 'whisk']);

    await rekey();

    const row = await queryOne<{ category: string; icon: string }>('SELECT category, icon FROM tools WHERE id=$1', ['tool-frusta']);
    expect(row).toMatchObject({ category: 'Manuali', icon: 'whisk' });
  });
});
