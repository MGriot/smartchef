-- 012_recipe_sources.sql
-- Lets a recipe carry one or more source references (a URL, a book
-- citation, a YouTube video, etc), distinct from the single `source_url`
-- column which is reserved for LLM-import provenance. Array of
-- {type: 'url'|'book'|'video'|'other', label?, url?}.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]';
