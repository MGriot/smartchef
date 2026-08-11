// ════════════════════════════════════════════════════════════════════════
// SmartChef — Native offline store (SQLite)
// Two jobs: (1) cache the full-library snapshot (see backend
// GET /api/sync-folder/snapshot, reusing folder-sync.service.ts's
// buildFullSnapshot()) so pages can render something when the server is
// unreachable, and (2) an outbox of mutations made while offline, replayed
// against the real API once connectivity returns. Native-only — never
// imported on the web build's hot path beyond this module existing.
// ════════════════════════════════════════════════════════════════════════

import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'smartchef_offline';
const ENTITY_TYPES = ['categories', 'tools', 'techniques', 'tags', 'ingredients', 'collections', 'recipes'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

let sqlite: SQLiteConnection | null = null;
let dbPromise: Promise<SQLiteDBConnection> | null = null;

async function getDb(): Promise<SQLiteDBConnection> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    if (!sqlite) sqlite = new SQLiteConnection(CapacitorSQLite);
    const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
    const database = isConn
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
    await database.open();
    await database.execute(`
      CREATE TABLE IF NOT EXISTS snapshot_cache (
        entity_type TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL
      );
    `);
    return database;
  })();
  return dbPromise;
}

// ── Snapshot cache (read side) ──────────────────────────────────────────

export async function cacheSnapshot(snapshot: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute('BEGIN TRANSACTION');
  try {
    for (const type of ENTITY_TYPES) {
      await db.run(
        `INSERT INTO snapshot_cache (entity_type, data, cached_at) VALUES (?, ?, ?)
         ON CONFLICT(entity_type) DO UPDATE SET data=excluded.data, cached_at=excluded.cached_at`,
        [type, JSON.stringify(snapshot[type] ?? []), now]
      );
    }
    await db.execute('COMMIT');
  } catch (err) {
    await db.execute('ROLLBACK');
    throw err;
  }
}

export async function getCachedEntities<T = any>(entityType: EntityType): Promise<T[]> {
  const db = await getDb();
  const result = await db.query('SELECT data FROM snapshot_cache WHERE entity_type = ?', [entityType]);
  const row = result.values?.[0];
  if (!row) return [];
  return JSON.parse(row.data);
}

export async function getCacheTimestamp(): Promise<string | null> {
  const db = await getDb();
  const result = await db.query('SELECT cached_at FROM snapshot_cache ORDER BY cached_at DESC LIMIT 1');
  return result.values?.[0]?.cached_at ?? null;
}

export async function hasCachedData(): Promise<boolean> {
  return (await getCacheTimestamp()) !== null;
}

// ── Outbox (write side) ─────────────────────────────────────────────────

export interface PendingOperation {
  id: number;
  method: string;
  path: string;
  body: string | null;
  created_at: string;
}

export async function queueOperation(method: string, path: string, body?: unknown): Promise<void> {
  const db = await getDb();
  await db.run(
    'INSERT INTO pending_operations (method, path, body, created_at) VALUES (?, ?, ?, ?)',
    [method, path, body !== undefined ? JSON.stringify(body) : null, new Date().toISOString()]
  );
}

export async function getPendingOperations(): Promise<PendingOperation[]> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM pending_operations ORDER BY id ASC');
  return (result.values ?? []) as PendingOperation[];
}

export async function getPendingOperationCount(): Promise<number> {
  const db = await getDb();
  const result = await db.query('SELECT COUNT(*) as count FROM pending_operations');
  return result.values?.[0]?.count ?? 0;
}

export async function removePendingOperation(id: number): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM pending_operations WHERE id = ?', [id]);
}
