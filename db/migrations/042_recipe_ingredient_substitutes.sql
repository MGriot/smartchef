-- 042_recipe_ingredient_substitutes.sql
-- An ingredient row that is an ALTERNATIVE to another row of the same
-- recipe — "or 100 g of margarine" under the butter — rather than a
-- further thing the recipe needs.
--
-- `is_optional` could not say this: it makes a row skippable, but nothing
-- ties it to the row it stands in for, so a substitute either read as an
-- extra ingredient (shopping list buys both, nutrition adds both, the
-- pantry matcher demands both) or, marked optional, as a garnish nobody
-- would guess replaces the one above it.
--
-- Stored as the sort_order of the row it replaces, not as a row id, to
-- match how recipe_steps.step_ingredients already references ingredients:
-- the editor's draft has no ids until it is saved, and both ends of this
-- relationship are rewritten wholesale on every save anyway.
-- NULL means "an ordinary ingredient" — purely additive.

ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS substitute_for INTEGER;
