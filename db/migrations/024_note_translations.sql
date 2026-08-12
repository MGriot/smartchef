-- 024_note_translations.sql
-- Extends the i18n content pattern (migration 006) to two fields that
-- previously had no translation mechanism at all: a step's Chef's Note,
-- and a recipe-line ingredient's free-text note (e.g. "finely chopped").

ALTER TABLE recipe_step_translations ADD COLUMN IF NOT EXISTS notes TEXT;

-- Scoped to the recipe *line* (recipe_ingredients), not the master
-- ingredient catalog entity — deliberately separate from the existing
-- ingredient_translations table, which translates the catalog ingredient's
-- name, not a specific recipe's note about how to use it.
CREATE TABLE IF NOT EXISTS recipe_ingredient_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_ingredient_id UUID NOT NULL REFERENCES recipe_ingredients(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (recipe_ingredient_id, language_code)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredient_translations_lang ON recipe_ingredient_translations(recipe_ingredient_id, language_code);
