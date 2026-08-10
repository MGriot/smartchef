-- 007_tool_icons_and_step_ingredients.sql

-- Tools previously stored Material Symbols ligature names, several of which
-- ('whisk', 'knife', 'pestle', 'rolling_pin') don't exist in that icon set
-- and rendered as literal text. Tools now use react-icons/fa6 names instead
-- (same icon system already used for ingredients), which has a defined
-- fallback icon when a name doesn't resolve.
UPDATE tools SET icon = 'FaMortarPestle' WHERE icon = 'pestle';
UPDATE tools SET icon = 'FaBlender'      WHERE icon = 'blender';
UPDATE tools SET icon = 'FaUtensils'     WHERE icon = 'knife';
UPDATE tools SET icon = 'FaBowlFood'     WHERE icon = 'whisk';
UPDATE tools SET icon = 'FaGripLines'    WHERE icon = 'rolling_pin';
UPDATE tools SET icon = 'FaFireBurner'   WHERE icon = 'skillet';
UPDATE tools SET icon = 'FaKitchenSet'   WHERE icon = 'oven_gen';

-- Lets a recipe step reference specific recipe ingredients and the portion
-- (fraction of that ingredient's total recipe quantity) used in that step,
-- e.g. "half the flour now, the rest later". Array of
-- {ingredientSortOrder, portion, notes}; ingredientSortOrder matches
-- recipe_ingredients.sort_order for the parent recipe, avoiding an FK to a
-- row that may not exist yet during the drop+reinsert save flow.
ALTER TABLE recipe_steps ADD COLUMN IF NOT EXISTS step_ingredients JSONB DEFAULT '[]';
