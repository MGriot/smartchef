// ════════════════════════════════════════════════════════════════════════
// SmartChef — API fetch wrapper
// On web (the existing PWA/desktop deployment) this is a pure passthrough
// to `fetch` — relative `/api/...` paths, same origin, zero behavior
// change. On native (Capacitor), there's no same-origin server to proxy
// through — the app bundle runs from `capacitor://localhost` — so calls
// get prefixed with the server URL the user configured in the connect
// screen, plus `credentials: 'include'` so the session cookie attaches to
// the cross-origin request.
//
// Also where native offline behavior plugs in: a network failure on a GET
// falls back to the local SQLite cache (see offlineStore.ts); a network
// failure on a write queues it in the local outbox instead of losing it,
// to be replayed once connectivity returns (see offlineSync.ts).
// ════════════════════════════════════════════════════════════════════════

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const SERVER_URL_KEY = 'smartchef.serverUrl';
const ACCOUNT_CACHE_KEY = 'smartchef.cachedAccount';
// Set the first time anyone actually gets *in* on this device. Gates the
// "change where this device keeps your library" escape hatch on the
// login/profile screens: offering it is right while someone is still
// setting the device up and may have picked the wrong option, and wrong
// afterward — past first run, moving the library is an admin decision made
// in Settings (Account.tsx's StorageModeCard), not a question every
// sign-out re-opens.
const DEVICE_ONBOARDED_KEY = 'smartchef.deviceOnboarded';

let cachedServerUrl: string | null | undefined; // undefined = not loaded yet

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export async function getServerUrl(): Promise<string | null> {
  if (cachedServerUrl !== undefined) return cachedServerUrl;
  const { value } = await Preferences.get({ key: SERVER_URL_KEY });
  cachedServerUrl = value ?? null;
  return cachedServerUrl;
}

export async function setServerUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/+$/, '');
  cachedServerUrl = trimmed;
  await Preferences.set({ key: SERVER_URL_KEY, value: trimmed });
}

export async function clearServerUrl(): Promise<void> {
  cachedServerUrl = null;
  await Preferences.remove({ key: SERVER_URL_KEY });
}

export async function isDeviceOnboarded(): Promise<boolean> {
  const { value } = await Preferences.get({ key: DEVICE_ONBOARDED_KEY });
  return value === 'true';
}

export async function markDeviceOnboarded(): Promise<void> {
  await Preferences.set({ key: DEVICE_ONBOARDED_KEY, value: 'true' });
}

/** Back to the first-run "server or offline?" chooser, WITHOUT deleting
 *  anything: the local SQLite library, any Sync Folder wiring and the
 *  server's own data all stay exactly as they are, so picking the same
 *  option again lands back on the same library. */
export async function resetDeviceStorageChoice(): Promise<void> {
  await clearServerUrl();
  const { clearStandaloneProfile } = await import('./standalone');
  await clearStandaloneProfile();
}

// Persisted alongside the server URL so a previously-logged-in user isn't
// locked out of their offline-cached data just because the server (and
// therefore the httpOnly session cookie check) is unreachable — there's no
// way to validate the real session offline, so this is "was authenticated
// last time we could ask", not a real credential.
export interface CachedAccount { id: string; username: string; name: string; role: "admin" | "user"; avatarUrl?: string }

export async function cacheAccountOffline(account: CachedAccount): Promise<void> {
  await Preferences.set({ key: ACCOUNT_CACHE_KEY, value: JSON.stringify(account) });
}

export async function getCachedAccountOffline(): Promise<CachedAccount | null> {
  const { value } = await Preferences.get({ key: ACCOUNT_CACHE_KEY });
  return value ? JSON.parse(value) : null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Best-effort local fallback for a GET that couldn't reach the server. */
async function tryServeFromCache(path: string): Promise<Response | null> {
  const [pathname] = path.split('?');
  const segments = pathname.replace(/^\/api\//, '').split('/');

  if (pathname === '/api/auth/status') {
    const account = await getCachedAccountOffline();
    if (!account) return null;
    return jsonResponse({ data: { hasAccount: true, authenticated: true, id: account.id, username: account.username, name: account.name, role: account.role, avatarUrl: account.avatarUrl } });
  }

  const { getCachedEntities, getDownloadedRecipe } = await import('./offlineStore');

  if (segments[0] === 'recipes') {
    if (segments[1] && !segments[2]) {
      // A specific recipe's detail page: prefer the full ingredients/steps/
      // tools bundle from an explicit offline download (see
      // downloadRecipeOffline()) over the whole-library snapshot cache,
      // which only ever holds list-view summary fields for a recipe, not
      // its full detail — falling back to that would render an empty/broken
      // detail page for a recipe that was never individually downloaded.
      const downloaded = await getDownloadedRecipe(segments[1]);
      if (downloaded) return jsonResponse({ data: downloaded });
    }
    const recipes = await getCachedEntities('recipes');
    if (segments[1]) {
      const recipe = recipes.find((r: any) => r.id === segments[1]);
      return recipe ? jsonResponse({ data: recipe }) : jsonResponse({ error: 'Not found (offline)' }, 404);
    }
    return jsonResponse({ data: recipes.filter((r: any) => !r.deletedAt), total: recipes.length });
  }
  if (segments[0] === 'ingredients') {
    if (segments[1] === 'categories') {
      const categories = await getCachedEntities('categories');
      return jsonResponse({ data: categories.filter((c: any) => !c.deletedAt) });
    }
    const ingredients = await getCachedEntities('ingredients');
    return jsonResponse({ data: ingredients.filter((i: any) => !i.deletedAt) });
  }
  if (segments[0] === 'tags') {
    const tags = await getCachedEntities('tags');
    return jsonResponse({ data: tags.filter((t: any) => !t.deletedAt) });
  }
  if (segments[0] === 'tools') {
    const tools = await getCachedEntities('tools');
    return jsonResponse({ data: tools.filter((t: any) => !t.deletedAt) });
  }
  if (segments[0] === 'techniques') {
    const techniques = await getCachedEntities('techniques');
    return jsonResponse({ data: techniques.filter((t: any) => !t.deletedAt) });
  }
  if (segments[0] === 'collections') {
    const collections = await getCachedEntities('collections');
    if (segments[1]) {
      const collection = collections.find((c: any) => c.id === segments[1]);
      if (!collection) return jsonResponse({ error: 'Not found (offline)' }, 404);
      const recipes = await getCachedEntities('recipes');
      const memberRecipes = collection.recipeIds
        .map((id: string) => recipes.find((r: any) => r.id === id))
        .filter(Boolean);
      return jsonResponse({ data: { ...collection, recipes: memberRecipes } });
    }
    return jsonResponse({ data: collections.filter((c: any) => !c.deletedAt) });
  }

  return null;
}

// Top-level create endpoints that support offline queuing with an
// optimistic cache entry. Shapes match the camelCase snapshot format the
// cache already stores (see folder-sync.service.ts's Snapshot* interfaces
// server-side) — not the snake_case shape GET /api/... returns online —
// since that's what tryServeFromCache() above serves back while offline.
const OFFLINE_CREATABLE_ENTITIES: Record<string, { entityType: import('./offlineStore').EntityType; toCacheRecord: (body: any) => any }> = {
  recipes: {
    entityType: 'recipes',
    toCacheRecord: (b) => ({
      id: b.id, title: b.title, description: b.description ?? null,
      coverImageUrl: b.coverImageUrl ?? null, prepTimeMin: b.prepTimeMin ?? null,
      cookTimeMin: b.cookTimeMin ?? null, restTimeMin: b.restTimeMin ?? null,
      difficulty: b.difficulty ?? 'medium', rating: b.rating ?? null, timesCooked: 0,
      tags: b.tags ?? [], isComponent: b.isComponent ?? false,
      updatedAt: new Date().toISOString(), deletedAt: null,
    }),
  },
  ingredients: {
    entityType: 'ingredients',
    toCacheRecord: (b) => ({
      id: b.id, name: b.name, categoryId: b.categoryId ?? null, description: b.description ?? null,
      icon: b.icon ?? null, imageUrls: b.imageUrls ?? [],
      updatedAt: new Date().toISOString(), deletedAt: null,
    }),
  },
};

/** Drop-in replacement for `fetch(path, init)` against `/api/...` paths.
 *  `timeoutMs` (native only) overrides the default 10s abort — pass a much
 *  larger value for slow endpoints (e.g. LLM recipe parsing, which the
 *  backend itself allows up to 10 minutes for). */
export async function apiFetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  if (isNative()) {
    const { isStandaloneMode } = await import('./standalone');
    if (await isStandaloneMode()) {
      const { dispatchLocal } = await import('../services/localRouter');
      const result = await dispatchLocal(path, init);
      if (result) {
        return jsonResponse(result.error ? { error: result.error } : { data: result.data }, result.status);
      }
      // Not a path this stage's local router owns (e.g. /api/tags) — falls
      // through to the pre-existing native/offline logic below, unaffected.
    }
  }

  if (!isNative()) {
    return fetch(path, init);
  }
  const base = await getServerUrl();
  if (!base) {
    throw new Error('No server configured — connect to your SmartChef server first.');
  }

  const { timeoutMs = 10_000, ...fetchInit } = init ?? {};
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  try {
    return await fetch(`${base}${path}`, { ...fetchInit, credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (method === 'GET') {
      const cached = await tryServeFromCache(path);
      if (cached) return cached;
      throw err;
    }
    // Not a GET — queue it instead of losing the edit. Applied optimistically
    // by the caller (pages already update their own local state on submit);
    // this just makes sure it eventually reaches the server too.
    const { queueOperation, upsertCachedEntity } = await import('./offlineStore');
    const body = fetchInit.body ? JSON.parse(fetchInit.body as string) : undefined;

    // A top-level POST (creating a new recipe/ingredient, not e.g.
    // POST /recipes/:id/cooked) needs a real id handed back immediately —
    // callers navigate to /recipe/:id right after create — so generate one
    // client-side, both for the queued request (the backend accepts an
    // optional client-supplied id) and for an optimistic cache entry so the
    // new item shows up in list views before the outbox even replays.
    if (method === 'POST' && body && !body.id) {
      const [pathname] = path.split('?');
      const segments = pathname.replace(/^\/api\//, '').split('/');
      const creatable = segments.length === 1 ? OFFLINE_CREATABLE_ENTITIES[segments[0]] : undefined;
      if (creatable) {
        body.id = crypto.randomUUID();
        await upsertCachedEntity(creatable.entityType, creatable.toCacheRecord(body));
      }
    }

    await queueOperation(method, path, body);
    return jsonResponse({ data: { id: body?.id, queuedOffline: true } }, 202);
  }
}
