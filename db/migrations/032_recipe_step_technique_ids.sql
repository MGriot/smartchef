-- 032_recipe_step_technique_ids.sql
-- Lets a step reference the cooking technique(s) it uses (e.g. "Sautéing"),
-- mirroring recipe_steps.tool_ids exactly — same array-of-id shape, same
-- "no join table, just an array column" choice tool_ids already made.
-- NULL/empty means "no technique tagged" (today's only behavior).

ALTER TABLE recipe_steps ADD COLUMN IF NOT EXISTS technique_ids UUID[];
