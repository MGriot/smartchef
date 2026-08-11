-- 019_category_colors.sql
-- Assigns a color to each ingredient category so category/ingredient icons
-- can be rendered meaningfully (Meat reddish, Fish blue, Vegetables green,
-- etc.) instead of flat gray, mirroring the color system already built for
-- the tag catalog (migrations 016/017).

ALTER TABLE ingredient_categories ADD COLUMN IF NOT EXISTS color VARCHAR(20);

UPDATE ingredient_categories SET color = v.color FROM (VALUES
  ('Verdure & Ortaggi',       '#16a34a'),
  ('Frutta',                  '#f97316'),
  ('Carni',                   '#dc2626'),
  ('Pesce & Frutti di Mare',  '#0284c7'),
  ('Latticini & Uova',        '#d97706'),
  ('Cereali & Farine',        '#92400e'),
  ('Legumi',                  '#65a30d'),
  ('Condimenti & Spezie',     '#7c3aed'),
  ('Olii & Grassi',           '#ca8a04'),
  ('Dolcificanti',            '#db2777'),
  ('Bevande & Alcolici',      '#4f46e5'),
  ('Altro',                   '#71717a')
) AS v(name, color)
WHERE ingredient_categories.name = v.name;
