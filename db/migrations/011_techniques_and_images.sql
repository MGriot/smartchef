-- 011_techniques_and_images.sql
-- Adds a Techniques library (mirrors the ingredients/tools pattern: base
-- table + translations) and multi-image support for ingredients and tools,
-- so users can attach one or more reference photos to help identify them.

CREATE TABLE IF NOT EXISTS techniques (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icon        VARCHAR(50),
  image_urls  TEXT[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technique_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  technique_id UUID NOT NULL REFERENCES techniques(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL,
  name VARCHAR(100),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(technique_id, language_code)
);

CREATE INDEX IF NOT EXISTS idx_technique_translations_lang ON technique_translations(technique_id, language_code);

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';
ALTER TABLE tools       ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';

CREATE TRIGGER trg_techniques_updated_at
  BEFORE UPDATE ON techniques FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed a handful of common cooking techniques, matching the depth already
-- given to tools/ingredients.
INSERT INTO techniques (name, description, icon) VALUES
  ('Boil', 'Cook in liquid at a rolling, bubbling temperature', 'FaFire'),
  ('Simmer', 'Cook gently in liquid just below boiling point', 'FaFire'),
  ('Sauté', 'Cook quickly in a small amount of fat over high heat', 'FaFire'),
  ('Blanch', 'Briefly boil, then plunge into ice water to stop cooking', 'FaSnowflake'),
  ('Knead', 'Work dough by hand to develop gluten', 'FaHandFist'),
  ('Julienne', 'Cut into thin, matchstick-sized strips', 'FaKnifeKitchen'),
  ('Dice', 'Cut into small, uniform cubes', 'FaKnifeKitchen'),
  ('Fold', 'Gently combine ingredients without deflating them', 'FaUtensils'),
  ('Whisk', 'Beat vigorously to incorporate air or blend ingredients', 'FaBowlFood'),
  ('Marinate', 'Soak in a seasoned liquid before cooking', 'FaClock'),
  ('Sear', 'Brown the surface quickly over high heat', 'FaFire'),
  ('Deglaze', 'Add liquid to a hot pan to lift browned bits', 'FaDroplet')
ON CONFLICT (name) DO NOTHING;
