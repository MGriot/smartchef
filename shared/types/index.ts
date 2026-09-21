// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shared TypeScript Types
// Usato da backend, frontend e app mobile
// ════════════════════════════════════════════════════════════════════════

export type UUID = string;
export type ISODate = string;

export type UnitType = "weight" | "volume" | "count" | "custom";
export type DifficultyLevel = "easy" | "medium" | "hard" | "expert";
export type SyncStatus = "local" | "synced" | "conflict" | "deleted";
export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

// ── Admin Hub ─────────────────────────────────────────────────────────────

export interface IngredientCategory {
  id: UUID;
  name: string;
  description?: string;
  icon?: string;
  sortOrder: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface IngredientSubtype {
  id: UUID;
  ingredientId: UUID;
  name: string;
  densityGPerMl?: number;
  notes?: string;
  createdAt: ISODate;
}

export interface Ingredient {
  id: UUID;
  categoryId: UUID;
  category?: IngredientCategory;
  name: string;
  pluralName?: string;
  description?: string;
  densityGPerMl?: number;
  defaultUnit?: string;
  subtypes?: IngredientSubtype[];
  syncStatus: SyncStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Unit {
  id: UUID;
  name: string;
  symbol: string;
  unitType: UnitType;
  baseUnitSymbol?: string;
  toBaseFactor?: number;
}

export interface UnitConversion {
  id: UUID;
  fromUnitId: UUID;
  toUnitId: UUID;
  factor: number;
  ingredientId?: UUID; // null = universale
}

export interface Tool {
  id: UUID;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
}

// ── Recipe Engine — Matrioska ─────────────────────────────────────────────

export interface RecipeIngredient {
  id: UUID;
  recipeId: UUID;
  sortOrder: number;
  // XOR: uno dei due deve essere valorizzato
  ingredientId?: UUID;
  ingredient?: Ingredient;
  subtypeId?: UUID;
  subRecipeId?: UUID;
  subRecipe?: Recipe; // populated on demand
  // Quantità
  quantity?: number;
  quantityText?: string;
  unitId?: UUID;
  unit?: Unit;
  notes?: string;
  isOptional: boolean;
}

export interface RecipeStep {
  id: UUID;
  recipeId: UUID;
  stepNumber: number;
  title?: string;
  description: string;
  durationMin?: number;
  toolIds?: UUID[];
  tools?: Tool[];
  imageUrl?: string;
}

export type RecipeSourceType = "url" | "book" | "video" | "other";

export interface RecipeSource {
  type: RecipeSourceType;
  label?: string;
  url?: string;
}

export interface Recipe {
  id: UUID;
  title: string;
  description?: string;
  difficulty: DifficultyLevel;
  servings: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  tags: string[];
  coverImageUrl?: string;
  sourceUrl?: string;
  sources: RecipeSource[];
  isComponent: boolean;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  tools?: Tool[];
  // CRDT
  crdtClock: Record<string, number>;
  crdtVersion: number;
  ownerId?: UUID;
  lastEditorId?: UUID;
  syncStatus: SyncStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── Calcolo Matrioska ─────────────────────────────────────────────────────

/**
 * Rappresenta un ingrediente "esploso" dopo la risoluzione ricorsiva
 * di tutte le sub-ricette, con la quantità scalata per le porzioni richieste.
 */
export interface ResolvedIngredient {
  ingredientId: UUID;
  ingredientName: string;
  quantity: number;
  quantityText?: string;
  unitSymbol: string;
  unitId: UUID;
  /** Whether the recipe marks this ingredient optional. Carried through so
   *  pantry matching can ignore a missing garnish — it was read from the
   *  row all along and simply never propagated. */
  isOptional: boolean;
  // Traccia il percorso della matrioska: ["Cena di Gala", "Salsa Madre"]
  sourceChain: string[];
}

export interface PortionCalculationResult {
  recipeId: UUID;
  recipeTitle: string;
  requestedServings: number;
  resolvedIngredients: ResolvedIngredient[];
  warnings: string[]; // es. "Quantità vaga: 'q.b.' in Salsa Madre"
}

// ── Menù & Spesa ──────────────────────────────────────────────────────────

export interface MenuItem {
  id: UUID;
  menuId: UUID;
  recipeId: UUID;
  recipe?: Recipe;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=lun, 6=dom
  mealType: MealType;
  servings: number;
  notes?: string;
}

export interface Menu {
  id: UUID;
  name: string;
  weekStart: ISODate;
  notes?: string;
  items: MenuItem[];
  crdtClock: Record<string, number>;
  ownerId?: UUID;
  syncStatus: SyncStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ShoppingListItemSource {
  recipeId: UUID;
  recipeTitle: string;
  servings: number;
  quantity: number;
  unitSymbol: string;
}

export interface ShoppingListItem {
  id: UUID;
  shoppingListId: UUID;
  ingredientId?: UUID;
  ingredientName?: string;
  ingredientPluralName?: string;
  ingredient?: Ingredient;
  totalQuantity?: number;
  quantityText?: string;
  unitId?: UUID;
  unit?: Unit;
  isChecked: boolean;
  sourceDetails: ShoppingListItemSource[];
  notes?: string;
  // Denormalised from the item's ingredient so a shopping list can be
  // grouped into aisles without a second round of lookups. sortOrder is the
  // category's own, which is what puts the aisles in walking order.
  categoryId?: UUID;
  categoryName?: string;
  categoryColor?: string;
  categoryIcon?: string;
  categorySortOrder?: number;
}

export interface ShoppingList {
  id: UUID;
  menuId?: UUID;
  name: string;
  items: ShoppingListItem[];
  crdtClock: Record<string, number>;
  ownerId?: UUID;
  syncStatus: SyncStatus;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── CRDT ──────────────────────────────────────────────────────────────────

export interface CRDTOperation {
  type: "insert" | "update" | "delete";
  entityType: "recipe" | "ingredient" | "menu" | "shopping_list";
  entityId: UUID;
  payload: Record<string, unknown>;
  clock: Record<string, number>;
  deviceId: string;
  timestamp: ISODate;
}

// ── LLM Parser ────────────────────────────────────────────────────────────

/** One non-text input: a photo, a scan, a PDF, a voice note, a clip.
 *  `data` is bare base64 with no `data:` prefix — every provider wants it
 *  that way except OpenAI, which gets a data URI built from these fields. */
export interface LLMParseMedia {
  mimeType: string;
  data: string;
  /** Only used in messages, so a failure can name the file. */
  fileName?: string;
}

export interface LLMParseRequest {
  input: string; // URL o testo grezzo
  inputType: "url" | "text" | "media";
  /** Required when inputType is "media". `input` then carries whatever
   *  extra context the user typed (or "" for none), not the recipe.
   *
   *  A list, because one recipe is often two cookbook pages or three
   *  photographs; only images may arrive as a set (see llm.parser.ts's
   *  assertMediaListSupported). The single-object form is still accepted
   *  so an older client keeps working against a newer server. */
  media?: LLMParseMedia | LLMParseMedia[];
  /** The app's content language. Decides which language the library
   *  catalog sent to the model is labelled in (importCatalog.service.ts),
   *  so a recipe written in that language can be recognized against it.
   *  Optional: without it the catalog is sent base-name-only, which is
   *  what the legacy /llm/parse route does. */
  lang?: string;
}

export interface LLMParseResult {
  title: string;
  language?: string; // ISO 639-1 code the LLM detected the source content is written in

  description?: string;
  servings?: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  difficulty?: DifficultyLevel;
  tags: string[];
  tools: string[];
  storageInstructions?: string | null;
  tips?: string | null;
  ingredients: Array<{
    name: string;
    /** The library entry the model says this ingredient corresponds to,
     *  copied verbatim from the catalog in the prompt — or null when
     *  nothing in the library fits and a new ingredient is wanted. `name`
     *  keeps the recipe's own wording either way. AI path only, and
     *  already validated against the catalog actually sent (see
     *  dropUnknownCatalogNames), so an entry here really does exist. */
    catalogName?: string | null;
    quantity?: number;
    quantityText?: string;
    unit?: string;
    notes?: string;
    // Optional short header this ingredient belongs under, e.g. "For the
    // sauce" — see llm.parser.ts SYSTEM_PROMPT for extraction rules.
    groupName?: string | null;
    // "Facoltativo"/"optional"/"to taste" in the source. Carried through
    // to recipe_ingredients.is_optional, which the pantry matcher and the
    // matrioska engine have always read and which nothing could set until
    // the parsers started extracting it.
    isOptional?: boolean;
  }>;
  steps: Array<{
    stepNumber: number;
    title?: string;
    description: string;
    durationMin?: number;
    // Cooking technique NAMEs the LLM recognized in this step (e.g.
    // "Sautéing"), not UUIDs — resolved against the DB in
    // ingredient.matcher.ts the same way `tools` names are, see matchTools.
    techniques?: string[];
  }>;
  sourceUrl?: string;
  /** Cover image for the recipe, absolute http(s). On a URL import this is
   *  the page's own og:image unless the model named a better one — see
   *  llm.parser.ts. The Import screen passes it through as coverImageUrl. */
  imageUrl?: string;
  confidence: number; // 0-1
  warnings: string[];
}
