// ════════════════════════════════════════════════════════════════════════
// SmartChef — Catalog list query (tools, tags, techniques)
// The three catalog routes list their table the same way: live rows, the
// requested language's name, every translation, and an optional search
// over name and synonyms. Only the table names and the sort differ.
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";

/** Fixed identifiers from the routes, never request input. */
export interface CatalogListSpec {
  table: string;
  translationTable: string;
  foreignKey: string;
  /** Whether each translation carries a description alongside the name. */
  withDescription: boolean;
  orderBy: string;
}

export function buildCatalogListQuery(spec: CatalogListSpec, lang: unknown, q: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  if (lang) params.push(lang);
  if (q) params.push(`%${q}%`);
  const description = spec.withDescription ? ", 'description', tr.description" : "";
  const text =
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name${description}))
               FROM ${spec.translationTable} tr WHERE tr.${spec.foreignKey} = t.id),
              '[]'::json
            ) AS translations
     FROM ${spec.table} t
     ${lang ? `LEFT JOIN ${spec.translationTable} tt ON tt.${spec.foreignKey} = t.id AND LOWER(tt.language_code) = LOWER($1)` : ""}
     WHERE t.deleted_at IS NULL
       ${q ? `AND (t.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(t.synonyms) syn WHERE syn ILIKE $${params.length}))` : ""}
     ORDER BY ${spec.orderBy}`;
  return { text, params };
}

export function listCatalog(spec: CatalogListSpec, lang: unknown, q: unknown) {
  const { text, params } = buildCatalogListQuery(spec, lang, q);
  return query(text, params);
}
