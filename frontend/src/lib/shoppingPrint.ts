// ════════════════════════════════════════════════════════════════════════
// SmartChef — The shopping list, as the page shows it and as it prints
//
// The aisle grouping and the name / quantity wording are shared by the list
// screen (pages/ShoppingList.tsx) and its print page (pages/ShoppingPrint.tsx),
// so a printed list reads exactly like the one on screen. Kept pure so it can
// be tested — the suite has no jsdom.
// ════════════════════════════════════════════════════════════════════════

import { pickIngredientName } from './ingredientDisplay';

export interface ShoppingListSource {
  recipeId: string;
  recipeTitle: string;
  servings: number;
  quantity: number;
  unitSymbol: string;
}

export interface ShoppingListItem {
  id: string;
  ingredientId?: string;
  ingredientName?: string;
  ingredientPluralName?: string;
  totalQuantity?: number;
  quantityText?: string;
  unit?: { symbol: string; name: string };
  isChecked: boolean;
  sourceDetails: ShoppingListSource[];
  categoryId?: string;
  categoryName?: string;
  categoryColor?: string;
  categoryIcon?: string;
  categorySortOrder?: number;
}

export interface ShoppingListDetail {
  id: string;
  name: string;
  menuId?: string;
  items: ShoppingListItem[];
  createdAt: string;
}

export type Translate = (key: string) => string;

/** Aisles in walking order, uncategorised last. Mirrors groupByAisle() in
 *  services/shopping.local.ts and shopping.service.ts — the three have to
 *  agree or the screen, the offline screen and the Markdown export show the
 *  same list in three different orders. */
export function groupByAisle(items: ShoppingListItem[], otherLabel: string) {
  const buckets = new Map<string, {
    key: string; name: string; color?: string; icon?: string;
    sortOrder: number; items: ShoppingListItem[];
  }>();

  for (const item of items) {
    const key = item.categoryId ?? '__other__';
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        name: item.categoryName ?? otherLabel,
        color: item.categoryColor,
        icon: item.categoryIcon,
        sortOrder: item.categoryName ? (item.categorySortOrder ?? 0) : Number.MAX_SAFE_INTEGER,
        items: [],
      });
    }
    buckets.get(key)!.items.push(item);
  }

  for (const bucket of buckets.values()) {
    bucket.items.sort((a, b) => (a.ingredientName ?? '').localeCompare(b.ingredientName ?? ''));
  }

  return [...buckets.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

export function displayName(item: ShoppingListItem, t: Translate): string {
  if (!item.ingredientName) return t('shopping.ingredientFallback');
  return pickIngredientName(item.ingredientName, item.ingredientPluralName, item.totalQuantity ?? null);
}

export function formatQty(item: ShoppingListItem, t: Translate): string {
  if (item.quantityText) return item.quantityText;
  if (item.totalQuantity) {
    const v = item.totalQuantity;
    return `${v % 1 === 0 ? v : v.toFixed(1)} ${item.unit?.symbol ?? ''}`.trim();
  }
  return t('shopping.toTaste');
}

function formatAmount(quantity: number, unitSymbol: string): string {
  return `${quantity % 1 === 0 ? quantity : quantity.toFixed(1)} ${unitSymbol}`.trim();
}

export interface ShoppingSheetRow {
  id: string;
  name: string;
  quantity: string;
  checked: boolean;
  /** Recipes the ingredient is for; empty in the by-recipe view, where the
   *  heading already says. */
  usedIn: string;
}

export interface ShoppingSheetGroup {
  key: string;
  title: string;
  rows: ShoppingSheetRow[];
}

export type ShoppingView = 'ingredient' | 'recipe';

export interface ShoppingSheetOptions {
  view: ShoppingView;
  /** Leaves out what is already ticked — a list printed halfway through the
   *  shop only needs the rest. */
  uncheckedOnly: boolean;
  otherAisleLabel: string;
  t: Translate;
}

/** The groups of the printed list: aisles in walking order, or one block per
 *  recipe. A group left with no rows (everything ticked, unchecked-only) is
 *  dropped rather than printed as a bare heading. */
export function buildShoppingSheet(list: Pick<ShoppingListDetail, 'items'>, opts: ShoppingSheetOptions): ShoppingSheetGroup[] {
  const keep = (item: ShoppingListItem) => !opts.uncheckedOnly || !item.isChecked;

  if (opts.view === 'recipe') {
    const byRecipe = new Map<string, ShoppingSheetGroup>();
    for (const item of list.items.filter(keep)) {
      for (const src of item.sourceDetails) {
        if (!byRecipe.has(src.recipeId)) byRecipe.set(src.recipeId, { key: src.recipeId, title: src.recipeTitle, rows: [] });
        byRecipe.get(src.recipeId)!.rows.push({
          id: `${src.recipeId}:${item.id}`,
          name: displayName(item, opts.t),
          quantity: formatAmount(src.quantity, src.unitSymbol),
          checked: item.isChecked,
          usedIn: '',
        });
      }
    }
    return [...byRecipe.values()];
  }

  return groupByAisle(list.items.filter(keep), opts.otherAisleLabel).map((group) => ({
    key: group.key,
    title: group.name,
    rows: group.items.map((item) => ({
      id: item.id,
      name: displayName(item, opts.t),
      quantity: formatQty(item, opts.t),
      checked: item.isChecked,
      usedIn: item.sourceDetails.map((s) => s.recipeTitle).join(', '),
    })),
  }));
}
