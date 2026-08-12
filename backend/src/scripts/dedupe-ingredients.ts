// ════════════════════════════════════════════════════════════════════════
// One-off maintenance script: finds and merges duplicate ingredients that
// predate the language-detection fix in ingredient.matcher.ts — before
// that fix, an ingredient auto-created from an Italian recipe kept its
// Italian name as the base `name` (e.g. "aglio"), sitting alongside the
// pre-seeded canonical English-based entry with the same meaning
// ("Garlic", translated_name "Aglio").
//
// Detection: an ingredient is a "duplicate" candidate if its own Italian
// translation (added by the backfill script) is identical to its own base
// name — i.e. the translator just echoed it back, because it was already
// Italian. For each candidate, the canonical match is the OTHER ingredient
// whose Italian translation equals the candidate's name. Only unambiguous
// 1:1 matches are merged; anything else is reported and left alone.
//
// Run with DRY_RUN=1 first to review the plan before it writes anything:
//   DRY_RUN=1 node dist/src/scripts/dedupe-ingredients.js
//   node dist/src/scripts/dedupe-ingredients.js
// ════════════════════════════════════════════════════════════════════════

import { query, withTransaction } from "../db/pool";

const DRY_RUN = process.env.DRY_RUN === "1";

function normalize(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Row { id: string; name: string; it: string | null }

async function main() {
  const rows = await query<Row>(
    `SELECT i.id, i.name, it.translated_name AS it
     FROM ingredients i
     LEFT JOIN ingredient_translations it ON it.ingredient_id = i.id AND it.language_code = 'it'
     WHERE i.sync_status != 'deleted'`
  );

  const byNormalizedIt = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.it) continue;
    const key = normalize(r.it);
    if (!byNormalizedIt.has(key)) byNormalizedIt.set(key, []);
    byNormalizedIt.get(key)!.push(r);
  }

  const pairs: Array<{ duplicate: Row; canonical: Row }> = [];
  const unmatched: Row[] = [];

  for (const r of rows) {
    if (!r.it) continue;
    const isSuspect = normalize(r.it) === normalize(r.name);
    if (!isSuspect) continue;

    const candidates = (byNormalizedIt.get(normalize(r.name)) ?? []).filter((c) => c.id !== r.id);
    if (candidates.length === 1) {
      pairs.push({ duplicate: r, canonical: candidates[0] });
    } else {
      unmatched.push(r);
    }
  }

  console.log(`Found ${pairs.length} unambiguous duplicate pair(s):`);
  for (const p of pairs) {
    console.log(`  "${p.duplicate.name}" (${p.duplicate.id}) -> "${p.canonical.name}" (${p.canonical.id})`);
  }
  if (unmatched.length > 0) {
    console.log(`\n${unmatched.length} suspect(s) with no unambiguous canonical match (left alone):`);
    for (const u of unmatched) console.log(`  "${u.name}" (${u.id})`);
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — no changes made.");
    process.exit(0);
  }

  if (pairs.length === 0) {
    console.log("\nNothing to merge.");
    process.exit(0);
  }

  console.log("\nMerging...");
  let merged = 0;
  for (const { duplicate, canonical } of pairs) {
    try {
      await withTransaction(async (client) => {
        await client.query("UPDATE recipe_ingredients SET ingredient_id=$1 WHERE ingredient_id=$2", [canonical.id, duplicate.id]);
        await client.query("UPDATE ingredient_subtypes SET ingredient_id=$1 WHERE ingredient_id=$2", [canonical.id, duplicate.id]);
        await client.query("UPDATE shopping_list_items SET ingredient_id=$1 WHERE ingredient_id=$2", [canonical.id, duplicate.id]);
        await client.query(
          "UPDATE unit_conversions SET ingredient_id=$1 WHERE ingredient_id=$2 AND NOT EXISTS (SELECT 1 FROM unit_conversions uc2 WHERE uc2.from_unit_id=unit_conversions.from_unit_id AND uc2.to_unit_id=unit_conversions.to_unit_id AND uc2.ingredient_id=$1)",
          [canonical.id, duplicate.id]
        );
        await client.query("DELETE FROM unit_conversions WHERE ingredient_id=$1", [duplicate.id]); // any leftover collisions
        await client.query(
          `INSERT INTO ingredient_tags (ingredient_id, tag_id)
           SELECT $1, tag_id FROM ingredient_tags WHERE ingredient_id=$2
           ON CONFLICT DO NOTHING`,
          [canonical.id, duplicate.id]
        );
        await client.query("DELETE FROM ingredients WHERE id=$1", [duplicate.id]); // cascades tags/subtypes/translations still on the duplicate
      });
      merged++;
      console.log(`  merged "${duplicate.name}" into "${canonical.name}"`);
    } catch (err) {
      console.warn(`  failed to merge "${duplicate.name}" into "${canonical.name}":`, (err as Error).message);
    }
  }

  console.log(`\nDone — ${merged}/${pairs.length} merged.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Dedupe failed:", err);
  process.exit(1);
});
