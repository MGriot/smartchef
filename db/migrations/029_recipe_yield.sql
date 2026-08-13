-- 029_recipe_yield.sql
-- Optional "this recipe makes ~Xg / Xml" field, so a sub-recipe used as an
-- "ingredient" in another recipe can be specified by weight/volume instead
-- of only "N servings of it" — see matrioska.engine.ts's resolveIngredients
-- sub-recipe branch, which now converts via units.to_base_factor when both
-- the ingredient row's unit and this yield's unit share the same
-- (weight|volume) unit_type.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS yield_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS yield_unit_id UUID REFERENCES units(id);
