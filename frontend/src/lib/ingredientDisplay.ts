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
