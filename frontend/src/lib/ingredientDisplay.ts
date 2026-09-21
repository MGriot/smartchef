// ════════════════════════════════════════════════════════════════════════
// SmartChef — Plural-aware ingredient display
// Picks the plural form (ingredients.plural_name /
// ingredient_translations.plural_translation) when a quantity isn't
// exactly 1, falling back to the singular name whenever no plural is on
// file — never a regression for ingredients nobody filled it in for.
// ════════════════════════════════════════════════════════════════════════

/** `quantity` is the effective, already-scaled amount (servings-adjusted
 *  for a single recipe, or summed across recipes for a shopping list).
 *  Missing/zero/undefined quantity is treated as singular, same as "1". */
export function pickIngredientName(name: string, pluralName: string | null | undefined, quantity: number | null | undefined): string {
  const isPlural = typeof quantity === 'number' && quantity !== 0 && Math.abs(quantity - 1) > 1e-9;
  if (isPlural && pluralName) return pluralName;
  return name;
}

/** What a recipe's ingredient row is called: its catalog ingredient's name,
 *  or — for a recipe used as an ingredient — that recipe's title. A
 *  sub-recipe row has no ingredientName at all, so anything that reads only
 *  that field shows it as nameless. Both are already in the reader's
 *  language when the recipe was fetched with ?lang=. */
export function ingredientLabel(ing: { ingredientName?: string | null; subRecipeTitle?: string | null }): string {
  return ing.ingredientName || ing.subRecipeTitle || '';
}
