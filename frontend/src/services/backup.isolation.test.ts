// ════════════════════════════════════════════════════════════════════════
// A backup is the recipe LIBRARY, and nothing else.
//
// exportSnapshot() has always been clean, but nothing enforced it, and the
// file it writes is the one users hand to other people ("here's my
// cookbook"). Two things make an accidental leak plausible now:
//
//   - settings are a synced SQLite table as of this release, sitting right
//     next to the tables the export already walks. Adding it to the export
//     would be a one-line mistake with no test to catch it.
//   - API keys and the git token live in Preferences, one import away.
//
// So this asserts the SHAPE of the export, not just a sample of it: any
// new top-level key fails here and has to be justified deliberately.
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
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => {
          db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected — one connection, created once');
      },
    };
  }),
}));

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

/** Shapes that must never appear in a file the user shares. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['an Anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/],
  ['an OpenAI key', /\bsk-[A-Za-z0-9]{20,}/],
  ['a Google API key', /\bAIza[A-Za-z0-9_-]{20,}/],
  ['a GitHub classic PAT', /\bghp_[A-Za-z0-9]{20,}/],
  ['a GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

describe('exportSnapshot isolation', () => {
  it('exports the library and nothing else', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const { exportSnapshot } = await import('./backup.local');

    const snapshot = await exportSnapshot() as Record<string, unknown>;

    // Exhaustive on purpose. A new key here is a decision, not an accident.
    expect(Object.keys(snapshot).sort()).toEqual(
      ['categories', 'formatVersion', 'ingredients', 'recipes', 'tags', 'techniques', 'tools'].sort()
    );
    expect(snapshot).not.toHaveProperty('settings');
    expect(snapshot).not.toHaveProperty('profiles');
    expect(snapshot).not.toHaveProperty('devices');
  });

  it('carries no settings row even when the table is full of them', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['display.themeMode', '"dark"']);
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, ['llm.provider', '"anthropic"']);
    const { exportSnapshot } = await import('./backup.local');

    const serialized = JSON.stringify(await exportSnapshot());

    expect(serialized).not.toContain('display.themeMode');
    expect(serialized).not.toContain('llm.provider');
  });

  it('contains nothing shaped like a credential', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    // A key pasted somewhere it does not belong is exactly the case that
    // would make this a real leak, so plant one and prove it stays put.
    await query(`INSERT INTO settings (id, value) VALUES ($1, $2)`, [
      'llm.provider', JSON.stringify('sk-ant-api03-DEADBEEFdeadbeefDEADBEEFdeadbeef'),
    ]);
    const { exportSnapshot } = await import('./backup.local');

    const serialized = JSON.stringify(await exportSnapshot());

    for (const [label, pattern] of CREDENTIAL_PATTERNS) {
      expect(pattern.test(serialized), `export contains ${label}`).toBe(false);
    }
  });
});
