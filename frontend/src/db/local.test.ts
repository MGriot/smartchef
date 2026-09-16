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
// synchronous=FULL, and neither ever batches. Measured, that is ~5ms per
// write statement against ~0.12ms under WAL — and because everything above
// shares one queue, a sync merge's write burst is paid by whatever read is
// waiting behind it.
//
// This shipped in 1.1.2 through execute() only and NEVER APPLIED ON ANDROID:
// the Android plugin runs execute() via SQLiteDatabase.execSQL(), which
// refuses a statement that returns rows, and `journal_mode=WAL` returns one.
// The failure was swallowed by design, so nothing noticed until an emulator
// run showed the warning. These fakes model each platform's actual refusal
// rather than a plugin that accepts everything, which is what let it through.
describe('journal pragmas', () => {
  type Row = Record<string, unknown>;

  /** A connection whose query()/execute() behave like one real platform. */
  function fakeConnection(opts: {
    queryRefuses?: (sql: string) => boolean;
    executeRefuses?: (sql: string) => boolean;
  }) {
    const state = { journal_mode: 'delete', synchronous: 2 };
    const calls: Array<{ via: 'query' | 'execute'; sql: string; transaction?: unknown }> = [];
    const apply = (sql: string) => {
      const m = /PRAGMA (\w+)=(\w+)/.exec(sql);
      if (m?.[1] === 'journal_mode') state.journal_mode = m[2].toLowerCase();
      if (m?.[1] === 'synchronous') state.synchronous = m[2] === 'NORMAL' ? 1 : 2;
    };
    return {
      calls,
      state,
      async query(sql: string): Promise<{ values: Row[] }> {
        calls.push({ via: 'query', sql });
        if (opts.queryRefuses?.(sql)) throw new Error('This statement does not return data');
        if (sql === 'PRAGMA journal_mode') return { values: [{ journal_mode: state.journal_mode }] };
        if (sql === 'PRAGMA synchronous') return { values: [{ synchronous: state.synchronous }] };
        apply(sql);
        return { values: sql.includes('journal_mode=') ? [{ journal_mode: state.journal_mode }] : [] };
      },
      async execute(sql: string, transaction?: boolean): Promise<void> {
        calls.push({ via: 'execute', sql, transaction });
        if (opts.executeRefuses?.(sql)) {
          throw new Error('Queries can be performed using SQLiteDatabase query or rawQuery methods only.');
        }
        apply(sql);
      },
    };
  }

  it('applies WAL on Android, where execute() refuses a pragma that returns rows', async () => {
    const { applyWriteJournalPragmas } = await import('./local');
    const db = fakeConnection({ executeRefuses: (sql) => sql.includes('journal_mode') });

    const result = await applyWriteJournalPragmas(db as never);

    expect(result).toEqual({ journalMode: 'wal', synchronous: 1 });
    // The shipped version used only execute() here, and this is the call
    // Android refuses.
    expect(db.calls.find((c) => c.via === 'execute' && c.sql.includes('journal_mode'))).toBeUndefined();
  });

  it('falls back to execute() outside a transaction where query() refuses a no-row pragma', async () => {
    // better-sqlite3 on Electron can refuse query() for a statement that
    // returns nothing, which `synchronous=NORMAL` does not.
    const { applyWriteJournalPragmas } = await import('./local');
    const db = fakeConnection({ queryRefuses: (sql) => sql === 'PRAGMA synchronous=NORMAL' });

    const result = await applyWriteJournalPragmas(db as never);

    expect(result.synchronous).toBe(1);
    // `false` is load-bearing: SQLite ignores these pragmas inside a pending
    // transaction, and execute() otherwise wraps itself in one.
    expect(db.calls).toContainEqual({ via: 'execute', sql: 'PRAGMA synchronous=NORMAL', transaction: false });
  });

  it('reads the mode back instead of assuming the pragma took effect', async () => {
    const { applyWriteJournalPragmas } = await import('./local');
    // Accepts the statement but changes nothing — as silent as the original
    // failure, unless the result is checked.
    const db = fakeConnection({});
    db.query = async (sql: string) => {
      if (sql === 'PRAGMA journal_mode') return { values: [{ journal_mode: 'delete' }] };
      if (sql === 'PRAGMA synchronous') return { values: [{ synchronous: 2 }] };
      return { values: [] };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await applyWriteJournalPragmas(db as never);

    expect(result).toEqual({ journalMode: 'delete', synchronous: 2 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not WAL'))).toBe(true);
    warn.mockRestore();
  });

  it('never throws, so a refusing platform still opens the database', async () => {
    const { applyWriteJournalPragmas } = await import('./local');
    const db = fakeConnection({ queryRefuses: () => true, executeRefuses: () => true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(applyWriteJournalPragmas(db as never)).resolves.toBeDefined();
    warn.mockRestore();
  });
});
