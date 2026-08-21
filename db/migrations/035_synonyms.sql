-- 035_synonyms.sql
-- Optional alternate names for tags, ingredients, tools, and techniques —
-- e.g. "scallion"/"green onion", "courgette"/"zucchini" — so a search for
-- either finds the same catalog row without the user having to guess which
-- one was actually used. Purely additive to search; the canonical `name`
-- column stays what's actually displayed everywhere.

ALTER TABLE tags ADD COLUMN IF NOT EXISTS synonyms TEXT[] DEFAULT '{}';
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS synonyms TEXT[] DEFAULT '{}';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS synonyms TEXT[] DEFAULT '{}';
ALTER TABLE techniques ADD COLUMN IF NOT EXISTS synonyms TEXT[] DEFAULT '{}';
