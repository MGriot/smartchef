-- 040_pantry.sql
-- What is actually in the house.
--
-- Per-user like the shopping list and the planner: two people sharing a
-- server keep separate cupboards, and merging them would produce a "you can
-- cook this" that is wrong for both.
--
-- quantity and unit are both nullable on purpose. "I have flour" is the
-- common case and is worth recording on its own; being forced to weigh the
-- bag before the app will accept it is exactly the friction that stops
-- anyone keeping a pantry up to date. A row with no quantity counts as
-- "enough" when matching a recipe.

CREATE TABLE IF NOT EXISTS pantry_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id      UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity      NUMERIC,
  unit_id       UUID REFERENCES units(id) ON DELETE SET NULL,
  -- Optional: lets the list surface what needs using up first.
  expires_at    DATE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per ingredient per person: topping up the flour edits the row
  -- rather than adding a second "flour" the matcher would have to sum.
  UNIQUE (owner_id, ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_pantry_items_owner ON pantry_items(owner_id);
