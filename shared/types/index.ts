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
  ingredient?: Ingredient;
  totalQuantity?: number;
  quantityText?: string;
  unitId?: UUID;
  unit?: Unit;
  isChecked: boolean;
  sourceDetails: ShoppingListItemSource[];
  notes?: string;
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

export interface LLMParseRequest {
  input: string; // URL o testo grezzo
  inputType: "url" | "text";
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
    quantity?: number;
    quantityText?: string;
    unit?: string;
    notes?: string;
    // Optional short header this ingredient belongs under, e.g. "For the
    // sauce" — see llm.parser.ts SYSTEM_PROMPT for extraction rules.
    groupName?: string | null;
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
  confidence: number; // 0-1
  warnings: string[];
}
