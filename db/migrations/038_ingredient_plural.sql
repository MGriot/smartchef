-- 038_ingredient_plural.sql
-- Optional plural form so display can pick the right word when a recipe's
-- scaled quantity isn't 1 ("apple" -> "apples"), and so matching recognizes
-- a plural in pasted/imported text against a singular catalog entry
-- ("2 apples" -> canonical "apple"). NULL (the default) falls back to the
-- singular name everywhere — never a regression for ingredients nobody
-- filled this in for. See ingredients.name/ingredient_translations.translated_name
-- for the existing per-language convention this mirrors.

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS plural_name TEXT;
ALTER TABLE ingredient_translations ADD COLUMN IF NOT EXISTS plural_translation TEXT;
