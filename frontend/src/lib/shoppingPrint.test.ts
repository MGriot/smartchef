import { describe, it, expect } from 'vitest';
import { buildShoppingSheet, type ShoppingListItem } from './shoppingPrint';

const t = (key: string) => key;

const item = (id: string, name: string, extra: Partial<ShoppingListItem> = {}): ShoppingListItem => ({
  id, ingredientName: name, totalQuantity: 2, unit: { symbol: 'kg', name: 'kilo' }, isChecked: false, sourceDetails: [], ...extra,
});

const src = (recipeId: string, title: string, quantity = 1) => ({ recipeId, recipeTitle: title, servings: 4, quantity, unitSymbol: 'g' });

const list = {
  items: [
    item('1', 'Tomato', { categoryId: 'veg', categoryName: 'Vegetables', categorySortOrder: 1, sourceDetails: [src('r1', 'Soup'), src('r2', 'Salad')] }),
    item('2', 'Milk', { categoryId: 'dairy', categoryName: 'Dairy', categorySortOrder: 0, isChecked: true, sourceDetails: [src('r1', 'Soup', 250)] }),
    item('3', 'Salt', { totalQuantity: undefined, unit: undefined }),
  ],
};

const base = { view: 'ingredient' as const, uncheckedOnly: false, otherAisleLabel: 'Other', t };

describe('buildShoppingSheet — by ingredient', () => {
  it('orders aisles by sort order with uncategorised last', () => {
    expect(buildShoppingSheet(list, base).map((g) => g.title)).toEqual(['Dairy', 'Vegetables', 'Other']);
  });

  it('words quantities and falls back to "to taste"', () => {
    const rows = buildShoppingSheet(list, base).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === '1')!.quantity).toBe('2 kg');
    expect(rows.find((r) => r.id === '3')!.quantity).toBe('shopping.toTaste');
  });

  it('lists the recipes an ingredient is for', () => {
    expect(buildShoppingSheet(list, base).flatMap((g) => g.rows).find((r) => r.id === '1')!.usedIn).toBe('Soup, Salad');
  });

  it('drops ticked items, and aisles left empty, when asked', () => {
    const groups = buildShoppingSheet(list, { ...base, uncheckedOnly: true });
    expect(groups.map((g) => g.title)).toEqual(['Vegetables', 'Other']);
  });
});

describe('buildShoppingSheet — by recipe', () => {
  it('has one group per recipe with the amount that recipe needs', () => {
    const groups = buildShoppingSheet(list, { ...base, view: 'recipe' });
    expect(groups.map((g) => g.title)).toEqual(['Soup', 'Salad']);
    expect(groups[0].rows.map((r) => r.quantity)).toEqual(['1 g', '250 g']);
  });

  it('honours unchecked-only', () => {
    const groups = buildShoppingSheet(list, { ...base, view: 'recipe', uncheckedOnly: true });
    expect(groups[0].rows.map((r) => r.name)).toEqual(['Tomato']);
  });
});
