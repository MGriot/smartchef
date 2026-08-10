import { create } from "zustand";

interface Recipe {
  id: string;
  title: string;
  difficulty: string;
  servings: number;
  tags: string[];
  coverImageUrl?: string;
  updatedAt: string;
  syncStatus: string;
  ingredientCount?: number;
}

interface SyncState {
  peers: any[];
  conflicts: any[];
  lastSync?: Date;
}

export interface ShoppingCartItem {
  recipeId: string;
  title: string;
  servings: number;
}

const SHOPPING_CART_KEY = "smartchef.shoppingCart";

function loadShoppingCart(): ShoppingCartItem[] {
  try {
    return JSON.parse(localStorage.getItem(SHOPPING_CART_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveShoppingCart(items: ShoppingCartItem[]) {
  localStorage.setItem(SHOPPING_CART_KEY, JSON.stringify(items));
}

interface AppStore {
  // Recipes
  recipes: Recipe[];
  setRecipes: (r: Recipe[]) => void;
  removeRecipe: (id: string) => void;

  // Sync
  sync: SyncState;
  setSyncPeers: (peers: any[]) => void;
  setSyncConflicts: (c: any[]) => void;

  // UI
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // i18n: the language used to fetch translated recipe/ingredient content
  // (separate from the UI chrome locale, though they're set together today)
  contentLang: string;
  setContentLang: (lang: string) => void;

  // Shopping list "cart": a temporary, unsaved set of recipes (+ servings)
  // the user is building up — from the recipe page or the shopping list
  // page itself — before generating an aggregated shopping list from it.
  // Persisted to localStorage so it survives navigation/reload but never
  // touches the backend until "Generate" is pressed.
  shoppingCart: ShoppingCartItem[];
  addToShoppingCart: (item: ShoppingCartItem) => void;
  removeFromShoppingCart: (recipeId: string) => void;
  updateShoppingCartServings: (recipeId: string, servings: number) => void;
  clearShoppingCart: () => void;
}

export const useStore = create<AppStore>((set) => ({
  recipes: [],
  setRecipes: (recipes) => set({ recipes }),
  removeRecipe: (id) =>
    set((s) => ({ recipes: s.recipes.filter((r) => r.id !== id) })),

  sync: { peers: [], conflicts: [] },
  setSyncPeers: (peers) => set((s) => ({ sync: { ...s.sync, peers } })),
  setSyncConflicts: (conflicts) =>
    set((s) => ({ sync: { ...s.sync, conflicts, lastSync: new Date() } })),

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // Defaults to "en" to match i18n's own default UI locale (src/i18n/index.ts)
  // — otherwise the chrome reads English on first visit while every
  // ingredient/unit/category name still shows its untranslated base value.
  contentLang: localStorage.getItem("smartchef.contentLang") || "en",
  setContentLang: (lang) => {
    localStorage.setItem("smartchef.contentLang", lang);
    set({ contentLang: lang });
  },

  shoppingCart: loadShoppingCart(),
  addToShoppingCart: (item) =>
    set((s) => {
      const exists = s.shoppingCart.some((c) => c.recipeId === item.recipeId);
      const next = exists
        ? s.shoppingCart.map((c) => (c.recipeId === item.recipeId ? item : c))
        : [...s.shoppingCart, item];
      saveShoppingCart(next);
      return { shoppingCart: next };
    }),
  removeFromShoppingCart: (recipeId) =>
    set((s) => {
      const next = s.shoppingCart.filter((c) => c.recipeId !== recipeId);
      saveShoppingCart(next);
      return { shoppingCart: next };
    }),
  updateShoppingCartServings: (recipeId, servings) =>
    set((s) => {
      const next = s.shoppingCart.map((c) => (c.recipeId === recipeId ? { ...c, servings } : c));
      saveShoppingCart(next);
      return { shoppingCart: next };
    }),
  clearShoppingCart: () => {
    saveShoppingCart([]);
    set({ shoppingCart: [] });
  },
}));
