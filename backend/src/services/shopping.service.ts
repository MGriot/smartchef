// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shopping List Service
// Genera e aggrega la lista della spesa da un menù
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/pool";
import { calculatePortions } from "./matrioska.engine";
import { v4 as uuidv4 } from "uuid";
import type {
  ShoppingList,
  ShoppingListItem,
  ShoppingListItemSource,
  UUID,
} from "@shared/types/index";

interface RecipeServingsRow {
  recipe_id: UUID;
  recipe_title: string;
  servings: number;
}

export type ShoppingListSource =
  | { menuId: UUID }
  | { recipes: Array<{ recipeId: UUID; servings: number }> };

/**
 * Genera la lista della spesa aggregata da un menù salvato, oppure da un
 * set ad-hoc di ricette (es. un "carrello" temporaneo composto dall'utente
 * senza salvare un menù vero e proprio). Per ogni ricetta, risolve la
 * matrioska e somma le quantità.
 */
export async function generateShoppingList(
  source: ShoppingListSource,
  listName: string,
  ownerId: UUID
): Promise<ShoppingList> {
  const menuId = "menuId" in source ? source.menuId : undefined;

  // 1. Carica le ricette da includere (dal menù o dalla lista ad-hoc)
  let menuItems: RecipeServingsRow[];
  if ("menuId" in source) {
    menuItems = await query<RecipeServingsRow>(
      `SELECT mi.recipe_id, r.title AS recipe_title, mi.servings
       FROM menu_items mi
       JOIN recipes r ON r.id = mi.recipe_id
       WHERE mi.menu_id = $1
       ORDER BY mi.day_of_week, mi.meal_type`,
      [source.menuId]
    );
  } else {
    const rows = await query<{ id: UUID; title: string }>(
      `SELECT id, title FROM recipes WHERE id = ANY($1::uuid[])`,
      [source.recipes.map(r => r.recipeId)]
    );
    const titleById = new Map(rows.map(r => [r.id, r.title]));
    menuItems = source.recipes.map(r => ({
      recipe_id: r.recipeId,
      recipe_title: titleById.get(r.recipeId) ?? "Ricetta",
      servings: r.servings,
    }));
  }

  if (!menuItems.length) {
    throw new Error("Nessuna ricetta selezionata");
  }

  // 2. Risolvi ogni ricetta e raccogli gli ingredienti
  const aggregated = new Map<
    string, // ingredientId::unitId
    {
      ingredientId: UUID;
      ingredientName: string;
      totalQuantity: number;
      quantityText?: string;
      unitId: UUID;
      unitSymbol: string;
      sources: ShoppingListItemSource[];
    }
  >();

  const allWarnings: string[] = [];

  for (const item of menuItems) {
    const result = await calculatePortions(item.recipe_id, item.servings);
    allWarnings.push(...result.warnings);

    for (const ing of result.resolvedIngredients) {
      const key = `${ing.ingredientId}::${ing.unitId}`;

      const source: ShoppingListItemSource = {
        recipeId: item.recipe_id,
        recipeTitle: item.recipe_title,
        servings: item.servings,
        quantity: ing.quantity,
        unitSymbol: ing.unitSymbol,
      };

      if (aggregated.has(key)) {
        const existing = aggregated.get(key)!;
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

  // 3. Persisti la lista nel DB
  const listId = uuidv4();
  await query(
    `INSERT INTO shopping_lists (id, menu_id, name, owner_id, crdt_clock)
     VALUES ($1, $2, $3, $4, '{}')`,
    [listId, menuId ?? null, listName, ownerId]
  );

  for (const [, agg] of aggregated) {
    const itemId = uuidv4();
    await query(
      `INSERT INTO shopping_list_items
         (id, shopping_list_id, ingredient_id, total_quantity,
          quantity_text, unit_id, is_checked, source_details)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7)`,
      [
        itemId,
        listId,
        agg.ingredientId,
        agg.totalQuantity > 0 ? agg.totalQuantity : null,
        agg.quantityText ?? null,
        agg.unitId || null,
        JSON.stringify(agg.sources),
      ]
    );
  }

  // Read the list back instead of returning the in-memory `items`: only the
  // reload joins ingredient_categories, so a freshly generated list would
  // otherwise arrive with no aisle data and render ungrouped until the user
  // navigated away and back. Reading back also guarantees this response is
  // identical to a later GET /shopping/:id of the same list.
  const saved = await loadShoppingList(listId, ownerId);
  if (!saved) throw new Error("Shopping list could not be saved");
  return saved;
}

/**
 * Ricarica una lista della spesa già generata (con i suoi item) dal DB.
 */
export async function loadShoppingList(listId: UUID, ownerId: UUID): Promise<ShoppingList | null> {
  const listRow = await queryOne<{
    id: UUID; menu_id: UUID | null; name: string;
    sync_status: string; created_at: string; updated_at: string;
  }>("SELECT * FROM shopping_lists WHERE id=$1 AND owner_id=$2", [listId, ownerId]);
  if (!listRow) return null;

  // Postgres NUMERIC columns come back from the pg driver as strings (to
  // avoid float precision loss), so total_quantity needs an explicit parse.
  // The category join is what makes the list shoppable: items are grouped by
  // it (an aisle), ordered by the category's own sort_order, instead of
  // alphabetically by ingredient name — basil, beef, bread is not the order
  // anyone walks a shop in.
  const itemRows = await query<{
    id: UUID; ingredient_id: UUID | null; total_quantity: string | null;
    quantity_text: string | null; unit_id: UUID | null; is_checked: boolean;
    source_details: ShoppingListItemSource[]; ingredient_name: string | null;
    ingredient_plural_name: string | null;
    unit_symbol: string | null; unit_name: string | null;
    category_id: UUID | null; category_name: string | null;
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
    [listId]
  );

  const items: ShoppingListItem[] = itemRows.map(r => ({
    id: r.id,
    shoppingListId: listId,
    ingredientId: r.ingredient_id ?? undefined,
    ingredientName: r.ingredient_name ?? undefined,
    ingredientPluralName: r.ingredient_plural_name ?? undefined,
    totalQuantity: r.total_quantity != null ? parseFloat(r.total_quantity) : undefined,
    quantityText: r.quantity_text ?? undefined,
    unitId: r.unit_id ?? undefined,
    unit: r.unit_id ? { id: r.unit_id, name: r.unit_name ?? "", symbol: r.unit_symbol ?? "", unitType: "weight" } : undefined,
    isChecked: r.is_checked,
    sourceDetails: r.source_details ?? [],
    categoryId: r.category_id ?? undefined,
    categoryName: r.category_name ?? undefined,
    categoryColor: r.category_color ?? undefined,
    categoryIcon: r.category_icon ?? undefined,
    categorySortOrder: r.category_sort_order ?? undefined,
  }));

  items.sort(compareByAisleThenName);

  return {
    id: listRow.id,
    menuId: listRow.menu_id ?? undefined,
    name: listRow.name,
    items,
    crdtClock: {},
    syncStatus: listRow.sync_status as ShoppingList["syncStatus"],
    createdAt: listRow.created_at,
    updatedAt: listRow.updated_at,
  };
}

/** Aisle order, then name inside the aisle. Uncategorised items sort last —
 *  they are the ones you have to go looking for anyway. */
export function compareByAisleThenName(
  a: { categoryName?: string; categorySortOrder?: number; ingredientName?: string },
  b: { categoryName?: string; categorySortOrder?: number; ingredientName?: string }
): number {
  const aUncat = !a.categoryName;
  const bUncat = !b.categoryName;
  if (aUncat !== bUncat) return aUncat ? 1 : -1;
  const order = (a.categorySortOrder ?? 0) - (b.categorySortOrder ?? 0);
  if (order !== 0) return order;
  const byCategory = (a.categoryName ?? "").localeCompare(b.categoryName ?? "");
  if (byCategory !== 0) return byCategory;
  return (a.ingredientName ?? "").localeCompare(b.ingredientName ?? "");
}

/** One bucket per aisle, already in walking order. */
export function groupByAisle(items: ShoppingListItem[], uncategorisedLabel = "Other"): Array<{
  categoryId?: string; categoryName: string; categoryColor?: string; categoryIcon?: string;
  items: ShoppingListItem[];
}> {
  const buckets = new Map<string, {
    categoryId?: string; categoryName: string; categoryColor?: string; categoryIcon?: string;
    sortOrder: number; items: ShoppingListItem[];
  }>();

  for (const item of [...items].sort(compareByAisleThenName)) {
    const key = item.categoryId ?? "__uncategorised__";
    if (!buckets.has(key)) {
      buckets.set(key, {
        categoryId: item.categoryId,
        categoryName: item.categoryName ?? uncategorisedLabel,
        categoryColor: item.categoryColor,
        categoryIcon: item.categoryIcon,
        // Uncategorised sinks below every real aisle regardless of their
        // sort_order values.
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

/**
 * Esporta la lista della spesa in formato Markdown gerarchico
 */
export function exportShoppingListMarkdown(list: ShoppingList): string {
  const lines: string[] = [
    `# 🛒 ${list.name}`,
    `_Generata il ${new Date(list.createdAt).toLocaleDateString("it-IT")}_`,
    "",
  ];

  // Grouped by aisle in walking order — the printed list should match the
  // on-screen one, and both should match the shop.
  for (const group of groupByAisle(list.items)) {
    lines.push(`## ${group.categoryName}`);
    for (const item of group.items) {
      const ing = item.ingredientName ?? "ingrediente sconosciuto";
      const qty = item.quantityText
        ? item.quantityText
        : item.totalQuantity
        ? `${item.totalQuantity.toFixed(1)} ${item.unit?.symbol ?? ""}`.trim()
        : "q.b.";
      lines.push(`- [ ] **${ing}** — ${qty}`);
      // Tree-view: dettaglio per ricetta
      for (const src of item.sourceDetails) {
        lines.push(
          `    - ${src.recipeTitle} (${src.servings} porz.): ${src.quantity.toFixed(1)} ${src.unitSymbol}`
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
