// ════════════════════════════════════════════════════════════════════════
// The schema as the Electron app really runs it.
//
// @capacitor-community/sqlite's Electron plugin does not hand a script to
// SQLite as it is: statementsToSQL92() splits it on EVERY ";" (comments
// included), trims each piece and joins them back with ";\n". A ";" inside a
// "--" comment therefore ends the comment line, and whatever followed it
// runs as SQL. v1.17.0 shipped one and no library opened on Windows
// ("near "a": syntax error"). The other tests hand SQL straight to SQLite,
// which reads comments correctly, so only this one can see it.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/** Copied from the plugin (electron/dist/plugin.js, statementsToSQL92),
 *  for the default isSQL92 = true path the app uses. */
export function electronPluginTransform(sql: string): string {
  const s = sql.replace(/end;/g, 'END;').replace(/;END;/g, '&END;');
  return s.split(';').map((piece) => {
    let stmt = piece.trim();
    if (stmt.split(' ')[0].toUpperCase() === 'CREATE' && stmt.includes('&END')) stmt = stmt.replace(/&END/g, ';END');
    return stmt;
  }).join(';\n');
}

let db: DatabaseSync;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          const script = electronPluginTransform(sql);
          if (!transaction) { db.exec(script); return; }
          db.exec('BEGIN');
          try { db.exec(script); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => { throw new Error('one connection per test'); },
    };
  }),
}));

vi.mock('@capacitor/preferences', () => {
  const prefs = new Map<string, string>();
  return {
    Preferences: {
      get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => { prefs.set(key, value); },
      remove: async ({ key }: { key: string }) => { prefs.delete(key); },
    },
  };
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('the schema through the Electron plugin', () => {
  it('opens a fresh library', async () => {
    await (await import('./local')).initLocalSchema();
    expect(columns('recipes')).toContain('cookbook_id');
    expect(columns('change_log')).toContain('scope');
    // A comment's text read as a column ("a UX …") once hid here.
    expect(columns('profiles')).not.toContain('a');
  });

  it('upgrades a library whose change log predates scopes', async () => {
    db.exec(`
      CREATE TABLE change_log (seq INTEGER PRIMARY KEY, hlc TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT);
      CREATE TABLE field_state (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT, hlc TEXT NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (entity_type, entity_id, path));
      CREATE TABLE sync_cursor (device TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      INSERT INTO change_log VALUES (1, 'h', 'recipe', 'r1', 'title', '"Pane"');
    `);
    await (await import('./local')).initLocalSchema();
    expect(db.prepare(`SELECT scope, seq FROM change_log`).all()).toEqual([{ scope: '', seq: 1 }]);
  });
});
