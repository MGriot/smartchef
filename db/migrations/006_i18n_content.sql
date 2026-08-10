-- 006_i18n_content.sql
-- Generalizes the ingredient_translations pattern (migration 004) to the rest
-- of the user-facing content: one canonical row per entity (in its base
-- columns), with sibling *_translations tables holding per-language
-- overrides. Missing translations fall back to the base row at read time.

CREATE TABLE IF NOT EXISTS recipe_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  title VARCHAR(200),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(recipe_id, language_code)
);

CREATE TABLE IF NOT EXISTS recipe_step_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  step_id UUID NOT NULL REFERENCES recipe_steps(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  title VARCHAR(200),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(step_id, language_code)
);

CREATE TABLE IF NOT EXISTS ingredient_category_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id UUID NOT NULL REFERENCES ingredient_categories(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(category_id, language_code)
);

-- Symbols (g, ml, tbsp...) stay universal; only the display name is translated.
CREATE TABLE IF NOT EXISTS unit_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  name VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(unit_id, language_code)
);

CREATE TABLE IF NOT EXISTS tool_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tool_id, language_code)
);

CREATE INDEX IF NOT EXISTS idx_recipe_translations_lang ON recipe_translations(recipe_id, language_code);
CREATE INDEX IF NOT EXISTS idx_recipe_step_translations_lang ON recipe_step_translations(step_id, language_code);
CREATE INDEX IF NOT EXISTS idx_category_translations_lang ON ingredient_category_translations(category_id, language_code);
CREATE INDEX IF NOT EXISTS idx_unit_translations_lang ON unit_translations(unit_id, language_code);
CREATE INDEX IF NOT EXISTS idx_tool_translations_lang ON tool_translations(tool_id, language_code);
