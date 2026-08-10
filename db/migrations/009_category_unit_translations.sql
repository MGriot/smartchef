-- 009_category_unit_translations.sql
-- Seeds English translations for ingredient categories and units, whose
-- base names were seeded in Italian (migration 001). Without these rows,
-- switching the UI to English had nothing to fall back to for these two
-- reference tables even though the read-side ?lang= plumbing already existed.

INSERT INTO ingredient_category_translations (category_id, language_code, name)
SELECT id, 'en', v.name_en FROM ingredient_categories, (VALUES
  ('Verdure & Ortaggi',       'Vegetables'),
  ('Frutta',                  'Fruit'),
  ('Carni',                   'Meat'),
  ('Pesce & Frutti di Mare',  'Fish & Seafood'),
  ('Latticini & Uova',        'Dairy & Eggs'),
  ('Cereali & Farine',        'Grains & Flours'),
  ('Legumi',                  'Legumes'),
  ('Condimenti & Spezie',     'Condiments & Spices'),
  ('Olii & Grassi',           'Oils & Fats'),
  ('Dolcificanti',            'Sweeteners'),
  ('Bevande & Alcolici',      'Beverages & Alcohol'),
  ('Altro',                   'Other')
) AS v(name_it, name_en)
WHERE ingredient_categories.name = v.name_it
ON CONFLICT (category_id, language_code) DO NOTHING;

INSERT INTO unit_translations (unit_id, language_code, name)
SELECT id, 'en', v.name_en FROM units, (VALUES
  ('grammi',       'grams'),
  ('kilogrammi',   'kilograms'),
  ('ounce',        'ounce'),
  ('millilitri',   'milliliters'),
  ('litri',        'liters'),
  ('cucchiaio',    'tablespoon'),
  ('cucchiaino',   'teaspoon'),
  ('tazza',        'cup'),
  ('fl oz',        'fluid ounce'),
  ('pezzo',        'piece'),
  ('spicchio',     'clove'),
  ('foglia',       'leaf'),
  ('quanto basta', 'to taste')
) AS v(name_it, name_en)
WHERE units.name = v.name_it
ON CONFLICT (unit_id, language_code) DO NOTHING;
