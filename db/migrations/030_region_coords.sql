-- 030_region_coords.sql
-- Coordinates for free-text regions (city/region/state names that aren't
-- one of the ~195 country codes in frontend/src/lib/countries.ts), resolved
-- via the new /api/geocode proxy to OpenStreetMap's Nominatim. Keyed by the
-- lowercased region label, e.g. {"pinerolo": {"lat":44.89,"lng":7.33}}.
-- Purely additive — the existing `regions` TEXT[] column and its Gallery
-- filter query are untouched.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS region_coords JSONB NOT NULL DEFAULT '{}'::jsonb;
