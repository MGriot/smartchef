-- 008_common_ingredients.sql
-- Seeds a broad set of common cooking ingredients across every category,
-- mirroring the depth already given to the tools library (migration 003).
-- Uses name-based category lookups (not hardcoded UUIDs) so this works on
-- both fresh installs and already-running databases.

INSERT INTO ingredients (category_id, name, icon) VALUES
  -- Verdure & Ortaggi
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Carrot', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Celery Stalk', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Red Bell Pepper', 'FaPepperHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Zucchini', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Potato', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Spinach', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Broccoli', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Button Mushroom', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Red Onion', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Cucumber', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Fresh Parsley', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Verdure & Ortaggi'), 'Fresh Rosemary', 'FaLeaf'),

  -- Frutta
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Lemon', 'FaLemon'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Lime', 'FaLemon'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Orange', 'FaLemon'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Apple', 'FaAppleWhole'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Banana', 'FaAppleWhole'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Strawberry', 'FaAppleWhole'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Blueberry', 'FaAppleWhole'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Frutta'), 'Avocado', 'FaAppleWhole'),

  -- Carni
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Chicken Breast', 'FaDrumstickBite'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Ground Beef', 'FaDrumstickBite'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Pancetta', 'FaBacon'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Pork Loin', 'FaDrumstickBite'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Beef Sirloin', 'FaDrumstickBite'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Chicken Thigh', 'FaDrumstickBite'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Prosciutto', 'FaBacon'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Carni'), 'Bacon', 'FaBacon'),

  -- Pesce & Frutti di Mare
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Salmon Fillet', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Shrimp', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Tuna Steak', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Anchovy Fillets', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Mussels', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Cod Fillet', 'FaFish'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Pesce & Frutti di Mare'), 'Clams', 'FaFish'),

  -- Latticini & Uova
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Whole Milk', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Unsalted Butter', 'FaCheese'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Heavy Cream', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Mozzarella', 'FaCheese'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Ricotta', 'FaCheese'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Greek Yogurt', 'FaCheese'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Pecorino Romano', 'FaCheese'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Latticini & Uova'), 'Mascarpone', 'FaCheese'),

  -- Cereali & Farine
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'White Rice', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Arborio Rice', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Breadcrumbs', 'FaBreadSlice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Whole Wheat Flour', 'FaBreadSlice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Cornmeal (Polenta)', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Penne Rigate', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Panko Breadcrumbs', 'FaBreadSlice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Cereali & Farine'), 'Rolled Oats', 'FaBowlRice'),

  -- Legumi
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Cannellini Beans', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Chickpeas', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Black Beans', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Brown Lentils', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Green Peas', 'FaBowlRice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Legumi'), 'Kidney Beans', 'FaBowlRice'),

  -- Condimenti & Spezie
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Dried Oregano', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Ground Cinnamon', 'FaPepperHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Paprika', 'FaPepperHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Red Pepper Flakes', 'FaPepperHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Bay Leaves', 'FaLeaf'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Dijon Mustard', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Soy Sauce', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Balsamic Vinegar', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Fresh Ginger', 'FaCarrot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Condimenti & Spezie'), 'Ground Cumin', 'FaPepperHot'),

  -- Olii & Grassi
  ((SELECT id FROM ingredient_categories WHERE name = 'Olii & Grassi'), 'Vegetable Oil', 'FaDroplet'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Olii & Grassi'), 'Sesame Oil', 'FaDroplet'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Olii & Grassi'), 'Coconut Oil', 'FaDroplet'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Olii & Grassi'), 'Ghee', 'FaDroplet'),

  -- Dolcificanti
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Granulated Sugar', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Brown Sugar', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Honey', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Maple Syrup', 'FaBottleWater'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Powdered Sugar', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Dolcificanti'), 'Vanilla Extract', 'FaBottleWater'),

  -- Bevande & Alcolici
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Dry White Wine', 'FaWineGlass'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Red Wine', 'FaWineGlass'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Chicken Stock', 'FaMugHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Vegetable Stock', 'FaMugHot'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Lager Beer', 'FaWineGlass'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Bevande & Alcolici'), 'Espresso Coffee', 'FaMugHot'),

  -- Altro
  ((SELECT id FROM ingredient_categories WHERE name = 'Altro'), 'Active Dry Yeast', 'FaBreadSlice'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Altro'), 'Baking Powder', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Altro'), 'Baking Soda', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Altro'), 'Cornstarch', 'FaCookie'),
  ((SELECT id FROM ingredient_categories WHERE name = 'Altro'), 'Gelatin Sheets', 'FaCookie')
ON CONFLICT (category_id, name) DO NOTHING;
