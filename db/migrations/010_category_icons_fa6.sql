-- 010_category_icons_fa6.sql
-- ingredient_categories.icon was seeded with raw emoji (migration 001), but
-- the frontend's icon picker/renderer (RenderFaIcon) resolves react-icons/fa6
-- component names, not emoji — so every category icon has always silently
-- fallen back to the generic tag icon. Switch to real FA6 names, matching
-- the same icon system already used for ingredients and tools.

UPDATE ingredient_categories SET icon = 'FaCarrot'        WHERE name = 'Verdure & Ortaggi';
UPDATE ingredient_categories SET icon = 'FaAppleWhole'     WHERE name = 'Frutta';
UPDATE ingredient_categories SET icon = 'FaDrumstickBite'  WHERE name = 'Carni';
UPDATE ingredient_categories SET icon = 'FaFish'           WHERE name = 'Pesce & Frutti di Mare';
UPDATE ingredient_categories SET icon = 'FaCheese'         WHERE name = 'Latticini & Uova';
UPDATE ingredient_categories SET icon = 'FaBreadSlice'     WHERE name = 'Cereali & Farine';
UPDATE ingredient_categories SET icon = 'FaBowlRice'       WHERE name = 'Legumi';
UPDATE ingredient_categories SET icon = 'FaPepperHot'      WHERE name = 'Condimenti & Spezie';
UPDATE ingredient_categories SET icon = 'FaDroplet'        WHERE name = 'Olii & Grassi';
UPDATE ingredient_categories SET icon = 'FaCookie'         WHERE name = 'Dolcificanti';
UPDATE ingredient_categories SET icon = 'FaWineGlass'      WHERE name = 'Bevande & Alcolici';
UPDATE ingredient_categories SET icon = 'FaTag'            WHERE name = 'Altro';
