// ════════════════════════════════════════════════════════════════════════
// SmartChef — Servizio: Auto-tagging basato sugli ingredienti
//
// Un tag è "presenza" (es. Soia, Carne, Glutine) quando è associato via
// ingredient_tags a uno o più ingredienti — si applica a una ricetta se
// almeno uno dei suoi ingredienti diretti porta quel tag. Un tag è
// "dieta" (es. Vegetariano, Vegano) quando ha `exclude_tag_ids` non vuoto
// — si applica automaticamente a meno che uno di quei tag esclusi non sia
// presente. I sub-ricette non vengono ricorse: la composizione di una
// sub-ricetta è affare suo, non si eredita nella ricetta che la usa.
// ════════════════════════════════════════════════════════════════════════

import type { PoolClient } from "pg";

export async function computeAutoTagNames(client: PoolClient, recipeId: string): Promise<string[]> {
  const presentRows = await client.query<{ id: string; name: string }>(
    `SELECT DISTINCT t.id, t.name
     FROM recipe_ingredients ri
     JOIN ingredient_tags it ON it.ingredient_id = ri.ingredient_id
     JOIN tags t ON t.id = it.tag_id
     WHERE ri.recipe_id = $1 AND ri.ingredient_id IS NOT NULL`,
    [recipeId]
  );
  const presentTagIds = new Set(presentRows.rows.map(r => r.id));
  const names = new Set(presentRows.rows.map(r => r.name));

  const dietRows = await client.query<{ name: string; exclude_tag_ids: string[] }>(
    `SELECT name, exclude_tag_ids FROM tags WHERE array_length(exclude_tag_ids, 1) > 0`
  );
  for (const tag of dietRows.rows) {
    const excluded = tag.exclude_tag_ids.some(id => presentTagIds.has(id));
    if (!excluded) names.add(tag.name);
  }

  return Array.from(names);
}

/** Case-insensitive union, keeping the first-seen casing for each name. */
export function unionTagNames(...lists: string[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const name of list) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values());
}
