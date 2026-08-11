-- 016_tags.sql
-- Managed tag catalog for recipes (e.g. Vegetariano, Soia, Antipasto),
-- editable in the Library, plus ingredient→tag associations that drive
-- automatic recipe tagging. `exclude_tag_ids` is what makes a tag
-- "auto/diet-style": non-empty means "auto-apply this tag to a recipe
-- unless any of these other tags is present via its ingredients"
-- (e.g. Vegetariano excludes Carne/Pesce/Crostacei). Tags with an empty
-- array are either purely manual, or presence-based when referenced via
-- ingredient_tags (e.g. Soia, Glutine, Carne itself).

CREATE TABLE IF NOT EXISTS tags (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name             VARCHAR(100) NOT NULL UNIQUE,
  group_name       VARCHAR(100) NOT NULL DEFAULT 'Altro',
  color            VARCHAR(20),
  icon             VARCHAR(50),
  exclude_tag_ids  UUID[] NOT NULL DEFAULT '{}',
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tag_translations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tag_id        UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tag_id, language_code)
);

CREATE INDEX IF NOT EXISTS idx_tag_translations_lang ON tag_translations(tag_id, language_code);

CREATE TABLE IF NOT EXISTS ingredient_tags (
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  tag_id        UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (ingredient_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_tags_tag ON ingredient_tags(tag_id);

CREATE TRIGGER trg_tags_updated_at
  BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
