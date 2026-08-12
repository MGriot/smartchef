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

// contentLang/shoppingCart are per-account now that multiple people can use
// the same instance/device — the bare (unsuffixed) keys are only the
// pre-login bootstrap default, read once before an account is known.
function contentLangKey(accountId?: string) {
  return accountId ? `smartchef.${accountId}.contentLang` : "smartchef.contentLang";
}
function shoppingCartKey(accountId?: string) {
  return accountId ? `smartchef.${accountId}.shoppingCart` : "smartchef.shoppingCart";
}

function loadShoppingCart(key: string): ShoppingCartItem[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function saveShoppingCart(key: string, items: ShoppingCartItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
}

export interface Account {
  id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  avatarUrl?: string;
}

interface AppStore {
  // Recipes
  recipes: Recipe[];
  setRecipes: (r: Recipe[]) => void;
  removeRecipe: (id: string) => void;

  // Auth: the currently logged-in user on this device/browser.
  account: Account | null;
  setAccount: (a: Account | null) => void;

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

export const useStore = create<AppStore>((set, get) => ({
  recipes: [],
  setRecipes: (recipes) => set({ recipes }),
  removeRecipe: (id) =>
    set((s) => ({ recipes: s.recipes.filter((r) => r.id !== id) })),

  account: null,
  setAccount: (account) => {
    if (!account) return set({ account: null });
    // First login on this device: inherit the pre-login default language
    // once, then persist under this account's own key from then on. The
    // shopping cart is deliberately NOT inherited from the bare key —
    // it could belong to whoever was last using this browser/device.
    const langKey = contentLangKey(account.id);
    const contentLang = localStorage.getItem(langKey) || get().contentLang;
    localStorage.setItem(langKey, contentLang);
    const cartKey = shoppingCartKey(account.id);
    const shoppingCart = loadShoppingCart(cartKey);
    set({ account, contentLang, shoppingCart });
  },

  sync: { peers: [], conflicts: [] },
  setSyncPeers: (peers) => set((s) => ({ sync: { ...s.sync, peers } })),
  setSyncConflicts: (conflicts) =>
    set((s) => ({ sync: { ...s.sync, conflicts, lastSync: new Date() } })),

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // Defaults to "en" to match i18n's own default UI locale (src/i18n/index.ts)
  // — otherwise the chrome reads English on first visit while every
  // ingredient/unit/category name still shows its untranslated base value.
  contentLang: localStorage.getItem(contentLangKey()) || "en",
  setContentLang: (lang) => {
    localStorage.setItem(contentLangKey(get().account?.id), lang);
    set({ contentLang: lang });
  },

  shoppingCart: loadShoppingCart(shoppingCartKey()),
  addToShoppingCart: (item) =>
    set((s) => {
      const exists = s.shoppingCart.some((c) => c.recipeId === item.recipeId);
      const next = exists
        ? s.shoppingCart.map((c) => (c.recipeId === item.recipeId ? item : c))
        : [...s.shoppingCart, item];
      saveShoppingCart(shoppingCartKey(get().account?.id), next);
      return { shoppingCart: next };
    }),
  removeFromShoppingCart: (recipeId) =>
    set((s) => {
      const next = s.shoppingCart.filter((c) => c.recipeId !== recipeId);
      saveShoppingCart(shoppingCartKey(get().account?.id), next);
      return { shoppingCart: next };
    }),
  updateShoppingCartServings: (recipeId, servings) =>
    set((s) => {
      const next = s.shoppingCart.map((c) => (c.recipeId === recipeId ? { ...c, servings } : c));
      saveShoppingCart(shoppingCartKey(get().account?.id), next);
      return { shoppingCart: next };
    }),
  clearShoppingCart: () => {
    saveShoppingCart(shoppingCartKey(get().account?.id), []);
    set({ shoppingCart: [] });
  },
}));
