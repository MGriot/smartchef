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

// Persisted alongside the server URL so a previously-logged-in user isn't
// locked out of their offline-cached data just because the server (and
// therefore the httpOnly session cookie check) is unreachable — there's no
// way to validate the real session offline, so this is "was authenticated
// last time we could ask", not a real credential.
export interface CachedAccount { name: string; avatarUrl?: string }

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
    return jsonResponse({ data: { hasAccount: true, authenticated: true, name: account.name, avatarUrl: account.avatarUrl } });
  }

  const { getCachedEntities } = await import('./offlineStore');

  if (segments[0] === 'recipes') {
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

/** Drop-in replacement for `fetch(path, init)` against `/api/...` paths. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!isNative()) {
    return fetch(path, init);
  }
  const base = await getServerUrl();
  if (!base) {
    throw new Error('No server configured — connect to your SmartChef server first.');
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  try {
    return await fetch(`${base}${path}`, { ...init, credentials: 'include', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    if (method === 'GET') {
      const cached = await tryServeFromCache(path);
      if (cached) return cached;
      throw err;
    }
    // Not a GET — queue it instead of losing the edit. Applied optimistically
    // by the caller (pages already update their own local state on submit);
    // this just makes sure it eventually reaches the server too.
    const { queueOperation } = await import('./offlineStore');
    await queueOperation(method, path, init?.body ? JSON.parse(init.body as string) : undefined);
    return jsonResponse({ data: { queuedOffline: true } }, 202);
  }
}
