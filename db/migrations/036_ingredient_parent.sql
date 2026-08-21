-- 036_ingredient_parent.sql
-- Optional self-reference so a specific variety (e.g. "Red Apple", "Green
-- Apple") can be filed under a base ingredient (e.g. "Apple") for browsing
-- and search, without any inheritance machinery — a variant is a complete,
-- independent ingredient row in its own right (own nutrition, own
-- translations, own seasonality), this column is purely organizational.
-- NULL (the default) means "not a variant of anything," same as today.

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS parent_ingredient_id UUID REFERENCES ingredients(id);
CREATE INDEX IF NOT EXISTS idx_ingredients_parent ON ingredients(parent_ingredient_id);
