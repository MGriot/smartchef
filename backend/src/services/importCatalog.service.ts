// ════════════════════════════════════════════════════════════════════════
// SmartChef — Import catalog (server mode)
// Loads the names the user's library already knows, so the recipe-import
// prompt can ask the model to REUSE them instead of coining its own
// wording for every import (see llm.parser.ts's buildSystemPrompt).
//
// Standalone twin: frontend/src/services/importCatalog.local.ts. The two
// load from different databases and are NOT expected to share code — but
// they must return the same shape, because the renderer that turns this
// into prompt text is itself twin-copied and byte-identical.
//
// Deliberately NOT built on proposeIngredientMatches() and friends: those
// read ids, plurals and synonyms to score with, and this only ever needs
// the two name columns that end up in the prompt.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";

export interface ImportCatalogEntry {
  /** The canonical (base) name — what the model is told to echo back. */
  name: string;
  /** The name in the requested content language, when one is recorded.
   *  Shown to the model in parentheses purely so it can RECOGNIZE the
   *  entry in a recipe written in that language; never echoed back. */
  translatedName: string | null;
}

export interface ImportCatalog {
  ingredients: ImportCatalogEntry[];
  tools: ImportCatalogEntry[];
  techniques: ImportCatalogEntry[];
}

/** Why the ingredient list alone is capped: tools and techniques are a
 *  couple of dozen rows each on any real library, while ingredients run to
 *  the low hundreds and are the only list that can plausibly grow past a
 *  sensible prompt budget. The cap is a runaway guard, not an expected
 *  path. */
export const DEFAULT_MAX_INGREDIENTS = 400;

type Row = { name: string; translated_name: string | null };

export async function loadImportCatalog(
  lang?: string,
  maxIngredients: number = DEFAULT_MAX_INGREDIENTS
): Promise<ImportCatalog> {
  const [ingredients, tools, techniques] = await Promise.all([
    // Usage-ordered, so when the cap does bite it drops the ingredients
    // this library barely uses rather than everything alphabetically after
    // "P" — which is what a plain ORDER BY name LIMIT would do.
    query<Row>(
      `SELECT i.name,
              ${lang ? "tr.translated_name" : "NULL AS translated_name"}
       FROM ingredients i
       ${lang ? "LEFT JOIN ingredient_translations tr ON tr.ingredient_id = i.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
       LEFT JOIN recipe_ingredients ri ON ri.ingredient_id = i.id
       WHERE i.sync_status != 'deleted'
       GROUP BY i.id, i.name${lang ? ", tr.translated_name" : ""}
       ORDER BY COUNT(ri.id) DESC, i.name
       LIMIT ${lang ? "$2" : "$1"}`,
      lang ? [lang, maxIngredients] : [maxIngredients]
    ),
    query<Row>(
      `SELECT t.name,
              ${lang ? "tr.name AS translated_name" : "NULL AS translated_name"}
       FROM tools t
       ${lang ? "LEFT JOIN tool_translations tr ON tr.tool_id = t.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
       WHERE t.deleted_at IS NULL
       ORDER BY t.name`,
      lang ? [lang] : []
    ),
    query<Row>(
      `SELECT t.name,
              ${lang ? "tr.name AS translated_name" : "NULL AS translated_name"}
       FROM techniques t
       ${lang ? "LEFT JOIN technique_translations tr ON tr.technique_id = t.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
       WHERE t.deleted_at IS NULL
       ORDER BY t.name`,
      lang ? [lang] : []
    ),
  ]);

  return {
    ingredients: ingredients.map(toEntry),
    tools: tools.map(toEntry),
    techniques: techniques.map(toEntry),
  };
}

function toEntry(row: Row): ImportCatalogEntry {
  return { name: row.name, translatedName: row.translated_name ?? null };
}
