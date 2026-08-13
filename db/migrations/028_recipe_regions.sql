-- 028_recipe_regions.sql
-- Free-form region tags on a recipe: either a bare ISO 3166-1 alpha-2
-- country code (e.g. "IT") for anything picked from the country list, or
-- hand-typed sub-national text (e.g. "Tuscany") for finer granularity that
-- has no bundled centroid data. No rigid schema, same spirit as the
-- pre-catalog free-text tags elsewhere in this app.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS regions TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_recipes_regions ON recipes USING GIN (regions);
