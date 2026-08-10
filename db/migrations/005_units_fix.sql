-- 005_units_fix.sql
-- Adds the "system" column (metric/imperial/custom) the admin UI already exposes.
-- The rest of the units admin form/route is fixed to use the existing symbol /
-- unit_type / to_base_factor columns instead of inventing parallel ones.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='units' AND column_name='system') THEN
    ALTER TABLE units ADD COLUMN system VARCHAR(20) DEFAULT 'metric';
  END IF;
END $$;

-- The admin UI's unit-type dropdown also offers "length" and "temperature"
-- (oven temp, pan diameter, etc.) which aren't in the original enum.
ALTER TYPE unit_type ADD VALUE IF NOT EXISTS 'length';
ALTER TYPE unit_type ADD VALUE IF NOT EXISTS 'temperature';
