-- Finalize professional culinary schema and library
-- 003_culinary_library_sync.sql

-- 1. Ensure notes column exists in recipe_steps
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='recipe_steps' AND column_name='notes') THEN
    ALTER TABLE recipe_steps ADD COLUMN notes TEXT;
  END IF;
END $$;

-- 2. Expand Professional Tool Library
INSERT INTO tools (name, icon, description, category) VALUES
  ('Mortar & Pestle', 'pestle', 'For artisanal spice grinding', 'prep'),
  ('Immersion Blender', 'blender', 'For smooth emulsified sauces', 'appliance'),
  ('Chef''s Knife', 'knife', 'Precision cutting instrument', 'prep'),
  ('Balloon Whisk', 'whisk', 'For maximum aeration', 'prep'),
  ('Rolling Pin', 'rolling_pin', 'For perfect pasta sheets', 'prep'),
  ('Cast Iron Skillet', 'skillet', 'Superior heat retention', 'cooking'),
  ('Dutch Oven', 'oven_gen', 'Perfect for slow braising', 'cooking')
ON CONFLICT DO NOTHING;

-- 3. Seed Essential Ingredient Atelier
-- Look up category IDs by name instead of hardcoding UUIDs from a different
-- database instance (ingredient_categories.id is generated per-deployment by
-- uuid_generate_v4(), so a fixed UUID here would not match a fresh install
-- and previously caused this whole migration file to abort with a FK
-- violation, silently skipping every migration after it).
INSERT INTO ingredients (name, category_id)
SELECT v.name, ic.id
FROM (VALUES
  ('Extra Virgin Olive Oil', 'Olii & Grassi'),
  ('Kosher Salt', 'Condimenti & Spezie'),
  ('Black Peppercorns', 'Condimenti & Spezie'),
  ('San Marzano Tomatoes', 'Verdure & Ortaggi'),
  ('Yellow Onion', 'Verdure & Ortaggi'),
  ('Garlic Clove', 'Verdure & Ortaggi'),
  ('Fresh Basil', 'Verdure & Ortaggi'),
  ('Parmigiano Reggiano', 'Latticini & Uova'),
  ('Large Egg', 'Latticini & Uova'),
  ('All-Purpose Flour', 'Cereali & Farine'),
  ('Spaghetti No.5', 'Cereali & Farine'),
  ('Guanciale', 'Carni')
) AS v(name, category_name)
JOIN ingredient_categories ic ON ic.name = v.category_name
ON CONFLICT DO NOTHING;
