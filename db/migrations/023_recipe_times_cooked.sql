-- 023_recipe_times_cooked.sql
-- Tracks how many times the user has cooked a recipe, incremented via a
-- dedicated endpoint (tap-to-log-a-cook), independent of rating.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS times_cooked INTEGER NOT NULL DEFAULT 0;
