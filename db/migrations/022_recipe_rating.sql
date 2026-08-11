-- 022_recipe_rating.sql
-- Lets the user record how much they liked a recipe after cooking it.
-- NULL = "not tried" (N/A) — no separate flag needed since that state is
-- otherwise unrepresentable. 0-5 = star rating.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating BETWEEN 0 AND 5);
