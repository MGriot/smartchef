-- 004_ingredient_enhancements.sql

-- 1. Add icon column to ingredients (fixes save error)
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ingredients' AND column_name='icon') THEN
    ALTER TABLE ingredients ADD COLUMN icon VARCHAR(50);
  END IF;
END $$;

-- 2. Create translations table for ingredients
CREATE TABLE IF NOT EXISTS ingredient_translations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  language_code VARCHAR(10) NOT NULL, -- e.g., 'it', 'fr', 'es'
  translated_name VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ingredient_id, language_code)
);
