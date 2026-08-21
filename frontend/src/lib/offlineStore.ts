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
      CREATE TABLE IF NOT EXISTS downloaded_recipes (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        downloaded_at TEXT NOT NULL
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

/** Inserts or replaces (by `id`) a single record within a cached entity
 *  list — used to optimistically show something created while offline
 *  (e.g. a new recipe) immediately in list views, without waiting for the
 *  next full snapshot pull on reconnect (which still happens and replaces
 *  this with the authoritative row). */
export async function upsertCachedEntity(entityType: EntityType, record: { id: string } & Record<string, unknown>): Promise<void> {
  const existing = await getCachedEntities(entityType);
  const idx = existing.findIndex((e: any) => e.id === record.id);
  if (idx >= 0) existing[idx] = { ...existing[idx], ...record };
  else existing.push(record);

  const db = await getDb();
  await db.run(
    `INSERT INTO snapshot_cache (entity_type, data, cached_at) VALUES (?, ?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET data=excluded.data, cached_at=excluded.cached_at`,
    [entityType, JSON.stringify(existing), new Date().toISOString()]
  );
}

export async function getCacheTimestamp(): Promise<string | null> {
  const db = await getDb();
  const result = await db.query('SELECT cached_at FROM snapshot_cache ORDER BY cached_at DESC LIMIT 1');
  return result.values?.[0]?.cached_at ?? null;
}

export async function hasCachedData(): Promise<boolean> {
  return (await getCacheTimestamp()) !== null;
}

// ── Per-recipe offline downloads ────────────────────────────────────────
// A second, opt-in layer on top of the whole-library snapshot cache above:
// snapshot_cache holds list-view fields for every recipe (title,
// coverImageUrl, etc. — see api.ts's OFFLINE_CREATABLE_ENTITIES for the
// exact shape), not the full ingredients/steps/tools detail GET
// /api/recipes/:id normally returns. A recipe explicitly downloaded here
// stores that full detail response instead, so its detail page still works
// offline even for recipes the whole-library cache never captured in full.
// Doesn't touch snapshot_cache or the outbox — independent, additive, and
// safe to clear without affecting either.

export async function downloadRecipeOffline(recipe: { id: string } & Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO downloaded_recipes (id, data, downloaded_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data=excluded.data, downloaded_at=excluded.downloaded_at`,
    [recipe.id, JSON.stringify(recipe), new Date().toISOString()]
  );
}

export async function removeDownloadedRecipe(id: string): Promise<void> {
  const db = await getDb();
  await db.run('DELETE FROM downloaded_recipes WHERE id = ?', [id]);
}

export async function isRecipeDownloaded(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query('SELECT 1 FROM downloaded_recipes WHERE id = ?', [id]);
  return (result.values?.length ?? 0) > 0;
}

export async function getDownloadedRecipe<T = any>(id: string): Promise<T | null> {
  const db = await getDb();
  const result = await db.query('SELECT data FROM downloaded_recipes WHERE id = ?', [id]);
  const row = result.values?.[0];
  return row ? JSON.parse(row.data) : null;
}

export interface DownloadedRecipeSummary {
  id: string;
  downloadedAt: string;
  title: string;
  coverImageUrl: string | null;
}

/** For the Downloads management page — doesn't parse full recipe bodies
 *  beyond the two display fields it needs, so it stays cheap even with a
 *  large number of downloads. */
export async function listDownloadedRecipes(): Promise<DownloadedRecipeSummary[]> {
  const db = await getDb();
  const result = await db.query('SELECT id, data, downloaded_at FROM downloaded_recipes ORDER BY downloaded_at DESC');
  return (result.values ?? []).map((row: any) => {
    const data = JSON.parse(row.data);
    return { id: row.id, downloadedAt: row.downloaded_at, title: data.translated_title || data.title, coverImageUrl: data.coverImageUrl ?? data.cover_image_url ?? null };
  });
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
