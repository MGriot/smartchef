-- 034_ingredient_seasonality.sql
-- When an ingredient is in season (Northern hemisphere, matching this app's
-- existing Italian-first content) — a set of month numbers (1=January .. 12=
-- December), e.g. {6,7,8,9} for peak summer produce. NULL/empty means "no
-- seasonality data" (year-round pantry staples like flour or salt, or simply
-- not curated yet) — deliberately distinct from "in season all 12 months",
-- since the gallery's seasonality filter (see recipes.local.ts/recipes.ts)
-- only counts ingredients that actually HAVE seasonality data against a
-- recipe; an ingredient with no data never excludes a recipe from the filter.

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS seasonal_months INTEGER[];
