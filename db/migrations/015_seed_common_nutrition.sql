-- 015_seed_common_nutrition.sql
-- Seeds per-100g nutrition facts for ~20 very common, well-established
-- staples (USDA-reference figures) so the new nutrition feature has some
-- real data to demonstrate with out of the box. Matches by name (English
-- seed library + Italian import names, including the messier fused names
-- some auto-imported recipes produced, e.g. "SALE q.b") using whole-word
-- regex matching (\m..\M) rather than plain substring ILIKE, since plain
-- substrings produce real false positives here — e.g. "%egg%" matches
-- "reggiano" (parmesan), and only fills in ingredients that don't already
-- have a value set — never overwrites anything a user has already entered.
-- Deliberately NOT attempting to cover the full ~250-ingredient library:
-- there's no reliable data source here for the more obscure items, and
-- guessing precise figures for those would be actively misleading. Same
-- reasoning excludes derivative products that share a base word but are
-- nutritionally a different food entirely (rice vinegar/starch, potato
-- starch) — those are explicitly excluded below rather than guessed.

CREATE OR REPLACE FUNCTION _seed_nutrition(
  word_pattern TEXT, exclude_pattern TEXT,
  kcal NUMERIC, protein NUMERIC, carbs NUMERIC,
  fat NUMERIC, fiber NUMERIC, sugar NUMERIC, sodium NUMERIC
) RETURNS VOID AS $$
BEGIN
  UPDATE ingredients
  SET calories_kcal = kcal, protein_g = protein, carbs_g = carbs,
      fat_g = fat, fiber_g = fiber, sugar_g = sugar, sodium_mg = sodium
  WHERE name ~* word_pattern
    AND calories_kcal IS NULL
    AND (exclude_pattern IS NULL OR name !~* exclude_pattern);
END;
$$ LANGUAGE plpgsql;

SELECT _seed_nutrition('\msalt\M',            NULL,            0,   0,    0,    0,    0,    0,    38758);
SELECT _seed_nutrition('\msale\M',             NULL,            0,   0,    0,    0,    0,    0,    38758);
SELECT _seed_nutrition('\msugar\M',           NULL,            387,  0,    99.8, 0,    0,    99.8, 0);
SELECT _seed_nutrition('\mzucchero\M',        NULL,            387,  0,    99.8, 0,    0,    99.8, 0);
SELECT _seed_nutrition('\mflour\M',           NULL,            364,  10.3, 76.3, 1,    2.7,  0.3,  2);
SELECT _seed_nutrition('\mfarina\M',          NULL,            364,  10.3, 76.3, 1,    2.7,  0.3,  2);
SELECT _seed_nutrition('olive oil',           NULL,            884,  0,    0,    100,  0,    0,    2);
SELECT _seed_nutrition('olio.*oliva',         NULL,            884,  0,    0,    100,  0,    0,    2);
SELECT _seed_nutrition('\mbutter\M',          NULL,            717,  0.9,  0.1,  81.1, 0,    0.1,  11);
SELECT _seed_nutrition('\mburro\M',           NULL,            717,  0.9,  0.1,  81.1, 0,    0.1,  11);
SELECT _seed_nutrition('\megg\M',             NULL,            143,  12.6, 0.7,  9.5,  0,    0.4,  142);
SELECT _seed_nutrition('\muov',               NULL,            143,  12.6, 0.7,  9.5,  0,    0.4,  142);
SELECT _seed_nutrition('\mmilk\M',             NULL,           61,  3.2,  4.8,  3.3,  0,    5.1,  43);
SELECT _seed_nutrition('\mlatte\M',            NULL,           61,  3.2,  4.8,  3.3,  0,    5.1,  43);
SELECT _seed_nutrition('\mrice\M',            NULL,            365,  7.1,  80,   0.7,  1.3,  0.1,  1);
SELECT _seed_nutrition('\mriso\M',            'amido|aceto',   365,  7.1,  80,   0.7,  1.3,  0.1,  1);
SELECT _seed_nutrition('\mhoney\M',           NULL,            304,  0.3,  82.4, 0,    0.2,  82.1, 4);
SELECT _seed_nutrition('\mmiele\M',           NULL,            304,  0.3,  82.4, 0,    0.2,  82.1, 4);
SELECT _seed_nutrition('\mgarlic\M',          NULL,            149,  6.4,  33.1, 0.5,  2.1,  1,    17);
SELECT _seed_nutrition('\maglio\M',           NULL,            149,  6.4,  33.1, 0.5,  2.1,  1,    17);
SELECT _seed_nutrition('\monion\M',            NULL,           40,  1.1,  9.3,  0.1,  1.7,  4.2,  4);
SELECT _seed_nutrition('\mcipoll',             NULL,           40,  1.1,  9.3,  0.1,  1.7,  4.2,  4);
SELECT _seed_nutrition('\mtomato\M',           NULL,           18,  0.9,  3.9,  0.2,  1.2,  2.6,  5);
SELECT _seed_nutrition('\mpomodor',            NULL,           18,  0.9,  3.9,  0.2,  1.2,  2.6,  5);
SELECT _seed_nutrition('black pepper',        NULL,            251,  10.4, 63.9, 3.3,  25.3, 0.6,  20);
SELECT _seed_nutrition('peppercorn',          NULL,            251,  10.4, 63.9, 3.3,  25.3, 0.6,  20);
SELECT _seed_nutrition('pepe.*nero',          NULL,            251,  10.4, 63.9, 3.3,  25.3, 0.6,  20);
SELECT _seed_nutrition('parmigian',           NULL,            431,  38,   4.1,  29,   0,    0.9,  1529);
SELECT _seed_nutrition('parmesan',            NULL,            431,  38,   4.1,  29,   0,    0.9,  1529);
SELECT _seed_nutrition('chicken breast',      NULL,            165,  31,   0,    3.6,  0,    0,    74);
SELECT _seed_nutrition('petto di pollo',      NULL,            165,  31,   0,    3.6,  0,    0,    74);
SELECT _seed_nutrition('\mcarrot',             NULL,           41,  0.9,  9.6,  0.2,  2.8,  4.7,  69);
SELECT _seed_nutrition('\mcarot',              NULL,           41,  0.9,  9.6,  0.2,  2.8,  4.7,  69);
SELECT _seed_nutrition('\mpotato',             NULL,           77,  2,    17,   0.1,  2.2,  0.8,  6);
SELECT _seed_nutrition('\mpatat',              'fecola',       77,  2,    17,   0.1,  2.2,  0.8,  6);
SELECT _seed_nutrition('\mlemon\M',           NULL,            29,  1.1,  9.3,  0.3,  2.8,  2.5,  2);
SELECT _seed_nutrition('\mlimone\M',          NULL,            29,  1.1,  9.3,  0.3,  2.8,  2.5,  2);
SELECT _seed_nutrition('chickpea',            NULL,            164,  8.9,  27.4, 2.6,  7.6,  4.8,  7);
SELECT _seed_nutrition('\mcec',                NULL,           164,  8.9,  27.4, 2.6,  7.6,  4.8,  7);
SELECT _seed_nutrition('heavy cream',         NULL,            340,  2.1,  2.8,  36,   0,    2.9,  27);
SELECT _seed_nutrition('\mpanna\M',           NULL,            340,  2.1,  2.8,  36,   0,    2.9,  27);

DROP FUNCTION _seed_nutrition(TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC);
