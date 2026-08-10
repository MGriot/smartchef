// ════════════════════════════════════════════════════════════════════════
// SmartChef Frontend — API Service
// ════════════════════════════════════════════════════════════════════════

const BASE = "/api";

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json().then((d) => d.data ?? d);
}

// ── Recipes ────────────────────────────────────────────────────────────

export const recipesApi = {
  list: (params?: { q?: string; tag?: string; difficulty?: string }) => {
    const qs = params ? "?" + new URLSearchParams(params as any).toString() : "";
    return req<any[]>(`/recipes${qs}`);
  },
  get: (id: string) => req<any>(`/recipes/${id}`),
  create: (body: unknown) => req<{ id: string }>("/recipes", {
    method: "POST", body: JSON.stringify(body),
  }),
  update: (id: string, body: unknown) => req<any>(`/recipes/${id}`, {
    method: "PUT", body: JSON.stringify(body),
  }),
  delete: (id: string) => req<void>(`/recipes/${id}`, { method: "DELETE" }),
  portions: (id: string, servings: number) =>
    req<any>(`/recipes/${id}/portions?servings=${servings}`),
};

// ── LLM ────────────────────────────────────────────────────────────────

export const llmApi = {
  parse: (input: string, inputType: "url" | "text") =>
    req<any>("/llm/parse", {
      method: "POST", body: JSON.stringify({ input, inputType }),
    }),
  confirm: (body: unknown) => req<{ id: string; title: string }>("/llm/confirm", {
    method: "POST", body: JSON.stringify(body),
  }),
  health: () => req<{ ok: boolean; models: string[] }>("/llm/health"),
};

// ── Menus ──────────────────────────────────────────────────────────────

export const menuApi = {
  list: () => req<any[]>("/menus"),
  get: (id: string) => req<any>(`/menus/${id}`),
  create: (body: unknown) => req<any>("/menus", {
    method: "POST", body: JSON.stringify(body),
  }),
  addItem: (menuId: string, body: unknown) =>
    req<any>(`/menus/${menuId}/items`, {
      method: "POST", body: JSON.stringify(body),
    }),
  removeItem: (menuId: string, itemId: string) =>
    req<void>(`/menus/${menuId}/items/${itemId}`, { method: "DELETE" }),
};

// ── Shopping ───────────────────────────────────────────────────────────

export const shoppingApi = {
  generate: (menuId: string, listName: string) =>
    req<any>("/shopping/generate", {
      method: "POST", body: JSON.stringify({ menuId, listName }),
    }),
  get: (id: string) => req<any>(`/shopping/${id}`),
  exportMarkdown: (id: string) =>
    fetch(`${BASE}/shopping/${id}/export`).then((r) => r.text()),
  checkItem: (listId: string, itemId: string, checked: boolean) =>
    req<void>(`/shopping/${listId}/items/${itemId}/check`, {
      method: "PATCH", body: JSON.stringify({ checked }),
    }),
};

// ── Sync ───────────────────────────────────────────────────────────────

export const syncApi = {
  peers: () => req<any[]>("/sync/peers"),
  clock: () => req<any>("/sync/clock"),
  conflicts: () => req<any[]>("/sync/conflicts"),
  trigger: (deviceId: string) =>
    req<any>(`/sync/trigger/${deviceId}`, { method: "POST" }),
  resolve: (body: unknown) =>
    req<void>("/sync/resolve", { method: "POST", body: JSON.stringify(body) }),
};

// ── Ingredients ────────────────────────────────────────────────────────

export const ingredientsApi = {
  list: (q?: string) => req<any[]>(`/ingredients${q ? `?q=${q}` : ""}`),
  categories: () => req<any[]>("/ingredients/categories"),
};

// ── Units ─────────────────────────────────────────────────────────────

export const unitsApi = {
  list: () => req<any[]>("/units"),
};
