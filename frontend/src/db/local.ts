// ════════════════════════════════════════════════════════════════════════
// SmartChef — Local primary datastore (standalone mode)
//
// Same shape as backend/src/db/pool.ts (query/queryOne/withTransaction)
// so route logic ported from backend/src/routes/*.ts needs minimal call-site
// changes — only the genuinely Postgres-specific SQL (arrays, JSONB
// aggregation, ILIKE, etc.) is rewritten; everything else is copy-pasted.
//
// Ported SQL keeps using Postgres-style `$1, $2, ...` placeholders and
// `now()` — both are transparently rewritten to SQLite's `?` positional
// placeholders and `CURRENT_TIMESTAMP` by the exec() helper below, so the
// ported files don't need every query string hand-edited.
//
// This is a genuinely different database from the one offlineStore.ts
// manages: that one is a read-cache + write-outbox for a *remote* server.
// This one is the actual primary datastore when there's no server at all.
// ════════════════════════════════════════════════════════════════════════

import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'smartchef_local';

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
    return database;
  })();
  return dbPromise;
}

// ── Postgres → SQLite text translation ────────────────────────────────────
// Ported query strings are copy-pasted from the Postgres routes largely
// unmodified. These two rewrites cover the two mechanical differences that
// show up in nearly every one of them.

function rewriteNow(sql: string): string {
  return sql.replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP');
}

/** `$1, $2, ...` (Postgres) → `?` (SQLite), expanding params so a repeated
 *  `$N` (e.g. the same search term used 3x in one WHERE clause) still binds
 *  correctly — SQLite needs one bound value per `?`, Postgres only needs
 *  one per distinct `$N`. */
function rewriteParams(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const expanded: unknown[] = [];
  const rewritten = sql.replace(/\$(\d+)/g, (_match, n: string) => {
    expanded.push(normalizeParam(params[Number(n) - 1]));
    return '?';
  });
  return { sql: rewritten, params: expanded };
}

/** SQLite has no array/object/boolean binding type — arrays and plain
 *  objects (standing in for Postgres TEXT[]/JSONB columns) are stored as
 *  JSON text; booleans as 0/1. Reading them back out is each ported
 *  service's own job (it knows which columns are JSON-encoded), not
 *  handled generically here. */
function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function isSelectLike(sql: string): boolean {
  return /^\s*(SELECT|WITH)\b/i.test(sql);
}

async function exec<T = Record<string, unknown>>(
  db: SQLiteDBConnection,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { sql: s, params: p } = rewriteParams(rewriteNow(sql), params);
  if (isSelectLike(s)) {
    const result = await db.query(s, p);
    return (result.values ?? []) as T[];
  }
  await db.run(s, p);
  return [];
}

// ── Public API — matches backend/src/db/pool.ts's exported shape ─────────

export async function query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const db = await getDb();
  return exec<T>(db, text, params ?? []);
}

export async function queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Client handle passed into withTransaction()'s callback — mirrors
 *  `pg.PoolClient`'s `query() => {rows}` shape (not this module's own
 *  `query() => T[]`) since that's the shape every ported route file's
 *  `client.query(...)` / `.rows` call sites already assume. */
export interface LocalClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// SQLite is single-writer — one shared connection, no real connection pool
// — so concurrent withTransaction() calls must be serialized to keep one
// caller's sequence of statements from interleaving with another's. This is
// a local single-user app (not a server fielding concurrent requests), so a
// simple promise-chain mutex is enough.
//
// Deliberately NOT wrapped in a real SQL transaction (no BEGIN/COMMIT/
// ROLLBACK) despite the name — @capacitor-community/sqlite's run()/execute()
// each default to wrapping themselves in their own transaction per call
// (its `transaction` option defaults to true), so issuing our own explicit
// BEGIN/COMMIT as raw SQL text around a sequence of such calls nests a
// transaction inside each individual call's own auto-wrap. On this app's
// Electron target that silently left every write inside an outer
// transaction that never actually reached disk — visible to the same
// connection for the rest of that session (so imports looked successful,
// "already exists" checks matched on retry), but gone on the next app
// launch, since it was never durably committed. Each statement's own
// built-in atomicity is enough for what this local, single-writer app
// actually needs; a multi-statement caller failing partway through just
// leaves whatever ran before the failure in place, same as it would with a
// real transaction that never got asked to roll back.
let transactionQueue: Promise<unknown> = Promise.resolve();

export async function withTransaction<T>(fn: (client: LocalClient) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const db = await getDb();
    const client: LocalClient = {
      query: async (text, params) => ({ rows: await exec(db, text, params ?? []) }),
    };
    return fn(client);
  };

  const next = transactionQueue.then(run, run);
  // Swallow rejection on the shared chain itself (each caller still gets
  // the real error via `next`) so one failed sequence doesn't wedge every
  // caller queued after it.
  transactionQueue = next.catch(() => {});
  return next;
}

// ── Schema ─────────────────────────────────────────────────────────────
// One flat creation script for the CURRENT shape, not 30 replayed
// migrations — every local DB starts empty, so there's no history to
// replay. Covers the tables recipes.local.ts/ingredients.local.ts depend
// on; extended in place as later stages port more of the app.
//
// Translation choices applied uniformly (see the Seventeenth-slice plan):
//   - UUID/VARCHAR/ENUM        → TEXT
//   - TEXT[] / UUID[] / JSONB  → TEXT (JSON-encoded; parsed by each service)
//   - TIMESTAMPTZ DEFAULT now() → TEXT DEFAULT CURRENT_TIMESTAMP
//   - BOOLEAN                 → INTEGER (0/1)
//   - updated_at triggers     → stamped by each ported UPDATE statement
//     directly (`updated_at=now()`, rewritten to CURRENT_TIMESTAMP above)
//   - account/creator FK      → dropped; recipes.creator_name is a plain
//     denormalized TEXT column (standalone mode has no accounts table,
//     just the one local display-name profile — see lib/standalone.ts)

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingredient_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  color       TEXT,
  sort_order  INTEGER DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredient_categories_name_active ON ingredient_categories(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ingredient_category_translations (
  id            TEXT PRIMARY KEY,
  category_id   TEXT NOT NULL REFERENCES ingredient_categories(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  name          TEXT,
  description   TEXT,
  UNIQUE(category_id, language_code)
);

CREATE TABLE IF NOT EXISTS ingredients (
  id             TEXT PRIMARY KEY,
  category_id    TEXT NOT NULL REFERENCES ingredient_categories(id),
  name           TEXT NOT NULL,
  description    TEXT,
  icon           TEXT,
  image_urls     TEXT DEFAULT '[]',
  calories_kcal  REAL,
  protein_g      REAL,
  carbs_g        REAL,
  fat_g          REAL,
  fiber_g        REAL,
  sugar_g        REAL,
  sodium_mg      REAL,
  -- JSON-encoded array of month numbers (1-12) this ingredient is in season
  -- for (Northern hemisphere) — same TEXT-array-as-JSON convention as
  -- recipes.tags/regions. '[]'/NULL = no seasonality data, not "year-round".
  -- See db/migrations/034_ingredient_seasonality.sql for the Postgres side.
  -- Backfilled onto pre-existing local DBs via addColumnIfMissing() below.
  seasonal_months TEXT DEFAULT '[]',
  sync_status    TEXT DEFAULT 'local',
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category_id);

CREATE TABLE IF NOT EXISTS ingredient_translations (
  id              TEXT PRIMARY KEY,
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  language_code   TEXT NOT NULL,
  translated_name TEXT NOT NULL,
  UNIQUE(ingredient_id, language_code)
);

CREATE TABLE IF NOT EXISTS units (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  symbol           TEXT NOT NULL UNIQUE,
  unit_type        TEXT NOT NULL,
  base_unit_symbol TEXT,
  to_base_factor   REAL,
  system           TEXT DEFAULT 'metric',
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS unit_translations (
  id            TEXT PRIMARY KEY,
  unit_id       TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  name          TEXT,
  UNIQUE(unit_id, language_code)
);

CREATE TABLE IF NOT EXISTS tools (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,
  description TEXT,
  icon        TEXT,
  image_urls  TEXT DEFAULT '[]',
  deleted_at  TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_name_active ON tools(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tool_translations (
  id            TEXT PRIMARY KEY,
  tool_id       TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  name          TEXT,
  description   TEXT,
  UNIQUE(tool_id, language_code)
);

CREATE TABLE IF NOT EXISTS tags (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  group_name      TEXT NOT NULL DEFAULT 'Altro',
  color           TEXT,
  icon            TEXT,
  exclude_tag_ids TEXT DEFAULT '[]',
  sort_order      INTEGER DEFAULT 0,
  deleted_at      TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_active ON tags(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tag_translations (
  id            TEXT PRIMARY KEY,
  tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  name          TEXT NOT NULL,
  UNIQUE(tag_id, language_code)
);

CREATE TABLE IF NOT EXISTS ingredient_tags (
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (ingredient_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_ingredient_tags_tag ON ingredient_tags(tag_id);

CREATE TABLE IF NOT EXISTS recipes (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  difficulty      TEXT DEFAULT 'medium',
  servings        INTEGER NOT NULL DEFAULT 4,
  prep_time_min   INTEGER,
  cook_time_min   INTEGER,
  rest_time_min   INTEGER,
  rating          INTEGER,
  yield_amount    REAL,
  yield_unit_id   TEXT REFERENCES units(id),
  tags            TEXT DEFAULT '[]',
  regions         TEXT DEFAULT '[]',
  region_coords   TEXT DEFAULT '{}',
  cover_image_url TEXT,
  source_url      TEXT,
  sources         TEXT DEFAULT '[]',
  is_component    INTEGER DEFAULT 0,
  language_code   TEXT,
  times_cooked    INTEGER NOT NULL DEFAULT 0,
  creator_name    TEXT,
  -- "Come conservare" / "Consigli" — see
  -- db/migrations/033_recipe_storage_and_tips.sql. Backfilled onto
  -- pre-existing local DBs via addColumnIfMissing() below.
  storage_instructions TEXT,
  tips            TEXT,
  sync_status     TEXT DEFAULT 'local',
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipe_translations (
  id            TEXT PRIMARY KEY,
  recipe_id     TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recipe_id, language_code)
);

CREATE TABLE IF NOT EXISTS recipe_steps (
  id               TEXT PRIMARY KEY,
  recipe_id        TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number      INTEGER NOT NULL,
  title            TEXT,
  description      TEXT NOT NULL,
  duration_min     INTEGER,
  tool_ids         TEXT DEFAULT '[]',
  notes            TEXT,
  image_url        TEXT,
  step_ingredients TEXT DEFAULT '[]',
  -- Cooking technique(s) this step uses (e.g. "Sautéing") — same
  -- array-of-id shape as tool_ids above, see
  -- db/migrations/032_recipe_step_technique_ids.sql for the Postgres side.
  -- Backfilled onto pre-existing local DBs via addColumnIfMissing() below.
  technique_ids    TEXT DEFAULT '[]',
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe ON recipe_steps(recipe_id);

CREATE TABLE IF NOT EXISTS recipe_step_translations (
  id            TEXT PRIMARY KEY,
  step_id       TEXT NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  notes         TEXT,
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(step_id, language_code)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id            TEXT PRIMARY KEY,
  recipe_id     TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  ingredient_id TEXT REFERENCES ingredients(id),
  subtype_id    TEXT,
  sub_recipe_id TEXT REFERENCES recipes(id),
  quantity      REAL,
  quantity_text TEXT,
  unit_id       TEXT REFERENCES units(id),
  notes         TEXT,
  is_optional   INTEGER DEFAULT 0,
  -- Optional "Per il condimento"/"Per l'impasto" style header for a run of
  -- consecutive ingredients — see db/migrations/031_recipe_ingredient_groups.sql
  -- for the Postgres side of this same column. NULL = no group (unchanged
  -- behavior). Also backfilled onto pre-existing local DBs via
  -- addColumnIfMissing() below, since this table already shipped without it.
  group_name    TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_sub_recipe ON recipe_ingredients(sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS recipe_ingredient_translations (
  id                    TEXT PRIMARY KEY,
  recipe_ingredient_id  TEXT NOT NULL REFERENCES recipe_ingredients(id) ON DELETE CASCADE,
  language_code         TEXT NOT NULL,
  notes                 TEXT,
  updated_at            TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recipe_ingredient_id, language_code)
);

CREATE TABLE IF NOT EXISTS recipe_tools (
  recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  tool_id     TEXT NOT NULL REFERENCES tools(id),
  is_optional INTEGER DEFAULT 0,
  PRIMARY KEY (recipe_id, tool_id)
);

CREATE TABLE IF NOT EXISTS techniques (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  image_urls  TEXT DEFAULT '[]',
  deleted_at  TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_techniques_name_active ON techniques(name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS technique_translations (
  id            TEXT PRIMARY KEY,
  technique_id  TEXT NOT NULL REFERENCES techniques(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL,
  name          TEXT,
  description   TEXT,
  UNIQUE(technique_id, language_code)
);

CREATE TABLE IF NOT EXISTS cook_log (
  id              TEXT PRIMARY KEY,
  recipe_id       TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_by_name  TEXT,
  cooked_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cook_log_recipe ON cook_log(recipe_id);

-- wayfinder ticket 04 (standalone-storage-sync map): one row per pending
-- Structured Merge conflict on a single (entity, field) pair. base/local/
-- remote_value are JSON-encoded so both scalar fields and the whole-array
-- fields (recipes.steps/ingredients/tools, per ADR 0002) share one shape.
-- The UNIQUE constraint is what makes a repeated sync upsert the existing
-- pending conflict instead of accumulating duplicates for the same field.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  field_name    TEXT NOT NULL,
  base_value    TEXT,
  local_value   TEXT,
  remote_value  TEXT,
  detected_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_type, entity_id, field_name)
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity ON sync_conflicts(entity_type, entity_id);
`;

// A small, sensible starting catalog so the app isn't a totally empty
// shell on first run — same categories/units/base tags as the server
// deployment's own seed data (migrations 001/016/017/019), inserted only
// once (guarded by a sentinel row, not re-run on every launch).
const SEED_SQL = `
INSERT INTO units (id, name, symbol, unit_type, base_unit_symbol, to_base_factor) VALUES
  (lower(hex(randomblob(16))), 'grammi', 'g', 'weight', 'g', 1),
  (lower(hex(randomblob(16))), 'kilogrammi', 'kg', 'weight', 'g', 1000),
  (lower(hex(randomblob(16))), 'millilitri', 'ml', 'volume', 'ml', 1),
  (lower(hex(randomblob(16))), 'litri', 'l', 'volume', 'ml', 1000),
  (lower(hex(randomblob(16))), 'cucchiaio', 'tbsp', 'volume', 'ml', 15),
  (lower(hex(randomblob(16))), 'cucchiaino', 'tsp', 'volume', 'ml', 5),
  (lower(hex(randomblob(16))), 'tazza', 'cup', 'volume', 'ml', 240),
  (lower(hex(randomblob(16))), 'pezzo', 'pz', 'count', NULL, NULL),
  (lower(hex(randomblob(16))), 'quanto basta', 'q.b.', 'custom', NULL, NULL);

INSERT INTO ingredient_categories (id, name, icon, color, sort_order) VALUES
  (lower(hex(randomblob(16))), 'Verdure & Ortaggi', 'FaCarrot', '#16a34a', 0),
  (lower(hex(randomblob(16))), 'Frutta', 'FaAppleWhole', '#f97316', 1),
  (lower(hex(randomblob(16))), 'Carni', 'FaDrumstickBite', '#dc2626', 2),
  (lower(hex(randomblob(16))), 'Pesce & Frutti di Mare', 'FaFish', '#0284c7', 3),
  (lower(hex(randomblob(16))), 'Latticini & Uova', 'FaCheese', '#d97706', 4),
  (lower(hex(randomblob(16))), 'Cereali & Farine', 'FaBreadSlice', '#92400e', 5),
  (lower(hex(randomblob(16))), 'Legumi', 'FaBowlRice', '#65a30d', 6),
  (lower(hex(randomblob(16))), 'Condimenti & Spezie', 'FaPepperHot', '#7c3aed', 7),
  (lower(hex(randomblob(16))), 'Olii & Grassi', 'FaDroplet', '#ca8a04', 8),
  (lower(hex(randomblob(16))), 'Dolcificanti', 'FaCookie', '#db2777', 9),
  (lower(hex(randomblob(16))), 'Bevande & Alcolici', 'FaWineGlass', '#4f46e5', 10),
  (lower(hex(randomblob(16))), 'Altro', 'FaTag', '#71717a', 11);
`;

let initPromise: Promise<void> | null = null;

// SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS` is a no-op against a database
// that already has the table from an earlier app version — a real device
// that installed standalone mode before a column existed won't retroactively
// get it just because SCHEMA_SQL's text changed; the table's already there,
// so the CREATE never runs again. Each column added after a table first
// shipped needs one call here, alongside the flat schema itself.
async function addColumnIfMissing(db: SQLiteDBConnection, table: string, column: string, ddlType: string): Promise<void> {
  const info = await db.query(`PRAGMA table_info(${table})`);
  const exists = (info.values ?? []).some((row: { name?: string }) => row.name === column);
  if (!exists) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

/** Idempotent — safe to call on every app start. Creates the schema if
 *  this is a brand-new local DB, seeds a starter catalog on the very
 *  first run only. */
export async function initLocalSchema(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const db = await getDb();
    await db.execute(SCHEMA_SQL);
    await addColumnIfMissing(db, 'recipe_ingredients', 'group_name', 'TEXT');
    await addColumnIfMissing(db, 'recipe_steps', 'technique_ids', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'recipes', 'storage_instructions', 'TEXT');
    await addColumnIfMissing(db, 'recipes', 'tips', 'TEXT');
    await addColumnIfMissing(db, 'ingredients', 'seasonal_months', "TEXT DEFAULT '[]'");
    const seeded = await db.query('SELECT COUNT(*) as count FROM units');
    if ((seeded.values?.[0]?.count ?? 0) === 0) {
      await db.execute(SEED_SQL);
    }
  })();
  return initPromise;
}
