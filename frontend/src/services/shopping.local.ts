// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shopping lists, standalone mode
//
// Port of backend/src/services/shopping.service.ts onto the local SQLite
// store. Same aggregation rule (one row per ingredient+unit, quantities
// summed across every recipe, each contribution kept in source_details so
// the by-recipe view can be rebuilt), same response shapes, so
// pages/ShoppingList.tsx cannot tell which side answered it.
//
// Why this exists: /api/shopping had no entry in localRouter.ts, so in
// standalone mode "Generate List" fell through to an HTTP call to a server
// that isn't there. apiFetch throws "No server configured" for that, and
// the page's handler only console.error's it — so the button spun and
// nothing happened, with no error anywhere the user could see. Same failure
// mode as the share/export bug (share.local.integration.test.ts).
//
// Lists are local-only and outside the sync snapshot, matching the server
// (where they are owner-scoped and absent from the folder-sync snapshot):
// a shopping list is "what am I buying this week", not library content
// other devices need.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import { calculatePortions, type UUID } from './matrioska.local';

export interface ShoppingListItemSource {
  recipeId: string;
  recipeTitle: string;
  servings: number;
  quantity: number;
  unitSymbol: string;
}

export interface ShoppingListItem {
  id: string;
  shoppingListId: string;
  ingredientId?: string;
  ingredientName?: string;
  ingredientPluralName?: string;
  totalQuantity?: number;
  quantityText?: string;
  unitId?: string;
  unit?: { id: string; name: string; symbol: string };
  isChecked: boolean;
  sourceDetails: ShoppingListItemSource[];
  // Denormalised from the ingredient so the list can be grouped into aisles
  // without a second lookup — see groupByAisle().
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
  updatedAt: string;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Summaries for the "Past Lists" rail — snake_case with an item_count,
 *  matching what GET /api/shopping returns (the page reads `item_count`
 *  and `created_at` straight off these rows). */
export async function listShoppingLists(): Promise<Array<Record<string, unknown>>> {
  return query(
    `SELECT sl.*, COUNT(sli.id) AS item_count
       FROM shopping_lists sl
       LEFT JOIN shopping_list_items sli ON sli.shopping_list_id = sl.id
      GROUP BY sl.id
      ORDER BY sl.created_at DESC`,
  );
}

export async function loadShoppingList(listId: string): Promise<ShoppingListDetail | null> {
  const listRow = await queryOne<{
    id: string; menu_id: string | null; name: string; created_at: string; updated_at: string;
  }>('SELECT * FROM shopping_lists WHERE id=$1', [listId]);
  if (!listRow) return null;

  // The ingredient_categories join is what makes the list shoppable: items
  // group by aisle in the category's own sort_order instead of alphabetically
  // by name. Mirrors backend/src/services/shopping.service.ts exactly.
  const itemRows = await query<{
    id: string; ingredient_id: string | null; total_quantity: number | null;
    quantity_text: string | null; unit_id: string | null; is_checked: number;
    source_details: string; ingredient_name: string | null; ingredient_plural_name: string | null;
    unit_symbol: string | null; unit_name: string | null;
    category_id: string | null; category_name: string | null;
    category_color: string | null; category_icon: string | null;
    category_sort_order: number | null;
  }>(
    `SELECT sli.*, i.name AS ingredient_name, i.plural_name AS ingredient_plural_name,
            u.symbol AS unit_symbol, u.name AS unit_name,
            ic.id AS category_id, ic.name AS category_name, ic.color AS category_color,
            ic.icon AS category_icon, ic.sort_order AS category_sort_order
       FROM shopping_list_items sli
       LEFT JOIN ingredients i ON i.id = sli.ingredient_id
       LEFT JOIN units u ON u.id = sli.unit_id
       LEFT JOIN ingredient_categories ic ON ic.id = i.category_id
      WHERE sli.shopping_list_id = $1`,
    [listId],
  );

  const items: ShoppingListItem[] = itemRows.map((r) => ({
    id: r.id,
    shoppingListId: listId,
    ingredientId: r.ingredient_id ?? undefined,
    ingredientName: r.ingredient_name ?? undefined,
    ingredientPluralName: r.ingredient_plural_name ?? undefined,
    totalQuantity: r.total_quantity ?? undefined,
    quantityText: r.quantity_text ?? undefined,
    unitId: r.unit_id ?? undefined,
    unit: r.unit_id
      ? { id: r.unit_id, name: r.unit_name ?? '', symbol: r.unit_symbol ?? '' }
      : undefined,
    // SQLite has no boolean type — 0/1 comes back as a number, and the page
    // renders the checkbox off `isChecked` directly.
    isChecked: !!r.is_checked,
    sourceDetails: safeParseSources(r.source_details),
    categoryId: r.category_id ?? undefined,
    categoryName: r.category_name ?? undefined,
    categoryColor: r.category_color ?? undefined,
    categoryIcon: r.category_icon ?? undefined,
    categorySortOrder: r.category_sort_order ?? undefined,
  }));

  items.sort(compareByAisleThenName);

  return {
    id: listRow.id,
    name: listRow.name,
    menuId: listRow.menu_id ?? undefined,
    items,
    createdAt: listRow.created_at,
    updatedAt: listRow.updated_at,
  };
}

function safeParseSources(raw: string | null): ShoppingListItemSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Aggregates every ingredient across the given recipes and persists the
 * result as a new list.
 *
 * Each recipe goes through the matrioska engine first, so a recipe used as
 * a sub-recipe contributes its own ingredients scaled correctly — which is
 * the whole reason this can't just sum recipe_ingredients rows.
 */
export async function generateShoppingList(
  recipes: Array<{ recipeId: string; servings: number }>,
  listName: string,
  menuId: string | null = null,
): Promise<ShoppingListDetail> {
  if (!recipes.length) throw new Error('No recipes selected');

  const titleRows = await query<{ id: string; title: string }>(
    `SELECT id, title FROM recipes WHERE id IN (${recipes.map((_, i) => `$${i + 1}`).join(',')})`,
    recipes.map((r) => r.recipeId),
  );
  const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

  const aggregated = new Map<string, {
    ingredientId: UUID;
    ingredientName: string;
    totalQuantity: number;
    quantityText?: string;
    unitId: UUID;
    unitSymbol: string;
    sources: ShoppingListItemSource[];
  }>();

  for (const entry of recipes) {
    const result = await calculatePortions(entry.recipeId, entry.servings);
    const recipeTitle = titleById.get(entry.recipeId) ?? result.recipeTitle ?? 'Recipe';

    for (const ing of result.resolvedIngredients) {
      // Same key as the server: an ingredient in grams and the same
      // ingredient in "pieces" are two shopping lines, not one wrong sum.
      const key = `${ing.ingredientId}::${ing.unitId}`;
      const source: ShoppingListItemSource = {
        recipeId: entry.recipeId,
        recipeTitle,
        servings: entry.servings,
        quantity: ing.quantity,
        unitSymbol: ing.unitSymbol,
      };
      const existing = aggregated.get(key);
      if (existing) {
        existing.totalQuantity += ing.quantity;
        existing.sources.push(source);
      } else {
        aggregated.set(key, {
          ingredientId: ing.ingredientId,
          ingredientName: ing.ingredientName,
          totalQuantity: ing.quantity,
          quantityText: ing.quantityText,
          unitId: ing.unitId,
          unitSymbol: ing.unitSymbol,
          sources: [source],
        });
      }
    }
  }

  const listId = newId();
  await query('INSERT INTO shopping_lists (id, menu_id, name) VALUES ($1, $2, $3)', [listId, menuId, listName]);

  for (const agg of aggregated.values()) {
    await query(
      `INSERT INTO shopping_list_items
         (id, shopping_list_id, ingredient_id, total_quantity, quantity_text, unit_id, is_checked, source_details)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7)`,
      [
        newId(),
        listId,
        agg.ingredientId,
        agg.totalQuantity > 0 ? agg.totalQuantity : null,
        agg.quantityText ?? null,
        agg.unitId || null,
        JSON.stringify(agg.sources),
      ],
    );
  }

  // Read back rather than assembling in memory: guarantees the response is
  // byte-identical to a later GET /api/shopping/:id of the same list.
  const saved = await loadShoppingList(listId);
  if (!saved) throw new Error('Shopping list could not be saved');
  return saved;
}

export async function setItemChecked(listId: string, itemId: string, checked: boolean): Promise<boolean> {
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM shopping_list_items WHERE id=$1 AND shopping_list_id=$2',
    [itemId, listId],
  );
  if (!existing) return false;
  await query('UPDATE shopping_list_items SET is_checked=$1 WHERE id=$2', [checked ? 1 : 0, itemId]);
  return true;
}

export async function deleteShoppingList(listId: string): Promise<boolean> {
  const existing = await queryOne<{ id: string }>('SELECT id FROM shopping_lists WHERE id=$1', [listId]);
  if (!existing) return false;
  // The items' FK is ON DELETE CASCADE, but local SQLite enforces foreign
  // keys without an explicit PRAGMA here, and an orphaned item row would
  // still be counted by listShoppingLists()' LEFT JOIN — delete both.
  await query('DELETE FROM shopping_list_items WHERE shopping_list_id=$1', [listId]);
  await query('DELETE FROM shopping_lists WHERE id=$1', [listId]);
  return true;
}

/** Aisle order, then name inside the aisle. Uncategorised items sort last —
 *  they are the ones you have to go looking for anyway. */
export function compareByAisleThenName(
  a: { categoryName?: string; categorySortOrder?: number; ingredientName?: string },
  b: { categoryName?: string; categorySortOrder?: number; ingredientName?: string },
): number {
  const aUncat = !a.categoryName;
  const bUncat = !b.categoryName;
  if (aUncat !== bUncat) return aUncat ? 1 : -1;
  const order = (a.categorySortOrder ?? 0) - (b.categorySortOrder ?? 0);
  if (order !== 0) return order;
  const byCategory = (a.categoryName ?? '').localeCompare(b.categoryName ?? '');
  if (byCategory !== 0) return byCategory;
  return (a.ingredientName ?? '').localeCompare(b.ingredientName ?? '');
}

export interface AisleGroup {
  categoryId?: string;
  categoryName: string;
  categoryColor?: string;
  categoryIcon?: string;
  items: ShoppingListItem[];
}

/** One bucket per aisle, already in walking order. */
export function groupByAisle(items: ShoppingListItem[], uncategorisedLabel = 'Other'): AisleGroup[] {
  const buckets = new Map<string, AisleGroup & { sortOrder: number }>();

  for (const item of [...items].sort(compareByAisleThenName)) {
    const key = item.categoryId ?? '__uncategorised__';
    if (!buckets.has(key)) {
      buckets.set(key, {
        categoryId: item.categoryId,
        categoryName: item.categoryName ?? uncategorisedLabel,
        categoryColor: item.categoryColor,
        categoryIcon: item.categoryIcon,
        // Uncategorised sinks below every real aisle whatever their
        // sort_order values happen to be.
        sortOrder: item.categoryName ? (item.categorySortOrder ?? 0) : Number.MAX_SAFE_INTEGER,
        items: [],
      });
    }
    buckets.get(key)!.items.push(item);
  }

  return [...buckets.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.categoryName.localeCompare(b.categoryName))
    .map(({ sortOrder, ...rest }) => rest);
}

/** Markdown export — same layout as the server's: grouped by aisle in
 *  walking order, checkbox per line, per-recipe breakdown indented under
 *  each. */
export function exportShoppingListMarkdown(list: ShoppingListDetail): string {
  const lines: string[] = [
    `# 🛒 ${list.name}`,
    `_${new Date(list.createdAt).toLocaleDateString()}_`,
    '',
  ];

  for (const group of groupByAisle(list.items)) {
    lines.push(`## ${group.categoryName}`);
    for (const item of group.items) {
      const name = item.ingredientName ?? 'unknown ingredient';
      const qty = item.quantityText
        ? item.quantityText
        : item.totalQuantity
          ? `${item.totalQuantity.toFixed(1)} ${item.unit?.symbol ?? ''}`.trim()
          : 'to taste';
      lines.push(`- [ ] **${name}** — ${qty}`);
      for (const src of item.sourceDetails) {
        lines.push(`    - ${src.recipeTitle} (${src.servings} servings): ${src.quantity.toFixed(1)} ${src.unitSymbol}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
