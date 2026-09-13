// ════════════════════════════════════════════════════════════════════════
// Regression test for a real, shipped bug: query()/queryOne() had no
// serialization at all (only withTransaction() did), so mergeBridge.ts's
// per-entity concurrency (added the same day this was found) could fire
// several query() calls at once against Android's single native SQLite
// connection — silently corrupting/dropping results there in production
// (ingredients/tools/etc. failed to import on a fresh Android pull while
// recipes, kept on a sequential code path for an unrelated reason, synced
// fine). Mocks @capacitor-community/sqlite with a fake connection whose
// query()/run() track concurrent-call overlap and have an artificial delay
// — long enough that two genuinely unserialized calls WOULD overlap if the
// serialization were ever removed, so this test would actually catch a
// regression, not just pass by accident of timing.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

let inFlight = 0;
let maxInFlight = 0;

/** Every execute() the module issues at open time, with the `transaction`
 *  argument it passed — see the journal-pragma test at the bottom. */
const executed: Array<{ sql: string; transaction: unknown }> = [];

class FakeSqliteDb {
  async open(): Promise<void> {}
  async execute(sql: string, transaction?: boolean): Promise<void> {
    executed.push({ sql, transaction });
  }
  async query(sql: string): Promise<{ values: Array<{ sql: string }> }> {
    return this.record(sql, { values: [{ sql }] });
  }
  async run(sql: string): Promise<Record<string, never>> {
    return this.record(sql, {});
  }
  private async record<T>(sql: string, result: T): Promise<T> {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    if (sql === 'FAIL') throw new Error('simulated failure');
    return result;
  }
}

const fakeDb = new FakeSqliteDb();

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  // A plain `function`, not an arrow function — `new SQLiteConnection(...)`
  // in db/local.ts requires something constructible, and arrow functions
  // can never be used with `new` at all.
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => fakeDb,
      retrieveConnection: async () => fakeDb,
    };
  }),
}));

const { query, withTransaction } = await import('./local');

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
});

describe('db/local.ts SQLite access serialization', () => {
  it('never runs two query() calls concurrently against the shared connection', async () => {
    await Promise.all([query('SELECT 1'), query('SELECT 2'), query('SELECT 3'), query('SELECT 4')]);
    expect(maxInFlight).toBe(1);
  });

  it('serializes query() against withTransaction() too, not just against other query() calls', async () => {
    await Promise.all([
      query('SELECT 1'),
      withTransaction(async (client) => {
        await client.query('SELECT 2');
        await client.query('SELECT 3');
      }),
      query('SELECT 4'),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('one caller throwing does not wedge callers queued after it', async () => {
    await expect(query('FAIL')).rejects.toThrow('simulated failure');
    // The queue must not be stuck — a subsequent call still completes.
    await expect(query('SELECT 1')).resolves.toBeDefined();
  });
});

// ── Write durability ──────────────────────────────────────────────────────
// Both platforms' plugins leave SQLite on journal_mode=delete +
// synchronous=FULL, and neither ever batches: the plugin wraps every single
// run() in its own BEGIN/COMMIT. Measured, that is ~5ms per write statement
// against ~0.12ms under WAL — and because everything above shares one queue,
// a sync merge's write burst is paid by whatever read is waiting behind it.
// So this asserts the pragmas are issued at all, and that they are issued
// UNWRAPPED: SQLite documents PRAGMA journal_mode as a no-op while a
// transaction is pending, and execute() wraps itself in one by default, so
// passing `false` is the whole point rather than a detail.
describe('journal pragmas', () => {
  it('puts the connection into WAL with synchronous=NORMAL, outside a transaction', async () => {
    await query('SELECT 1'); // any call opens the connection

    expect(executed).toEqual([
      { sql: 'PRAGMA journal_mode=WAL', transaction: false },
      { sql: 'PRAGMA synchronous=NORMAL', transaction: false },
    ]);
  });
});
