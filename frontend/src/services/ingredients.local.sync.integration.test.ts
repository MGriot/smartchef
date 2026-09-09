// ════════════════════════════════════════════════════════════════════════
// Real-SQLite reproduction of "a device pulls an ingredient from another
// device via sync, but it never shows up in Library > Ingredients" —
// every previous fix attempt (id-collision upsert, query serialization,
// silent-blob-read surfacing) was verified against either pure logic
// (structuredMerge.ts) or a fully-mocked conflicts.local.ts, neither of
// which would catch a bug in the ACTUAL SQL createEntity()/listIngredients()
// run against a real SQLite engine. This mocks @capacitor-community/sqlite
// with node:sqlite's DatabaseSync (real SQLite, not a fake) so the exact
// same SCHEMA_SQL/createEntity()/listIngredients() code this app ships
// runs against a real engine — the one thing every earlier regression test
// in this investigation didn't do.
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
        // transaction defaults to true, matching the real plugin's
        // execute(statements, transaction = true, ...) signature, and wraps
        // in a real BEGIN/COMMIT accordingly. NOTE: this does NOT reproduce
        // db/local.ts's real 2026-09 dropDanglingForeignKeys() regression
        // (its migration calls omitted `transaction: false`, so an embedded
        // "PRAGMA foreign_keys=OFF" silently no-op'd and the table rebuild
        // threw "FOREIGN KEY constraint failed" on real devices) — confirmed
        // by direct testing that node:sqlite's PRAGMA-inside-a-transaction
        // behavior differs from the real Electron backend's
        // better-sqlite3-multiple-ciphers build (which can't run under
        // plain Node/vitest at all — it's compiled against Electron's Node
        // ABI). That regression was caught and verified fixed by running
        // the real migration against a copy of a real production database
        // through the actual compiled module, not through this suite.
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
      }),
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

describe('a remote-created ingredient survives createEntity() -> listIngredients() against real SQLite', () => {
  it('shows up in listIngredients() after the exact write mergeBridge.ts performs', async () => {
    const { initLocalSchema, queryOne } = await import('../db/local');
    await initLocalSchema();

    // A category id from ANOTHER device's random per-device seed — exactly
    // the "dangling category_id" shape a real cross-device sync produces,
    // since ingredient_categories rows get lower(hex(randomblob(16))) ids
    // independently on every device (see db/local.ts's SEED_SQL comment).
    const foreignCategoryId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // The exact JSON shape gitSync.ts's mergeBridge.ts hands to createEntity()
    // for a brand-new remote entity: the raw `SELECT * FROM ingredients`
    // row from the OTHER device, round-tripped through JSON (see
    // ingredients.local.ts's syncIngredient() for what actually gets
    // committed — a raw row, image_urls/seasonal_months as JSON-encoded TEXT).
    const remoteIngredientJson = {
      id: 'remote-ingredient-1',
      category_id: foreignCategoryId,
      name: 'Farina 00',
      description: null,
      icon: null,
      image_urls: '[]',
      calories_kcal: 364,
      protein_g: 10,
      carbs_g: 76,
      fat_g: 1,
      fiber_g: 2.7,
      sugar_g: 0.3,
      sodium_mg: 2,
      seasonal_months: '[]',
      synonyms: '[]',
      parent_ingredient_id: null,
      sync_status: 'local',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    const { createEntity, entityExists } = await import('./conflicts.local');
    expect(await entityExists('ingredient', 'remote-ingredient-1')).toBe(false);
    await createEntity('ingredient', 'remote-ingredient-1', remoteIngredientJson);
    expect(await entityExists('ingredient', 'remote-ingredient-1')).toBe(true);

    // Sanity check the row is actually there before blaming the list query.
    const raw = await queryOne('SELECT * FROM ingredients WHERE id=$1', ['remote-ingredient-1']);
    expect(raw).not.toBeNull();

    const { listIngredients } = await import('./ingredients.local');
    const list = await listIngredients({});
    const found = list.find((i: any) => i.id === 'remote-ingredient-1');
    expect(found).toBeDefined();
    expect((found as { name: string } | undefined)?.name).toBe('Farina 00');
  });

  it('writes a synced recipe_ingredients row whose unit_id is another device\'s (dangling) unit', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();

    const { createEntity } = await import('./conflicts.local');
    await createEntity('recipe', 'recipe-1', {
      id: 'recipe-1',
      title: 'Torta di mele',
      servings: 8,
      ingredients: [
        {
          id: 'ri-1', sort_order: 0, ingredient_id: null, sub_recipe_id: null,
          quantity: 500, quantity_text: null, unit_id: 'another-devices-unit-id',
          notes: null, is_optional: 0, group_name: null,
        },
      ],
    });

    const rows = await query('SELECT * FROM recipe_ingredients WHERE recipe_id=$1', ['recipe-1']);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { unit_id: string }).unit_id).toBe('another-devices-unit-id');
  });

  it('migrates an existing device off the old FK-bearing schema, preserving its data', async () => {
    // Simulate a device provisioned before this fix: the OLD ingredients
    // table shape (a hard FK to ingredient_categories), with one row that
    // legitimately satisfies it locally — the common pre-migration case,
    // not yet a foreign category id.
    db.exec(`
      CREATE TABLE ingredient_categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, icon TEXT, color TEXT,
        sort_order INTEGER DEFAULT 0, deleted_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE ingredients (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL REFERENCES ingredient_categories(id),
        name TEXT NOT NULL, description TEXT, icon TEXT, image_urls TEXT DEFAULT '[]',
        calories_kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, fiber_g REAL, sugar_g REAL, sodium_mg REAL,
        sync_status TEXT DEFAULT 'local', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ingredient_categories (id, name) VALUES ('cat-1', 'Verdure');
      INSERT INTO ingredients (id, category_id, name, calories_kcal) VALUES ('local-ing-1', 'cat-1', 'Zucchina', 17);
    `);

    const { initLocalSchema, queryOne } = await import('../db/local');
    await expect(initLocalSchema()).resolves.not.toThrow();

    const preserved = await queryOne<{ name: string; calories_kcal: number }>('SELECT * FROM ingredients WHERE id=$1', ['local-ing-1']);
    expect(preserved?.name).toBe('Zucchina');
    expect(preserved?.calories_kcal).toBe(17);

    // And the FK is actually gone now — a foreign category_id no longer throws.
    const { createEntity } = await import('./conflicts.local');
    await expect(
      createEntity('ingredient', 'remote-ing-2', { id: 'remote-ing-2', category_id: 'someone-elses-category', name: 'Test' })
    ).resolves.not.toThrow();
  });
});
