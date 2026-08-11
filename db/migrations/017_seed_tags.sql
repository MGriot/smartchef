-- 017_seed_tags.sql
-- Starter tag catalog (mirrors the modest, non-exhaustive spirit of the
-- nutrition seed in 015_seed_common_nutrition.sql): a handful of diet,
-- allergen/composition, and course tags, plus ingredient_tags associations
-- bulk-assigned from the already-cleaned 201-item ingredient library so
-- auto-tagging has real data to demonstrate immediately. Not an attempt at
-- exhaustive allergen coverage — a starting point the user refines via the
-- Library > Tags UI and the ingredient editor.

INSERT INTO tags (name, group_name, color, icon, sort_order) VALUES
  ('Vegetariano',     'Dieta',    '#16a34a', 'FaLeaf',           1),
  ('Vegano',          'Dieta',    '#15803d', 'FaSeedling',       2),
  ('Carne',           'Contiene', '#b91c1c', 'FaDrumstickBite',  10),
  ('Pesce',           'Contiene', '#0284c7', 'FaFish',           11),
  ('Crostacei',       'Contiene', '#ea580c', 'FaShrimp',         12),
  ('Uova',            'Contiene', '#ca8a04', 'FaEgg',            13),
  ('Lattosio',        'Contiene', '#7c3aed', 'FaCheese',         14),
  ('Glutine',         'Contiene', '#92400e', 'FaWheatAwn',       15),
  ('Soia',            'Contiene', '#059669', 'FaSeedling',       16),
  ('Frutta a guscio', 'Contiene', '#a16207', 'FaTree',           17),
  ('Antipasto',       'Portata',  '#64748b', 'FaUtensils',       20),
  ('Primo',           'Portata',  '#64748b', 'FaBowlFood',       21),
  ('Secondo',         'Portata',  '#64748b', 'FaDrumstickBite',  22),
  ('Contorno',        'Portata',  '#64748b', 'FaCarrot',         23),
  ('Dolce',           'Portata',  '#db2777', 'FaIceCream',       24),
  ('Bevanda',         'Portata',  '#0891b2', 'FaMugHot',         25)
ON CONFLICT (name) DO NOTHING;

INSERT INTO tag_translations (tag_id, language_code, name)
SELECT id, 'en', v.name_en FROM tags, (VALUES
  ('Vegetariano',     'Vegetarian'),
  ('Vegano',          'Vegan'),
  ('Carne',           'Meat'),
  ('Pesce',           'Fish'),
  ('Crostacei',       'Shellfish'),
  ('Uova',            'Eggs'),
  ('Lattosio',        'Dairy'),
  ('Glutine',         'Gluten'),
  ('Soia',            'Soy'),
  ('Frutta a guscio', 'Tree Nuts'),
  ('Antipasto',       'Starter'),
  ('Primo',           'First Course'),
  ('Secondo',         'Main Course'),
  ('Contorno',        'Side Dish'),
  ('Dolce',           'Dessert'),
  ('Bevanda',         'Beverage')
) AS v(name_it, name_en)
WHERE tags.name = v.name_it
ON CONFLICT (tag_id, language_code) DO NOTHING;

-- Diet tags auto-apply unless the recipe contains an ingredient carrying
-- one of these excluded tags.
UPDATE tags SET exclude_tag_ids = (
  SELECT array_agg(id) FROM tags WHERE name IN ('Carne', 'Pesce', 'Crostacei')
) WHERE name = 'Vegetariano';

UPDATE tags SET exclude_tag_ids = (
  SELECT array_agg(id) FROM tags WHERE name IN ('Carne', 'Pesce', 'Crostacei', 'Uova', 'Lattosio')
) WHERE name = 'Vegano';

-- Bulk-assign ingredient_tags: whole-category heuristics for the clear
-- cases, explicit name lists / patterns for the rest.
INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN ingredient_categories ic ON ic.id = i.category_id
JOIN tags t ON t.name = 'Carne'
WHERE ic.name = 'Carni'
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN ingredient_categories ic ON ic.id = i.category_id
JOIN tags t ON t.name = 'Pesce'
WHERE ic.name = 'Pesce & Frutti di Mare'
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN tags t ON t.name = 'Crostacei'
WHERE i.name IN ('Shrimp', 'Clams', 'Mussels')
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN tags t ON t.name = 'Uova'
WHERE i.name IN ('Large Egg', 'Egg Tagliatelle Pasta')
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN ingredient_categories ic ON ic.id = i.category_id
JOIN tags t ON t.name = 'Lattosio'
WHERE ic.name = 'Latticini & Uova' AND i.name != 'Large Egg'
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN tags t ON t.name = 'Glutine'
WHERE i.name IN (
  'All-Purpose Flour', 'Biscotti Digestive', 'Bread (sliced)', 'Breadcrumbs',
  'Egg Tagliatelle Pasta', 'Manitoba Flour', 'Panko Breadcrumbs',
  'Pappardelle Pasta', 'Penne Rigate', 'Spaghetti No.5', 'Sponge Cake',
  'Whole Wheat Flour'
)
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN tags t ON t.name = 'Soia'
WHERE i.name ~* '\msoy\M|\mtofu\M'
ON CONFLICT DO NOTHING;

INSERT INTO ingredient_tags (ingredient_id, tag_id)
SELECT i.id, t.id FROM ingredients i
JOIN tags t ON t.name = 'Frutta a guscio'
WHERE i.name ~* 'almond|walnut|hazelnut|peanut|pistachio|pine nut|cashew|chestnut'
ON CONFLICT DO NOTHING;
