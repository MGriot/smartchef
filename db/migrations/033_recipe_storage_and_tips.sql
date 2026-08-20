-- 033_recipe_storage_and_tips.sql
-- Two free-text fields the recipe form/detail view were missing entirely:
-- how to store leftovers ("Come conservare") and general tips/notes
-- ("Consigli") distinct from the recipe's own short description. Purely
-- additive, both nullable.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS storage_instructions TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS tips TEXT;
