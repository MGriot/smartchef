-- 031_recipe_ingredient_groups.sql
-- Optional label for a run of consecutive ingredients within one recipe's
-- ingredient list — "Per il condimento" / "Per l'impasto" style headers,
-- the way most recipe platforms group ingredients without needing a whole
-- separate sub-recipe (recipe_ingredients.sub_recipe_id already covers the
-- heavier case: a genuinely reusable component with its own steps/yield).
-- NULL means "no group" (today's only behavior) — purely additive.

ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS group_name TEXT;
