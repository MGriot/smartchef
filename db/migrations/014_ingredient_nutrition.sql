-- 014_ingredient_nutrition.sql
-- Per-100g nutrition facts on ingredients, so recipe/menu-level nutrition
-- can be computed by scaling against each resolved ingredient's quantity
-- (converted to grams via the existing units.to_base_factor /
-- ingredients.density_g_per_ml machinery). All nullable — most of the
-- library ships with none of this filled in; an ingredient simply doesn't
-- contribute to a nutrition total until it's populated via the Library UI.
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS calories_kcal NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS protein_g     NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS carbs_g       NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS fat_g         NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS fiber_g       NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sugar_g       NUMERIC(10,2);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sodium_mg     NUMERIC(10,2);
