// ════════════════════════════════════════════════════════════════════════
// One-off maintenance script: backfills ingredient name translations for
// every language in SUPPORTED_LANGUAGES (except 'en', the base language)
// that a given ingredient is still missing. Generalizes the older
// backfill-ingredient-translations.ts (which only ever targeted 'it') now
// that the app supports fr/es too. Local small-model translation, not
// human-reviewed — spot-check the output the same way past backfills were
// checked. Run once via:
//   npx tsx src/scripts/backfill-ingredient-translations-multilang.ts
// Safe to re-run — only targets ingredients still missing a given language.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import { translateIngredientNames } from "../services/llm.parser";

const TARGET_LANGS = ["it", "fr", "es"];
const CHUNK_SIZE = 12;

async function main() {
  for (const lang of TARGET_LANGS) {
    const missing = await query<{ id: string; name: string }>(
      `SELECT i.id, i.name FROM ingredients i
       WHERE i.sync_status != 'deleted'
         AND NOT EXISTS (SELECT 1 FROM ingredient_translations it WHERE it.ingredient_id = i.id AND it.language_code = $1)
       ORDER BY i.name`,
      [lang]
    );

    if (missing.length === 0) {
      console.log(`[${lang}] nothing to backfill — every ingredient already has a translation.`);
      continue;
    }

    console.log(`[${lang}] backfilling ${missing.length} ingredients...`);

    let translated = 0;
    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE);
      const names = chunk.map((c) => c.name);
      console.log(`  [${lang}] chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(missing.length / CHUNK_SIZE)}: translating ${names.length} names...`);

      let result: Record<string, string> = {};
      try {
        result = await translateIngredientNames(names, "en", lang);
      } catch (err) {
        console.warn(`  [${lang}] chunk failed, skipping:`, (err as Error).message);
        continue;
      }

      for (const ing of chunk) {
        const t = result[ing.name];
        if (!t) {
          console.warn(`  [${lang}] no translation returned for "${ing.name}"`);
          continue;
        }
        await query(
          `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (ingredient_id, language_code) DO UPDATE SET translated_name = excluded.translated_name`,
          [ing.id, lang, t]
        );
        translated++;
      }
    }

    console.log(`[${lang}] done — ${translated}/${missing.length} translated.`);
  }

  console.log("All languages processed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
