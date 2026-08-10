-- ════════════════════════════════════════════════════════════════════════
-- SmartChef — Schema Master PostgreSQL
-- Migration: 001_initial_schema.sql
-- ════════════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- full-text search

-- ── ENUM TYPES ────────────────────────────────────────────────────────────
CREATE TYPE unit_type AS ENUM ('weight', 'volume', 'count', 'custom');
CREATE TYPE difficulty_level AS ENUM ('easy', 'medium', 'hard', 'expert');
CREATE TYPE sync_status AS ENUM ('local', 'synced', 'conflict', 'deleted');

-- ════════════════════════════════════════════════════════════════════════
-- ADMIN HUB — Base Logica
-- ════════════════════════════════════════════════════════════════════════

-- Categorie Ingredienti (Livello 1)
CREATE TABLE ingredient_categories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icon        VARCHAR(50),
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Ingredienti (Livello 2)
CREATE TABLE ingredients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_id     UUID NOT NULL REFERENCES ingredient_categories(id) ON DELETE RESTRICT,
  name            VARCHAR(150) NOT NULL,
  description     TEXT,
  -- Densità: permette conversioni peso<->volume specifiche per ingrediente
  density_g_per_ml NUMERIC(10,4),
  default_unit    VARCHAR(30),
  -- CRDT tracking
  crdt_clock      JSONB DEFAULT '{}',
  owner_id        UUID,
  last_editor_id  UUID,
  sync_status     sync_status DEFAULT 'local',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(category_id, name)
);

-- Sottotipi Ingredienti (Livello 3)
CREATE TABLE ingredient_subtypes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ingredient_id   UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL,
  density_g_per_ml NUMERIC(10,4), -- override rispetto all'ingrediente padre
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Unità di Misura
CREATE TABLE units (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name      VARCHAR(50) NOT NULL UNIQUE,  -- e.g. "grammi"
  symbol    VARCHAR(20) NOT NULL UNIQUE,  -- e.g. "g"
  unit_type unit_type NOT NULL,
  base_unit_symbol VARCHAR(20),           -- e.g. "g" (unità base per conversioni)
  to_base_factor   NUMERIC(20,10),        -- moltiplicatore verso base
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Conversioni Universali (es. 1 tbsp = 15 ml)
CREATE TABLE unit_conversions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_unit_id  UUID NOT NULL REFERENCES units(id),
  to_unit_id    UUID NOT NULL REFERENCES units(id),
  factor        NUMERIC(20,10) NOT NULL,
  ingredient_id UUID REFERENCES ingredients(id), -- NULL = conversione universale
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(from_unit_id, to_unit_id, ingredient_id)
);

-- Strumenti/Attrezzi
CREATE TABLE tools (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  icon        VARCHAR(50),
  category    VARCHAR(50),  -- e.g. "cottura", "preparazione", "conservazione"
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════
-- ENGINE RICETTE — Sistema Matrioska
-- ════════════════════════════════════════════════════════════════════════

-- Ricette
CREATE TABLE recipes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  difficulty      difficulty_level DEFAULT 'medium',
  servings        INT NOT NULL DEFAULT 4,
  prep_time_min   INT,
  cook_time_min   INT,
  rest_time_min   INT,
  tags            TEXT[],
  cover_image_url TEXT,
  source_url      TEXT,        -- URL originale (import da LLM)
  is_component    BOOLEAN DEFAULT false, -- true = solo sub-ricetta
  -- CRDT & Sync
  crdt_clock      JSONB DEFAULT '{}',
  crdt_version    INT DEFAULT 1,
  owner_id        UUID,
  last_editor_id  UUID,
  sync_status     sync_status DEFAULT 'local',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Step della Ricetta
CREATE TABLE recipe_steps (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id    UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number  INT NOT NULL,
  title        VARCHAR(200),
  description  TEXT NOT NULL,
  duration_min INT,
  tool_ids     UUID[],         -- strumenti usati in questo step
  image_url    TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(recipe_id, step_number)
);

-- Ingredienti della Ricetta (CORE della Matrioska)
-- Una riga può puntare a UN ingrediente OPPURE a UNA sotto-ricetta (mai entrambi)
CREATE TABLE recipe_ingredients (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipe_id        UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  sort_order       INT NOT NULL DEFAULT 0,
  -- Ingrediente semplice (XOR con sub_recipe_id)
  ingredient_id    UUID REFERENCES ingredients(id),
  subtype_id       UUID REFERENCES ingredient_subtypes(id),
  -- Sub-ricetta nidificata (XOR con ingredient_id)
  sub_recipe_id    UUID REFERENCES recipes(id),
  -- Quantità (relativa a servings della ricetta padre)
  quantity         NUMERIC(10,4),
  quantity_text    TEXT,        -- quantità "vaga" (es. "quanto basta")
  unit_id          UUID REFERENCES units(id),
  notes            TEXT,
  is_optional      BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now(),
  -- Vincolo: esattamente uno tra ingredient_id e sub_recipe_id
  CONSTRAINT chk_ingredient_xor_recipe
    CHECK (
      (ingredient_id IS NOT NULL AND sub_recipe_id IS NULL) OR
      (ingredient_id IS NULL AND sub_recipe_id IS NOT NULL)
    )
);

-- Strumenti necessari per la ricetta
CREATE TABLE recipe_tools (
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  tool_id   UUID NOT NULL REFERENCES tools(id),
  is_optional BOOLEAN DEFAULT false,
  PRIMARY KEY (recipe_id, tool_id)
);

-- ════════════════════════════════════════════════════════════════════════
-- MODULO SPESA & MENÙ
-- ════════════════════════════════════════════════════════════════════════

-- Menù Settimanale
CREATE TABLE menus (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       VARCHAR(200) NOT NULL,
  week_start DATE NOT NULL,
  notes      TEXT,
  crdt_clock JSONB DEFAULT '{}',
  owner_id   UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ricette nel menù (con giorno e numero porzioni)
CREATE TABLE menu_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  menu_id     UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  recipe_id   UUID NOT NULL REFERENCES recipes(id),
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=lun, 6=dom
  meal_type   VARCHAR(30) DEFAULT 'dinner', -- breakfast, lunch, dinner, snack
  servings    INT NOT NULL DEFAULT 4,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Lista della Spesa
CREATE TABLE shopping_lists (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  menu_id    UUID REFERENCES menus(id),
  name       VARCHAR(200) NOT NULL,
  crdt_clock JSONB DEFAULT '{}',
  owner_id   UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Voci della Lista Spesa (aggregata)
CREATE TABLE shopping_list_items (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shopping_list_id    UUID NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  ingredient_id       UUID REFERENCES ingredients(id),
  total_quantity      NUMERIC(12,4),
  quantity_text       TEXT,
  unit_id             UUID REFERENCES units(id),
  is_checked          BOOLEAN DEFAULT false,
  -- Dettaglio provenienza (per tree-view "esplosa")
  source_details      JSONB DEFAULT '[]',
  -- es: [{"recipe":"Cena di Gala","servings":10,"qty":200,"unit":"g"}, ...]
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════
-- INDICI per performance
-- ════════════════════════════════════════════════════════════════════════

CREATE INDEX idx_ingredients_category ON ingredients(category_id);
CREATE INDEX idx_ingredients_name_trgm ON ingredients USING gin(name gin_trgm_ops);
CREATE INDEX idx_recipes_tags ON recipes USING gin(tags);
CREATE INDEX idx_recipes_title_trgm ON recipes USING gin(title gin_trgm_ops);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX idx_recipe_ingredients_sub_recipe ON recipe_ingredients(sub_recipe_id) WHERE sub_recipe_id IS NOT NULL;
CREATE INDEX idx_menu_items_menu ON menu_items(menu_id);
CREATE INDEX idx_shopping_items_list ON shopping_list_items(shopping_list_id);

-- ════════════════════════════════════════════════════════════════════════
-- TRIGGER: updated_at automatico
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ingredients_updated_at
  BEFORE UPDATE ON ingredients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_recipes_updated_at
  BEFORE UPDATE ON recipes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_menus_updated_at
  BEFORE UPDATE ON menus FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════════════════════════════════
-- SEED DATA — Unità di misura base
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO units (name, symbol, unit_type, base_unit_symbol, to_base_factor) VALUES
  ('grammi',      'g',    'weight', 'g',  1),
  ('kilogrammi',  'kg',   'weight', 'g',  1000),
  ('ounce',       'oz',   'weight', 'g',  28.3495),
  ('millilitri',  'ml',   'volume', 'ml', 1),
  ('litri',       'l',    'volume', 'ml', 1000),
  ('cucchiaio',   'tbsp', 'volume', 'ml', 15),
  ('cucchiaino',  'tsp',  'volume', 'ml', 5),
  ('tazza',       'cup',  'volume', 'ml', 240),
  ('fl oz',       'fl oz','volume', 'ml', 29.5735),
  ('pezzo',       'pz',   'count',  NULL, NULL),
  ('spicchio',    'spicchio', 'count', NULL, NULL),
  ('foglia',      'foglia',   'count', NULL, NULL),
  ('quanto basta','q.b.',     'custom', NULL, NULL);

INSERT INTO unit_conversions (from_unit_id, to_unit_id, factor)
SELECT f.id, t.id, f.to_base_factor / t.to_base_factor
FROM units f, units t
WHERE f.unit_type = t.unit_type
  AND f.to_base_factor IS NOT NULL
  AND t.to_base_factor IS NOT NULL
  AND f.id != t.id;

-- Categorie ingredienti base
-- (icon = nome componente react-icons/fa6, non emoji — coerente con il
--  renderer RenderFaIcon usato da ingredienti/strumenti/categorie)
INSERT INTO ingredient_categories (name, icon) VALUES
  ('Verdure & Ortaggi', 'FaCarrot'),
  ('Frutta', 'FaAppleWhole'),
  ('Carni', 'FaDrumstickBite'),
  ('Pesce & Frutti di Mare', 'FaFish'),
  ('Latticini & Uova', 'FaCheese'),
  ('Cereali & Farine', 'FaBreadSlice'),
  ('Legumi', 'FaBowlRice'),
  ('Condimenti & Spezie', 'FaPepperHot'),
  ('Olii & Grassi', 'FaDroplet'),
  ('Dolcificanti', 'FaCookie'),
  ('Bevande & Alcolici', 'FaWineGlass'),
  ('Altro', 'FaTag');
