// ════════════════════════════════════════════════════════════════════════
// SmartChef — Which tags belong on an ingredient
//
// Tags describe a DISH: its course, cuisine, occasion, season. The one
// exception is what a food CONTAINS (meat, gluten, lactose…) and the diets
// that follow from it (vegetarian, vegan): those are facts about the
// ingredient, and are what auto-tagging passes on to every recipe that
// uses it (services/tags.local.ts computeAutoTagNames()).
//
// Every other tag used to be passed on too, so one "Comfort food" or
// "Piemonte" on an ingredient landed on every recipe that touched it, and
// "Tidy with AI" was asked to tag ingredients with anything that fit.
//
// Groups are free text (users name and rename them), so a tag counts as an
// ingredient tag when its group is one of the known contains/diet names in
// any of the app's languages, when it is itself a diet (it has exclusions),
// or when some diet excludes it — the last two survive any renaming.
// ════════════════════════════════════════════════════════════════════════

export const INGREDIENT_TAG_GROUPS = new Set([
  'contiene', 'dieta', 'allergeni', 'allergene',
  'contains', 'diet', 'diets', 'allergens', 'allergen',
  'contient', 'régime', 'regime', 'allergènes',
  'contiene', 'alérgenos', 'alergenos',
]);

export interface ScopedTag {
  id: string;
  group_name?: string | null;
  exclude_tag_ids?: string[] | string | null;
}

function excludeIds(tag: ScopedTag): string[] {
  const raw = tag.exclude_tag_ids;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

/** Builds a predicate over one catalog: true for tags that describe what an
 *  ingredient contains or the diets it fits. */
export function ingredientTagFilter(catalog: ScopedTag[]): (tag: ScopedTag) => boolean {
  const excludedByADiet = new Set(catalog.flatMap(excludeIds));
  return (tag) =>
    INGREDIENT_TAG_GROUPS.has((tag.group_name ?? '').trim().toLowerCase())
    || excludeIds(tag).length > 0
    || excludedByADiet.has(tag.id);
}
