-- ════════════════════════════════════════════════════════════════════════
-- 026_multi_user.sql
-- Converts the single shared-password account into real multi-user
-- support within one instance:
--   - account gets username (login identifier) + role (admin/user)
--   - recipes get creator_id (attribution only — never permission-enforced)
--   - shopping_lists / menus / collections become privately owned per user
--
-- NOTE: docker-entrypoint-initdb.d only runs against an EMPTY data volume
-- (fresh install). Against a live already-populated DB this must be
-- applied manually. Wrapped in a single transaction so a failure partway
-- through leaves the DB untouched.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. account: username + role ─────────────────────────────────────────
-- Nullable/no-cross-column-default first (Postgres ADD COLUMN defaults
-- can't reference sibling columns of the same row), backfill, THEN
-- tighten to NOT NULL / UNIQUE.
ALTER TABLE account ADD COLUMN IF NOT EXISTS username VARCHAR(50);
ALTER TABLE account ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user'
  CHECK (role IN ('admin', 'user'));

-- Slugify the existing `name` into a username: lowercase, non-alnum runs
-- collapsed to '-', trimmed. Falls back to 'admin' if that's empty (e.g.
-- a name made entirely of emoji/symbols).
UPDATE account
SET username = NULLIF(
  regexp_replace(regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'),
  ''
)
WHERE username IS NULL;
UPDATE account SET username = 'admin' WHERE username IS NULL;

-- The one pre-existing row becomes the instance's first admin. Safe as an
-- unconditional UPDATE: this migration runs exactly once, before any
-- invite/second-account flow exists, so every row that exists right now
-- IS "the existing single account" (today, exactly one — or zero on a
-- fresh install, in which case this is a no-op).
UPDATE account SET role = 'admin';

ALTER TABLE account ALTER COLUMN username SET NOT NULL;
ALTER TABLE account ADD CONSTRAINT account_username_unique UNIQUE (username);

-- ── 2. recipes: creator_id (attribution only, never enforced) ──────────
-- Deliberately NOT NOT NULL: ON DELETE SET NULL must be able to null it
-- out if that user's account is later deleted, and recipes are shared /
-- attribution-only, so an orphaned recipe is fine (creator badge just
-- disappears). NOTE: recipes.owner_id / recipes.last_editor_id are
-- pre-existing, UNRELATED, unused CRDT leftovers (001_initial_schema.sql)
-- — not touched here, don't confuse them with creator_id.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES account(id) ON DELETE SET NULL;
UPDATE recipes SET creator_id = (SELECT id FROM account WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE creator_id IS NULL;

-- ── 3. shopping_lists: owner_id becomes real + enforced ────────────────
-- Private data: if the owning user is deleted, their shopping lists go
-- with them (CASCADE) — unlike recipes, there's no "shared" reason to
-- keep an orphaned private list around.
UPDATE shopping_lists SET owner_id = (SELECT id FROM account WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE owner_id IS NULL;
ALTER TABLE shopping_lists ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE shopping_lists ADD CONSTRAINT shopping_lists_owner_fk
  FOREIGN KEY (owner_id) REFERENCES account(id) ON DELETE CASCADE;

-- ── 4. menus: owner_id becomes real + enforced ──────────────────────────
UPDATE menus SET owner_id = (SELECT id FROM account WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE owner_id IS NULL;
ALTER TABLE menus ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE menus ADD CONSTRAINT menus_owner_fk
  FOREIGN KEY (owner_id) REFERENCES account(id) ON DELETE CASCADE;

-- ── 5. collections: NEW owner_id column ─────────────────────────────────
ALTER TABLE collections ADD COLUMN IF NOT EXISTS owner_id UUID;
UPDATE collections SET owner_id = (SELECT id FROM account WHERE role = 'admin' ORDER BY created_at LIMIT 1)
WHERE owner_id IS NULL;
ALTER TABLE collections ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE collections ADD CONSTRAINT collections_owner_fk
  FOREIGN KEY (owner_id) REFERENCES account(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_shopping_lists_owner ON shopping_lists(owner_id);
CREATE INDEX IF NOT EXISTS idx_menus_owner ON menus(owner_id);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(owner_id);
CREATE INDEX IF NOT EXISTS idx_recipes_creator ON recipes(creator_id);

COMMIT;
