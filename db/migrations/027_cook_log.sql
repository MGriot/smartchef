-- 027_cook_log.sql
-- One row per "I cooked this" tap, timestamped — source of truth for the
-- cook-history calendar. recipes.times_cooked stays as a fast denormalized
-- counter, unchanged by this migration.

CREATE TABLE IF NOT EXISTS cook_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_by UUID REFERENCES account(id) ON DELETE SET NULL,
  cooked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cook_log_recipe ON cook_log(recipe_id);
CREATE INDEX IF NOT EXISTS idx_cook_log_cooked_at ON cook_log(cooked_at);
