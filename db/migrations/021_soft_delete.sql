-- 021_soft_delete.sql
-- Only recipes/ingredients had a soft-delete signal before this. Without
-- one on the other library tables, deleting a tool/tag/category/technique/
-- collection on one device would silently reappear once another device
-- (which still has it) folder-syncs it back in. Adds a tombstone column so
-- deletions can propagate instead of being resurrected.

ALTER TABLE tools               ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tags                ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE ingredient_categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE techniques           ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE collections          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- `tools` never got an updated_at column/trigger in the original schema
-- (unlike tags/techniques/collections/ingredient_categories) — needed now
-- so folder sync has a timestamp to order writes by.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tools_updated_at') THEN
    CREATE TRIGGER trg_tools_updated_at
      BEFORE UPDATE ON tools FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- tools/tags/ingredient_categories/techniques all have a plain UNIQUE(name)
-- constraint. With soft-delete, deleting "Whisk" and later recreating a
-- tool named "Whisk" would now hit that constraint against the old
-- (deleted) row. Swap each for a partial unique index that only applies to
-- non-deleted rows — the standard Postgres pattern for soft-delete +
-- uniqueness. (collections has no such constraint, nothing to do there.)
ALTER TABLE tools               DROP CONSTRAINT IF EXISTS tools_name_key;
ALTER TABLE tags                DROP CONSTRAINT IF EXISTS tags_name_key;
ALTER TABLE ingredient_categories DROP CONSTRAINT IF EXISTS ingredient_categories_name_key;
ALTER TABLE techniques           DROP CONSTRAINT IF EXISTS techniques_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_name_active               ON tools(name)               WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_active                ON tags(name)                WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredient_categories_name_active ON ingredient_categories(name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_techniques_name_active          ON techniques(name)           WHERE deleted_at IS NULL;
