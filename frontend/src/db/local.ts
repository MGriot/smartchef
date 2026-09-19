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
    await applyWriteJournalPragmas(database);
    return database;
  })();
  return dbPromise;
}

// ── Write durability settings ─────────────────────────────────────────────
// Neither platform's plugin sets these, so both inherited SQLite's own
// defaults: journal_mode=delete (a rollback journal file created, fsync'd
// and deleted around every write) and synchronous=FULL (fsync at every
// commit boundary). That combination is only affordable when writes come in
// large transactions — and here they never do. The plugin's run() wraps
// EVERY statement in its own BEGIN/COMMIT (its `transaction` option defaults
// to true), and withTransaction() below is deliberately NOT a real
// transaction either (see its comment for why), so each individual INSERT in
// a save loop pays a full journal create/fsync/delete cycle of its own.
//
// Measured on the real local library, desktop NVMe:
//   200 single-statement writes, delete + FULL  ..... 996 ms  (4.98 ms each)
//   200 single-statement writes, WAL + NORMAL  .....  24 ms  (0.12 ms each)
// and one real recipe save (23 ingredients, 8 steps) = 36 write statements
// = 292 ms of pure SQLite time before any bridge cost at all. Android pays
// the same shape on slower flash, through SQLCipher's page encryption.
//
// That cost is not confined to saving, which is why this shows up as "slow
// to LOAD": serialize() below is one FIFO for the whole app, so a sync
// merge's few hundred row writes hold the queue for seconds and every
// gallery/recipe read queued behind them simply waits — with no slow query
// anywhere to find.
//
// WAL is safe here specifically because nothing in this app ever copies the
// database file itself (the -wal/-shm sidecars would otherwise need a
// checkpoint first): backups go through exportSnapshot()'s SQL, and the
// Android mirror replicates the Sync Folder, never Local Storage.
// synchronous=NORMAL is WAL's documented companion — a crash can lose the
// last commits, a power cut cannot corrupt the database — which is the right
// trade for a local, single-user, git-replicated library.
//
// ── How the pragma has to be issued, per platform ─────────────────────────
// This shipped in 1.1.2 using execute() only, and on ANDROID IT NEVER
// APPLIED. The Android plugin runs execute() through
// SQLiteDatabase.execSQL(), which refuses any statement that returns rows —
// and `PRAGMA journal_mode=WAL` returns the new mode — failing with "Queries
// can be performed using SQLiteDatabase query or rawQuery methods only".
// The try/catch that keeps the database opening swallowed that into a
// console.warn, so Android stayed on a rollback journal with FULL sync, the
// platform that needed the change most. Found on an emulator against the
// real plugin; query() works there.
//
// query() is not universal either: better-sqlite3 on Electron can refuse
// query() for a statement that returns no rows, which `synchronous=NORMAL`
// does not. Hence query first, execute() as the fallback — with `false` as
// execute()'s second argument, because SQLite ignores journal_mode inside a
// pending transaction and execute() otherwise wraps itself in one.
//
// And the result is read back rather than assumed: a pragma a platform
// accepts but ignores would otherwise be exactly as silent as the failure
// above.
async function runPragma(database: SQLiteDBConnection, statement: string): Promise<void> {
  try {
    await database.query(statement, []);
  } catch {
    await database.execute(statement, false);
  }
}

export async function applyWriteJournalPragmas(database: SQLiteDBConnection): Promise<{ journalMode: string | null; synchronous: number | null }> {
  try {
    await runPragma(database, 'PRAGMA journal_mode=WAL');
    await runPragma(database, 'PRAGMA synchronous=NORMAL');
  } catch (err) {
    // A platform that refuses both forms keeps the old (slow, but correct)
    // defaults rather than failing to open the database at all — this runs
    // inside the one code path every screen depends on.
    console.warn('SmartChef: could not apply SQLite journal pragmas:', err);
  }

  let journalMode: string | null = null;
  let synchronous: number | null = null;
  try {
    const jm = await database.query('PRAGMA journal_mode', []);
    journalMode = String((jm.values?.[0] as Record<string, unknown> | undefined)?.journal_mode ?? '') || null;
    const sy = await database.query('PRAGMA synchronous', []);
    const raw = (sy.values?.[0] as Record<string, unknown> | undefined)?.synchronous;
    synchronous = typeof raw === 'number' ? raw : raw != null ? Number(raw) : null;
  } catch {
    // Reading back is diagnostic only; never fatal.
  }
  if (journalMode && journalMode.toLowerCase() !== 'wal') {
    console.warn(`SmartChef: SQLite is running with journal_mode=${journalMode}, not WAL — writes will be slow on this device`);
  }
  return { journalMode, synchronous };
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

// SQLite is single-writer — one shared connection, no real connection pool
// — so ANY two calls against it must be serialized to keep one caller's
// statement(s) from interleaving with another's. This is a local
// single-user app (not a server fielding concurrent requests), so a simple
// promise-chain mutex is enough — but it has to wrap every entry point
// that touches `db`, not just withTransaction()'s multi-statement
// sequences. It used to only wrap withTransaction(); plain query()/
// queryOne() (everything services/conflicts.local.ts uses — entityExists(),
// createEntity(), applyEntityMergeResult()) had none at all. That was
// invisible for as long as every caller happened to run sequentially, but
// mergeBridge.ts's per-entity concurrency (added the same day this was
// found — see gitSync.ts's mergeRemoteIntoLocal() callers) fires up to 8
// of these at once during a pull, which can genuinely interleave against
// Android's single native SQLite connection: real symptom hit in
// production — ingredients/tools/tags/etc. (the newly-concurrent path)
// silently failed to import on a fresh Android pull while recipes
// (deliberately kept sequential, for the unrelated matrioska-ordering
// reason) synced fine every time.
let sqliteQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = sqliteQueue.then(fn, fn);
  // Swallow rejection on the shared chain itself (each caller still gets
  // the real error via `next`) so one failed call doesn't wedge every
  // caller queued after it.
  sqliteQueue = next.catch(() => {});
  return next;
}

export function query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  return serialize(async () => {
    const db = await getDb();
    return exec<T>(db, text, params ?? []);
  });
}

export async function queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params); // already serialized inside query()
  return rows[0] ?? null;
}

// ── IN (...) batching helpers ─────────────────────────────────────────────
// Every plugin call from query() is a real bridge crossing with per-call
// latency (see docs/plans/2026-08-22-android-performance-plan.md), so any
// "one lookup per row" loop wants collapsing into a single `IN (...)` query
// plus a lookup map. These two helpers are what that rewrite needs.

/** Appends `values` to `params` and returns the matching `$1, $2, ...` list
 *  to splice into an `IN (...)`. */
export function inPlaceholders(params: unknown[], values: unknown[]): string {
  return values.map(v => { params.push(v); return `$${params.length}`; }).join(', ');
}

/** Splits `values` into runs small enough that one `IN (...)` per run stays
 *  under SQLite's bound-parameter ceiling. That ceiling is 32766 on any
 *  modern build but only 999 on older ones, and this app ships against two
 *  different engines (better-sqlite3-multiple-ciphers on Electron, the
 *  Android plugin's own build) — 500 is comfortably under the lower figure
 *  on both, and the whole point of the callers below is to stop imposing
 *  arbitrary row ceilings, so the batching must not quietly reintroduce one. */
export function chunk<T>(values: T[], size = 500): T[][] {
  if (values.length <= size) return values.length ? [values] : [];
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Client handle passed into withTransaction()'s callback — mirrors
 *  `pg.PoolClient`'s `query() => {rows}` shape (not this module's own
 *  `query() => T[]`) since that's the shape every ported route file's
 *  `client.query(...)` / `.rows` call sites already assume. */
export interface LocalClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

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
export function withTransaction<T>(fn: (client: LocalClient) => Promise<T>): Promise<T> {
  return serialize(async () => {
    const db = await getDb();
    const client: LocalClient = {
      query: async (text, params) => ({ rows: await exec(db, text, params ?? []) }),
    };
    return fn(client);
  });
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
-- Household members sharing this standalone library — see lib/standalone.ts
-- and services/profiles.local.ts. Synced like any other entity (writeEntityFile
-- + mergeBridge.ts's ENTITY_DIRS) so a profile created on one device shows
-- up as pickable on every other device sharing the same Sync Folder,
-- unlike the old single-profile-in-Preferences design where each device's
-- "who am I" was invisible to every other device. Which profile a given
-- *device* is currently using is a separate, deliberately per-device
-- Preferences pointer (smartchef.activeProfileId) — never synced, same
-- spirit as the device id/name gitSync.ts already keeps local-only.
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar_url  TEXT,
  -- 'admin' | 'user'. First profile ever created on a fresh library becomes
  -- admin automatically (see createProfile() in profiles.local.ts); a UX
  -- guardrail against accidental deletion/promotion mistakes, not a real
  -- security boundary — standalone mode has no auth layer to enforce it.
  -- Backfilled onto pre-existing local DBs via addColumnIfMissing() below.
  role        TEXT NOT NULL DEFAULT 'user',
  deleted_at  TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

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
  -- Deliberately NOT "REFERENCES ingredient_categories(id)" — categories
  -- are per-device seed data (SEED_SQL below gives every device its own
  -- random ids, never synced via mergeBridge.ts's ENTITY_DIRS), so a
  -- synced-in ingredient's category_id essentially never matches a row
  -- that exists on this device. A real FK here throws "FOREIGN KEY
  -- constraint failed" on every single cross-device ingredient create —
  -- confirmed as this app's actual behavior despite no PRAGMA
  -- foreign_keys statement anywhere (see dropDanglingForeignKeys() below
  -- for the full story and the migration that removes this on existing
  -- devices). listIngredients()'s LEFT JOIN + COALESCE already treats a
  -- non-matching category_id as "Uncategorized" by design, so nothing
  -- downstream needed this to be a hard reference in the first place.
  category_id    TEXT NOT NULL,
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
  -- Optional alternate names ("scallion"/"green onion") — search-only, see
  -- db/migrations/035_synonyms.sql. Backfilled via addColumnIfMissing() below.
  synonyms       TEXT DEFAULT '[]',
  -- Optional "this is a variety of" self-reference (e.g. Red Apple ->
  -- Apple) — purely organizational, no inherited fields. See
  -- db/migrations/036_ingredient_parent.sql. Backfilled via
  -- addColumnIfMissing() below.
  parent_ingredient_id TEXT REFERENCES ingredients(id),
  -- Optional canonical-English plural ("apples" for "apple") so display can
  -- pick the right form when a recipe's scaled quantity isn't 1, and so
  -- matching can recognize a plural in pasted/imported text against the
  -- singular catalog entry. NULL = no plural on file, falls back to 'name'
  -- everywhere (never a regression for ingredients nobody filled this in
  -- for). Backfilled via addColumnIfMissing() below.
  plural_name    TEXT,
  sync_status    TEXT DEFAULT 'local',
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category_id);
-- idx_ingredients_parent is NOT created here on purpose — see
-- initLocalSchema() below. This whole script runs unconditionally on every
-- launch, but CREATE TABLE IF NOT EXISTS is a no-op against a database
-- that already has the table (the normal case for any real device by now),
-- so the column addition above never actually lands on one. A CREATE
-- INDEX in this same script isn't gated by that no-op the way the table
-- body is — it still tries to build an index against the *current*
-- (pre-migration) table shape, and fails outright with "no such column"
-- on exactly the devices addColumnIfMissing() exists to support. Deferred
-- to after that call actually runs.

CREATE TABLE IF NOT EXISTS ingredient_translations (
  id              TEXT PRIMARY KEY,
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  language_code   TEXT NOT NULL,
  translated_name TEXT NOT NULL,
  -- Per-language plural, same optional/fallback-to-singular convention as
  -- ingredients.plural_name above. Backfilled via addColumnIfMissing() below.
  plural_translation TEXT,
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
  synonyms    TEXT DEFAULT '[]',
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
  synonyms        TEXT DEFAULT '[]',
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

-- Translated labels for tags.group_name. Keyed by the group's own text
-- rather than by an id, because a tag group is not an entity: group_name
-- is free text on the tag row, with no "groups" table to hang a foreign
-- key off (see tags.local.ts's mergeTagGroups(), which "merges" two groups
-- by bulk-renaming that column). Renaming a group therefore has to carry
-- these rows across by name, which mergeTagGroups() does.
-- See db/migrations/041_tag_group_translations.sql for the Postgres side.
CREATE TABLE IF NOT EXISTS tag_group_translations (
  id            TEXT PRIMARY KEY,
  group_name    TEXT NOT NULL,
  language_code TEXT NOT NULL,
  name          TEXT NOT NULL,
  UNIQUE(group_name, language_code)
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
  -- Same reasoning as ingredients.category_id above — units are per-device
  -- seed data too, never synced, so a hard REFERENCES units(id) here
  -- throws on a perfectly legitimate synced recipe.
  yield_unit_id   TEXT,
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
  -- Same reasoning as ingredients.category_id above — a hard FK here
  -- threw on almost every synced-in recipe_ingredients row (nearly every
  -- ingredient line has a unit), and writeArrayField()'s DELETE-then-
  -- reinsert shape meant a mid-loop throw left the recipe's ingredient
  -- list truncated to whichever rows inserted before the failing one.
  unit_id       TEXT,
  notes         TEXT,
  is_optional   INTEGER DEFAULT 0,
  -- Optional "Per il condimento"/"Per l'impasto" style header for a run of
  -- consecutive ingredients — see db/migrations/031_recipe_ingredient_groups.sql
  -- for the Postgres side of this same column. NULL = no group (unchanged
  -- behavior). Also backfilled onto pre-existing local DBs via
  -- addColumnIfMissing() below, since this table already shipped without it.
  group_name    TEXT,
  -- This row is an ALTERNATIVE to the row at this sort_order, not another
  -- thing to buy: "or 100 g of margarine" under the butter. NULL for every
  -- ordinary ingredient. Referenced by sort_order (not by id) for the same
  -- reason recipe_steps.step_ingredients references ingredients that way —
  -- it survives a round-trip through the editor's draft, where rows have
  -- no id until they are saved. Also backfilled onto pre-existing local
  -- DBs via addColumnIfMissing() below.
  substitute_for INTEGER,
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
  synonyms    TEXT DEFAULT '[]',
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

-- What is actually in the house. Local-only like the shopping list and the
-- planner: a cupboard is this household's, not library content other
-- devices need.
--
-- quantity and unit are nullable on purpose - "I have flour" is worth
-- recording without weighing the bag, and a row with no quantity counts as
-- "enough" when matching a recipe. One row per ingredient, so topping up
-- edits rather than adding a second line the matcher would have to sum.
CREATE TABLE IF NOT EXISTS pantry_items (
  id            TEXT PRIMARY KEY,
  ingredient_id TEXT NOT NULL,
  quantity      REAL,
  unit_id       TEXT,
  expires_at    TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ingredient_id)
);

-- Free-form recipe collections (the Gallery's "Collections" sub-tab).
-- Local-only like menus and shopping lists below: the server keeps these
-- per-user rather than shared, and the sync snapshot carries library
-- content, not one person's groupings.
CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_recipes (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  recipe_id     TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, recipe_id)
);

-- Weekly menus (the Planner). Local-only for the same reason as shopping
-- lists below: a week's plan is personal and short-lived, and the sync
-- snapshot carries library content, not scheduling.
CREATE TABLE IF NOT EXISTS menus (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  week_start  TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           TEXT PRIMARY KEY,
  menu_id      TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  recipe_id    TEXT NOT NULL,
  day_of_week  INTEGER NOT NULL,
  meal_type    TEXT NOT NULL DEFAULT 'dinner',
  servings     INTEGER NOT NULL DEFAULT 4,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_menu_items_menu ON menu_items(menu_id);

-- Shopping lists. Local-only, deliberately outside the sync snapshot
-- (backup.local.ts's Snapshot has no shopping section, and the server keeps
-- these owner-scoped rather than shared) — a shopping list is a throwaway
-- artefact of "what am I buying this week", not part of the library other
-- devices need. source_details is the JSON array of {recipeId, recipeTitle,
-- servings, quantity, unitSymbol} that drives the by-recipe view, same
-- shape the server stores.
CREATE TABLE IF NOT EXISTS shopping_lists (
  id          TEXT PRIMARY KEY,
  menu_id     TEXT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id               TEXT PRIMARY KEY,
  shopping_list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  ingredient_id    TEXT,
  total_quantity   REAL,
  quantity_text    TEXT,
  unit_id          TEXT,
  is_checked       INTEGER NOT NULL DEFAULT 0,
  source_details   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list ON shopping_list_items(shopping_list_id);

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
  -- Each side's entity updated_at when the conflict was recorded — what
  -- the 'newest' conflict policy and the Conflicts card's "newer" badge
  -- compare (ADR 0006).
  local_updated_at  TEXT,
  remote_updated_at TEXT,
  detected_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_type, entity_id, field_name)
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity ON sync_conflicts(entity_type, entity_id);

-- Two-way reconciliation (services/syncReconcile.local.ts). Local-only.
-- sync_index: the row's updated_at as of the last time its entity file was
-- written from (or applied to) this database. A row whose updated_at no
-- longer matches changed without reaching the repo and is re-published.
CREATE TABLE IF NOT EXISTS sync_index (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  updated_at  TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
-- sync_repair: entities whose file is in the repo but whose write into this
-- database failed during a merge. Re-applied from HEAD every sync until
-- they succeed.
CREATE TABLE IF NOT EXISTS sync_repair (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_type, entity_id)
);
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

async function hasForeignKeyTo(db: SQLiteDBConnection, table: string, refTable: string): Promise<boolean> {
  const info = await db.query(`PRAGMA foreign_key_list(${table})`);
  return (info.values ?? []).some((row: { table?: string }) => row.table === refTable);
}

// One-time migration for devices that created their local DB before the
// SCHEMA_SQL edit above: ingredients.category_id, recipes.yield_unit_id,
// and recipe_ingredients.unit_id used to be real
// "REFERENCES ingredient_categories(id)"/"REFERENCES units(id)" foreign
// keys. Both referenced tables are per-device seed data (SEED_SQL gives
// every device its own random ids; neither is a synced entity type in
// mergeBridge.ts's ENTITY_DIRS), so a value that arrived via sync from
// another device essentially never matches a row that exists here — and
// this app's actual SQLite engine DOES enforce foreign keys despite no
// PRAGMA foreign_keys statement anywhere in this codebase (confirmed the
// hard way in backup.local.ts's recipe-restore path). The practical result,
// found in production: createEntity() for a synced ingredient, and
// writeArrayField()'s recipe_ingredients insert for a synced recipe, threw
// "FOREIGN KEY constraint failed" on essentially every cross-device
// ingredient/recipe-ingredient-line — caught by mergeBridge.ts's own
// try/catch and reported as a failedEntities error, but with a message
// that gave no hint the actual cause was a schema constraint that should
// never have been enforced in the first place, not a real data problem.
//
// SQLite has no ALTER TABLE support for dropping a column's REFERENCES
// clause, so each table gets rebuilt: create the new shape, copy every
// row across, drop the old table, rename the new one into place. Detected
// via PRAGMA foreign_key_list rather than a version flag, so this safely
// no-ops both on a device that already migrated and on a brand-new device
// whose SCHEMA_SQL never had the FK to begin with — the common case going
// forward, this function existing only for devices provisioned before it.
async function dropDanglingForeignKeys(db: SQLiteDBConnection): Promise<void> {
  // Every call below passes `transaction: false` (execute()'s 2nd arg,
  // default true) — @capacitor-community/sqlite's executeSQL() wraps a
  // transaction:true call in its own BEGIN/COMMIT, and SQLite documents
  // "PRAGMA foreign_keys" as a no-op while a transaction is pending. Left
  // at the default, the OFF below silently never takes effect (foreign_keys
  // stays ON for the whole rebuild that follows, in its OWN separate
  // transaction:true call) and the DROP-and-rebuild throws the exact
  // "FOREIGN KEY constraint failed" this function exists to get rid of —
  // confirmed against a real device's production database (290 ingredients/
  // 43 recipes): identical SQL succeeds with the transaction wrapper
  // removed and fails identically to the field report with it left on.
  if (await hasForeignKeyTo(db, 'ingredients', 'ingredient_categories')) {
    await db.execute('PRAGMA foreign_keys=OFF', false);
    await db.execute(`
      CREATE TABLE ingredients_new (
        id             TEXT PRIMARY KEY,
        category_id    TEXT NOT NULL,
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
        seasonal_months TEXT DEFAULT '[]',
        synonyms       TEXT DEFAULT '[]',
        parent_ingredient_id TEXT REFERENCES ingredients(id),
        sync_status    TEXT DEFAULT 'local',
        created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO ingredients_new (id, category_id, name, description, icon, image_urls, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, seasonal_months, synonyms, parent_ingredient_id, sync_status, created_at, updated_at)
        SELECT id, category_id, name, description, icon, image_urls, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, seasonal_months, synonyms, parent_ingredient_id, sync_status, created_at, updated_at
        FROM ingredients;
      DROP TABLE ingredients;
      ALTER TABLE ingredients_new RENAME TO ingredients;
      CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category_id);
      CREATE INDEX IF NOT EXISTS idx_ingredients_parent ON ingredients(parent_ingredient_id);
    `, false);
    await db.execute('PRAGMA foreign_keys=ON', false);
  }

  if (await hasForeignKeyTo(db, 'recipes', 'units')) {
    await db.execute('PRAGMA foreign_keys=OFF', false);
    await db.execute(`
      CREATE TABLE recipes_new (
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
        yield_unit_id   TEXT,
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
        storage_instructions TEXT,
        tips            TEXT,
        sync_status     TEXT DEFAULT 'local',
        created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO recipes_new (id, title, description, difficulty, servings, prep_time_min, cook_time_min, rest_time_min, rating, yield_amount, yield_unit_id, tags, regions, region_coords, cover_image_url, source_url, sources, is_component, language_code, times_cooked, creator_name, storage_instructions, tips, sync_status, created_at, updated_at)
        SELECT id, title, description, difficulty, servings, prep_time_min, cook_time_min, rest_time_min, rating, yield_amount, yield_unit_id, tags, regions, region_coords, cover_image_url, source_url, sources, is_component, language_code, times_cooked, creator_name, storage_instructions, tips, sync_status, created_at, updated_at
        FROM recipes;
      DROP TABLE recipes;
      ALTER TABLE recipes_new RENAME TO recipes;
    `, false);
    await db.execute('PRAGMA foreign_keys=ON', false);
  }

  if (await hasForeignKeyTo(db, 'recipe_ingredients', 'units')) {
    await db.execute('PRAGMA foreign_keys=OFF', false);
    await db.execute(`
      CREATE TABLE recipe_ingredients_new (
        id            TEXT PRIMARY KEY,
        recipe_id     TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        ingredient_id TEXT REFERENCES ingredients(id),
        subtype_id    TEXT,
        sub_recipe_id TEXT REFERENCES recipes(id),
        quantity      REAL,
        quantity_text TEXT,
        unit_id       TEXT,
        notes         TEXT,
        is_optional   INTEGER DEFAULT 0,
        group_name    TEXT,
        created_at    TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO recipe_ingredients_new (id, recipe_id, sort_order, ingredient_id, subtype_id, sub_recipe_id, quantity, quantity_text, unit_id, notes, is_optional, group_name, created_at)
        SELECT id, recipe_id, sort_order, ingredient_id, subtype_id, sub_recipe_id, quantity, quantity_text, unit_id, notes, is_optional, group_name, created_at
        FROM recipe_ingredients;
      DROP TABLE recipe_ingredients;
      ALTER TABLE recipe_ingredients_new RENAME TO recipe_ingredients;
      CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
      CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_sub_recipe ON recipe_ingredients(sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;
    `, false);
    await db.execute('PRAGMA foreign_keys=ON', false);
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
    await addColumnIfMissing(db, 'recipe_ingredients', 'substitute_for', 'INTEGER');
    await addColumnIfMissing(db, 'recipe_steps', 'technique_ids', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'recipes', 'storage_instructions', 'TEXT');
    await addColumnIfMissing(db, 'recipes', 'tips', 'TEXT');
    await addColumnIfMissing(db, 'ingredients', 'seasonal_months', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'ingredients', 'synonyms', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'ingredients', 'parent_ingredient_id', 'TEXT');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_ingredients_parent ON ingredients(parent_ingredient_id)');
    await addColumnIfMissing(db, 'tools', 'synonyms', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'tags', 'synonyms', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'techniques', 'synonyms', "TEXT DEFAULT '[]'");
    await addColumnIfMissing(db, 'profiles', 'role', "TEXT NOT NULL DEFAULT 'user'");
    // createProfile() (profiles.local.ts) only makes the *first-ever*
    // profile an admin — a device upgrading from before `role` existed has
    // one or more profiles that all just got backfilled to 'user' above, so
    // without this, nobody would ever be admin and the promote/delete UI
    // (gated to admins) would be permanently unreachable. One-time, and a
    // no-op once any profile is already an admin.
    const existingAdmin = await db.query("SELECT id FROM profiles WHERE role='admin' AND deleted_at IS NULL LIMIT 1");
    if ((existingAdmin.values?.length ?? 0) === 0) {
      const earliest = await db.query("SELECT id FROM profiles WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1");
      const earliestId = earliest.values?.[0]?.id;
      if (earliestId) await db.execute(`UPDATE profiles SET role='admin' WHERE id='${earliestId}'`);
    }
    await addColumnIfMissing(db, 'ingredients', 'plural_name', 'TEXT');
    await addColumnIfMissing(db, 'sync_conflicts', 'local_updated_at', 'TEXT');
    await addColumnIfMissing(db, 'sync_conflicts', 'remote_updated_at', 'TEXT');
    await addColumnIfMissing(db, 'ingredient_translations', 'plural_translation', 'TEXT');
    await dropDanglingForeignKeys(db);
    const seeded = await db.query('SELECT COUNT(*) as count FROM units');
    if ((seeded.values?.[0]?.count ?? 0) === 0) {
      await db.execute(SEED_SQL);
    }
    await rekeyPortableIds(db);
  })();
  return initPromise;
}

// Categories and units used to be seeded with random ids per device, which
// made the same "Frutta" or "g" a different row everywhere — impossible to
// sync as an entity, and the reason synced ingredients all landed in
// "Uncategorized". ADR 0006 gives them ids derived from the name/symbol
// (services/syncExtras.local.ts), the same on every device. This moves
// existing rows onto those ids, repointing everything that references
// them. Runs every start and is a no-op once every row is re-keyed.
function portableSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

async function rekeyPortableIds(db: SQLiteDBConnection): Promise<void> {
  const categories = (await db.query(`SELECT id, name FROM ingredient_categories`)).values ?? [];
  const takenCategoryIds = new Set(categories.map((c: { id: string }) => c.id));
  for (const category of categories as Array<{ id: string; name: string }>) {
    if (category.id.startsWith('cat-')) continue;
    const target = `cat-${portableSlug(category.name)}`;
    if (takenCategoryIds.has(target)) continue; // another row already owns that name's id
    takenCategoryIds.add(target);
    // The active-name unique index would reject a second "Frutta" while
    // both rows exist, so the old row steps aside first.
    await db.run(`UPDATE ingredient_categories SET name = name || ' (rekey ' || id || ')' WHERE id = ?`, [category.id]);
    await db.run(
      `INSERT INTO ingredient_categories (id, name, description, icon, color, sort_order, deleted_at, created_at, updated_at)
       SELECT ?, ?, description, icon, color, sort_order, deleted_at, created_at, updated_at FROM ingredient_categories WHERE id = ?`,
      [target, category.name, category.id]
    );
    await db.run(`UPDATE ingredients SET category_id = ? WHERE category_id = ?`, [target, category.id]);
    await db.run(`UPDATE ingredient_category_translations SET category_id = ? WHERE category_id = ?`, [target, category.id]);
    await db.run(`DELETE FROM ingredient_categories WHERE id = ?`, [category.id]);
  }

  const units = (await db.query(`SELECT id, name, symbol FROM units`)).values ?? [];
  const takenUnitIds = new Set(units.map((u: { id: string }) => u.id));
  for (const unit of units as Array<{ id: string; name: string; symbol: string }>) {
    if (unit.id.startsWith('unit-')) continue;
    const target = `unit-${portableSlug(unit.symbol)}`;
    if (takenUnitIds.has(target)) continue;
    takenUnitIds.add(target);
    await db.run(`UPDATE units SET name = name || ' (rekey)', symbol = symbol || ' (rekey)' WHERE id = ?`, [unit.id]);
    await db.run(
      `INSERT INTO units (id, name, symbol, unit_type, base_unit_symbol, to_base_factor, system, created_at)
       SELECT ?, ?, ?, unit_type, base_unit_symbol, to_base_factor, system, created_at FROM units WHERE id = ?`,
      [target, unit.name, unit.symbol, unit.id]
    );
    for (const [table, column] of [
      ['recipe_ingredients', 'unit_id'], ['recipes', 'yield_unit_id'], ['pantry_items', 'unit_id'],
      ['shopping_list_items', 'unit_id'], ['unit_translations', 'unit_id'],
    ]) {
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, [target, unit.id]);
    }
    await db.run(`DELETE FROM units WHERE id = ?`, [unit.id]);
  }
}
