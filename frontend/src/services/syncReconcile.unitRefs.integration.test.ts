// ════════════════════════════════════════════════════════════════════════
// repairUnknownUnitRefs: rows pointing at a unit no device has.
//
// "Crema pasticcera" arrived on every device with unit_id
// 2152e3cc…, an old device's random seed id, and no unit_symbol, so its
// amounts showed with no unit. Its own steps carry no amounts, so the
// merge-time heal had nothing to borrow from — but ANOTHER recipe's step
// amounts still pair that id with "g". Real SQLite via node:sqlite.
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

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

const OLD_G = '2152e3cc861f7d77969a3d8f739f4e03';
const OLD_KG = '84dc14ef8f0ba215821b1fd6d31e12fc';

async function seed() {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  const g = (await query<{ id: string }>(`SELECT id FROM units WHERE symbol = 'g'`))[0].id;
  await query(`INSERT INTO recipes (id, title, updated_at) VALUES ('crema', 'Crema pasticcera', '2026-01-01 00:00:00')`);
  await query(`INSERT INTO recipes (id, title, updated_at) VALUES ('focaccia', 'Focaccia', '2026-01-01 00:00:00')`);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('c0', 'crema', 0, 500, $1)`, [OLD_G]);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('c1', 'crema', 1, 1, $1)`, [OLD_KG]);
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, quantity, unit_id) VALUES ('f0', 'focaccia', 0, 210, $1)`, [g]);
  // Only the focaccia's steps know what OLD_G means.
  await query(
    `INSERT INTO recipe_steps (id, recipe_id, step_number, description, step_ingredients) VALUES ('s1', 'focaccia', 1, 'Impasta', $1)`,
    [JSON.stringify([{ ingredientSortOrder: 0, quantity: 210, unitId: OLD_G, unitSymbol: 'g' }])]
  );
  return { query, g };
}

describe('repairUnknownUnitRefs', () => {
  it("resolves a recipe's unknown unit from another recipe's step amounts", async () => {
    const { query, g } = await seed();
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');

    expect(await repairUnknownUnitRefs()).toEqual({ fixed: 1, unresolved: 1 });

    const rows = await query<{ id: string; unit_id: string; symbol: string | null }>(
      `SELECT ri.id, ri.unit_id, u.symbol FROM recipe_ingredients ri LEFT JOIN units u ON u.id = ri.unit_id WHERE recipe_id = 'crema' ORDER BY sort_order`
    );
    expect(rows[0]).toMatchObject({ unit_id: g, symbol: 'g' });
    // Nothing anywhere names OLD_KG: left alone rather than guessed.
    expect(rows[1]).toMatchObject({ unit_id: OLD_KG, symbol: null });
  });

  it('bumps only the recipes it rewrote, so only their files are republished', async () => {
    const { query } = await seed();
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');
    await repairUnknownUnitRefs();

    const stamps = Object.fromEntries(
      (await query<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM recipes`)).map((r) => [r.id, r.updated_at])
    );
    expect(stamps.crema).not.toBe('2026-01-01 00:00:00');
    expect(stamps.focaccia).toBe('2026-01-01 00:00:00');
  });

  it('is a no-op on a healthy library', async () => {
    const { query } = await seed();
    await query(`DELETE FROM recipe_ingredients WHERE recipe_id = 'crema'`);
    const { repairUnknownUnitRefs } = await import('./syncReconcile.local');
    expect(await repairUnknownUnitRefs()).toEqual({ fixed: 0, unresolved: 0 });
  });
});
