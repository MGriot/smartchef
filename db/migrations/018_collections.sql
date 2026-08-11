-- 018_collections.sql
-- Freeform, non-calendar recipe groupings ("Ricette della Nonna", "Cene
-- veloci") browsable from a Gallery subtab. Deliberately simpler than the
-- existing `menus`/`menu_items` tables (001_initial_schema.sql), which are
-- calendar-bound weekly meal plans — collections carry no day/meal_type,
-- just an ordered set of recipes.

CREATE TABLE IF NOT EXISTS collections (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_recipes (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  recipe_id     UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (collection_id, recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_recipes_recipe ON collection_recipes(recipe_id);

CREATE TRIGGER trg_collections_updated_at
  BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
