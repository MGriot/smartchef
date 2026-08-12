// ════════════════════════════════════════════════════════════════════════
// One-off maintenance script: backfills missing Italian translations for
// ingredients that predate the language-detection fix in
// ingredient.matcher.ts (see matchLLMResultToDB) — those ingredients were
// auto-created during LLM import with no translation captured at all, so
// they stay stuck in their English base name even when viewing a recipe
// in Italian. Run once via:
//   podman exec smartchef_backend node dist/src/scripts/backfill-ingredient-translations.js
// Safe to re-run — only targets ingredients still missing an 'it' row.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import { translateIngredientNames } from "../services/llm.parser";

const CHUNK_SIZE = 12;

async function main() {
  const missing = await query<{ id: string; name: string }>(
    `SELECT i.id, i.name FROM ingredients i
     WHERE i.sync_status != 'deleted'
       AND NOT EXISTS (SELECT 1 FROM ingredient_translations it WHERE it.ingredient_id = i.id AND it.language_code = 'it')
     ORDER BY i.name`
  );

  if (missing.length === 0) {
    console.log("Nothing to backfill — every ingredient already has an Italian translation.");
    return;
  }

  console.log(`Backfilling Italian translations for ${missing.length} ingredients...`);

  let translated = 0;
  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const chunk = missing.slice(i, i + CHUNK_SIZE);
    const names = chunk.map((c) => c.name);
    console.log(`  chunk ${i / CHUNK_SIZE + 1}: translating ${names.length} names...`);

    let result: Record<string, string> = {};
    try {
      result = await translateIngredientNames(names, "en", "it");
    } catch (err) {
      console.warn(`  chunk failed, skipping:`, (err as Error).message);
      continue;
    }

    for (const ing of chunk) {
      const it = result[ing.name];
      if (!it) {
        console.warn(`  no translation returned for "${ing.name}"`);
        continue;
      }
      await query(
        `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name)
         VALUES ($1, 'it', $2)
         ON CONFLICT (ingredient_id, language_code) DO UPDATE SET translated_name = excluded.translated_name`,
        [ing.id, it]
      );
      translated++;
    }
  }

  console.log(`Done — ${translated}/${missing.length} translated.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
