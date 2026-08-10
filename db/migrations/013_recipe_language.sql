-- 013_recipe_language.sql
-- Records what language a recipe's base title/description/steps were
-- authored in. Nullable — legacy rows stay unset. Immutable after creation
-- (the backend never updates it on PUT), so editing a recipe never
-- silently relabels its base language.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS language_code VARCHAR(10);
