// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone-mode local router
// A tiny in-process "router" that apiFetch (lib/api.ts) calls into instead
// of making an HTTP request, when standalone mode is active and the path
// falls under /api/recipes* or /api/ingredients*|/units*|/tools*|/tags*|/techniques* —
// the narrow slice ported in this stage. Every other path returns `undefined`
// (not handled here) so the caller's existing native/offline logic keeps
// owning it unchanged, exactly as before standalone mode existed.
// ════════════════════════════════════════════════════════════════════════

import * as recipes from './recipes.local';
import * as ingredients from './ingredients.local';
import * as tags from './tags.local';
import * as techniques from './techniques.local';
import * as share from './share.local';
import { importSnapshot, exportSnapshot } from './backup.local';
import * as shopping from './shopping.local';
import * as menus from './menus.local';
import * as collections from './collections.local';
import * as pantry from './pantry.local';
import { getStandaloneProfile } from '../lib/standalone';
import { electronGeocode, isElectron } from '../lib/electronBridge';
import { androidGeocode } from '../lib/gitHttpBridge';

export interface LocalDispatchResult {
  status: number;
  data?: unknown;
  error?: string;
}

const NOT_HANDLED = Symbol('not-handled');

function parseBody(init?: RequestInit): any {
  if (!init?.body) return undefined;
  return typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
}

function segmentsAndQuery(path: string): { segments: string[]; searchParams: URLSearchParams } {
  const [pathname, qs] = path.split('?');
  const segments = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  return { segments, searchParams: new URLSearchParams(qs ?? '') };
}

async function dispatchRecipes(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id, sub, sub2] = segments; // segments[0] === 'recipes'

  // Collection endpoints, which are a verb in the id position rather than a
  // recipe id. These MUST be matched before the id-based branches below:
  // /api/recipes/filter-by-pantry has only two segments, so `sub` is
  // undefined and the `if (!sub)` block claims it first. The `parse` case
  // was already sitting below that block and had been unreachable —
  // callers got the generic "not available offline" message instead of the
  // specific one explaining that Smart Import needs a server-side LLM.
  if (id === 'filter-by-pantry' && method === 'POST') {
    const body = parseBody(init) ?? {};
    const items = Array.isArray(body.ingredients) ? body.ingredients : [];
    if (items.length === 0) return { status: 400, error: 'Add something to the pantry first.' };
    return { status: 200, data: await pantry.filterByPantry(items, body.minMatchRatio ?? 1) };
  }
  if (id === 'parse') {
    return { status: 501, error: `Smart Import needs a server-configured LLM provider — not available in offline mode yet.` };
  }

  if (!id) {
    if (method === 'GET') {
      const result = await recipes.listRecipes(Object.fromEntries(sp) as any);
      return { status: 200, data: result.data };
    }
    if (method === 'POST') {
      const profile = await getStandaloneProfile();
      const created = await recipes.createRecipe(parseBody(init), profile?.name ?? null);
      return { status: 201, data: created };
    }
    return NOT_HANDLED;
  }

  if (!sub) {
    if (method === 'GET') {
      const recipe = await recipes.getRecipe(id, sp.get('lang') ?? undefined);
      if (!recipe) return { status: 404, error: 'Ricetta non trovata' };
      return { status: 200, data: recipe };
    }
    if (method === 'PUT') {
      const updated = await recipes.updateRecipe(id, parseBody(init));
      return { status: 200, data: updated };
    }
    if (method === 'DELETE') {
      await recipes.deleteRecipe(id);
      return { status: 204 };
    }
    return NOT_HANDLED;
  }

  if (sub === 'portions' && method === 'GET') {
    const servings = parseInt(sp.get('servings') ?? '4', 10);
    return { status: 200, data: await recipes.getPortions(id, servings) };
  }
  if (sub === 'cook-sequence' && method === 'GET') {
    return { status: 200, data: await recipes.getCookSequenceFor(id) };
  }
  if (sub === 'rating' && method === 'PATCH') {
    const body = parseBody(init);
    await recipes.patchRating(id, body.rating ?? null);
    return { status: 200, data: { success: true } };
  }
  if (sub === 'cooked' && method === 'POST') {
    const profile = await getStandaloneProfile();
    const result = await recipes.logCooked(id, profile?.name ?? null);
    if (!result) return { status: 404, error: 'Recipe not found' };
    return { status: 200, data: result };
  }
  if (sub === 'nutrition' || sub === 'translate' || sub === 'collections') {
    return { status: 501, error: `"${sub}" isn't available in offline mode yet — connect to a server to use it.` };
  }
  void sub2;
  return NOT_HANDLED;
}

async function dispatchIngredients(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, first, second] = segments; // segments[0] === 'ingredients'

  if (first === 'categories') {
    if (!second) {
      if (method === 'GET') return { status: 200, data: await ingredients.listCategories({ lang: sp.get('lang') ?? undefined }) };
      if (method === 'POST') return { status: 200, data: await ingredients.createCategory(parseBody(init)) };
    } else if (second === 'reorder' && method === 'PUT') {
      const ids: string[] = Array.isArray(parseBody(init)?.ids) ? parseBody(init).ids : [];
      if (ids.length === 0) return { status: 400, error: 'ids is required' };
      await ingredients.reorderCategories(ids);
      return { status: 200, data: { success: true } };
    } else {
      if (method === 'PUT') { await ingredients.updateCategory(second, parseBody(init)); return { status: 200, data: { success: true } }; }
      if (method === 'DELETE') { await ingredients.deleteCategory(second); return { status: 200, data: { success: true } }; }
    }
    return NOT_HANDLED;
  }

  if (!first) {
    if (method === 'GET') return { status: 200, data: await ingredients.listIngredients({ q: sp.get('q') ?? undefined, lang: sp.get('lang') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await ingredients.createIngredient(parseBody(init)) };
    return NOT_HANDLED;
  }

  if (second === 'merge' && method === 'POST') {
    const body = parseBody(init);
    return { status: 200, data: await ingredients.mergeIngredients(first, body.targetId) };
  }

  if (method === 'PUT') { await ingredients.updateIngredient(first, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await ingredients.deleteIngredient(first); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

async function dispatchUnits(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await ingredients.listUnits({ lang: sp.get('lang') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await ingredients.createUnit(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await ingredients.updateUnit(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await ingredients.deleteUnit(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

async function dispatchTools(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await ingredients.listTools({ lang: sp.get('lang') ?? undefined, q: sp.get('q') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await ingredients.createTool(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await ingredients.updateTool(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await ingredients.deleteTool(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

async function dispatchTags(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id, sub] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await tags.listTags({ lang: sp.get('lang') ?? undefined, q: sp.get('q') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await tags.createTag(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (id === 'custom') {
    if (!sub && method === 'GET') return { status: 200, data: await tags.listCustomTagsInUse() };
    if (sub === 'merge' && method === 'POST') {
      const body = parseBody(init);
      return { status: 200, data: await tags.mergeCustomTagIntoTag(body.name, body.targetTagId) };
    }
    if (sub === 'delete' && method === 'POST') {
      const body = parseBody(init);
      return { status: 200, data: await tags.deleteCustomTag(body.name) };
    }
    return NOT_HANDLED;
  }
  if (id === 'groups') {
    if (sub === 'merge' && method === 'POST') {
      const body = parseBody(init);
      return { status: 200, data: await tags.mergeTagGroups(body.sourceGroup, body.targetGroup) };
    }
    return NOT_HANDLED;
  }
  if (sub === 'merge' && method === 'POST') {
    const body = parseBody(init);
    return { status: 200, data: await tags.mergeTags(id, body.targetId) };
  }
  if (method === 'PUT') { await tags.updateTag(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { return { status: 200, data: await tags.deleteTag(id) }; }
  return NOT_HANDLED;
}

async function dispatchTechniques(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await techniques.listTechniques({ lang: sp.get('lang') ?? undefined, q: sp.get('q') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await techniques.createTechnique(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await techniques.updateTechnique(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await techniques.deleteTechnique(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

/** Whole-library backup export/import — see backup.local.ts. The Backup &
 *  Restore card (Account.tsx) is exactly as useful standalone as it is in
 *  server mode: a portable snapshot to save wherever you like or move to
 *  another device, independent of whether Folder Sync is even set up. */
async function dispatchBackup(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, action] = segments;
  if (action === 'export' && method === 'GET') {
    return { status: 200, data: await exportSnapshot() };
  }
  if (action === 'import' && method === 'POST') {
    const summary = await importSnapshot(parseBody(init));
    return { status: 200, data: summary };
  }
  return NOT_HANDLED;
}

/** Standalone-mode equivalent of backend/src/routes/geocode.ts. Electron
 *  routes the Nominatim request through its main process (Node's fetch,
 *  not subject to CORS or the WebView's header restrictions — see
 *  lib/electronBridge.ts's electronGeocode()); Android routes it through
 *  the same GitHttpPlugin native request gitRemoteTransport.ts already
 *  uses for git servers (see lib/gitHttpBridge.ts's androidGeocode()) —
 *  neither is a browser fetch(), so both can set the User-Agent header
 *  Nominatim's usage policy requires, which a plain renderer fetch()
 *  can't. Either way, no match/any failure resolves to null, which
 *  RegionPicker.tsx/RegionsMap.tsx already treat as "not geocoded yet,"
 *  not an error. */
/** Only the export half of backend/src/routes/share.ts is ported — see
 *  share.local.ts's header. Import and collection export fall through to
 *  the NOT_HANDLED branch, which answers with a clear "not available
 *  offline yet" rather than trying to reach a server that isn't there. */
async function dispatchShare(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, kind, id, action] = segments; // segments[0] === 'share'

  if (kind === 'recipes' && id === 'export-bulk' && method === 'POST') {
    const body = parseBody(init);
    const recipeIds: string[] = Array.isArray(body?.recipeIds) ? body.recipeIds : [];
    if (recipeIds.length === 0) return { status: 400, error: 'recipeIds is required' };
    return { status: 200, data: await share.exportRecipesBulk(recipeIds) };
  }

  if (kind === 'recipes' && id && action === 'export' && method === 'GET') {
    const bundle = await share.exportRecipe(id);
    if (!bundle) return { status: 404, error: 'Ricetta non trovata' };
    return { status: 200, data: bundle };
  }

  return NOT_HANDLED;
}

/** The pantry — see pantry.local.ts. */
async function dispatchPantry(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments; // segments[0] === 'pantry'

  if (!id) {
    if (method === 'GET') return { status: 200, data: await pantry.listPantry() };
    if (method === 'PUT') {
      const body = parseBody(init) ?? {};
      if (!body.ingredientId) return { status: 400, error: 'An ingredient is required.' };
      return { status: 200, data: await pantry.putPantryItem(body) };
    }
    return NOT_HANDLED;
  }
  if (method === 'DELETE') {
    await pantry.deletePantryItem(id);
    return { status: 200, data: { success: true } };
  }
  return NOT_HANDLED;
}

/** Recipe collections — see collections.local.ts. */
async function dispatchCollections(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id, sub, recipeId] = segments; // segments[0] === 'collections'

  if (!id) {
    if (method === 'GET') return { status: 200, data: await collections.listCollections() };
    if (method === 'POST') {
      const body = parseBody(init) ?? {};
      if (!body.name) return { status: 400, error: 'A name is required.' };
      return { status: 201, data: await collections.createCollection(body) };
    }
    return NOT_HANDLED;
  }

  if (!sub) {
    if (method === 'GET') {
      const found = await collections.getCollection(id);
      return found ? { status: 200, data: found } : { status: 404, error: 'Collection not found' };
    }
    if (method === 'PUT') {
      const body = parseBody(init) ?? {};
      if (!body.name) return { status: 400, error: 'A name is required.' };
      const ok = await collections.updateCollection(id, body);
      return ok ? { status: 200, data: { success: true } } : { status: 404, error: 'Collection not found' };
    }
    if (method === 'DELETE') {
      const ok = await collections.deleteCollection(id);
      return ok ? { status: 200, data: { success: true } } : { status: 404, error: 'Collection not found' };
    }
    return NOT_HANDLED;
  }

  if (sub === 'recipes') {
    if (!recipeId && method === 'POST') {
      const body = parseBody(init) ?? {};
      if (!body.recipeId) return { status: 400, error: 'A recipe is required.' };
      const ok = await collections.addRecipeToCollection(id, body.recipeId);
      return ok ? { status: 201, data: { success: true } } : { status: 404, error: 'Collection not found' };
    }
    if (recipeId && method === 'DELETE') {
      await collections.removeRecipeFromCollection(id, recipeId);
      return { status: 200, data: { success: true } };
    }
  }

  return NOT_HANDLED;
}

/** Cook history read side — see collections.local.ts's listCookLog(). */
async function dispatchCookLog(method: string, sp: URLSearchParams): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  if (method !== 'GET') return NOT_HANDLED;
  return { status: 200, data: await collections.listCookLog(sp.get('from'), sp.get('to')) };
}

/** Weekly menus / the Planner — see menus.local.ts. */
async function dispatchMenus(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, menuId, sub, itemId] = segments; // segments[0] === 'menus'

  if (!menuId) {
    if (method === 'GET') return { status: 200, data: await menus.listMenus() };
    if (method === 'POST') {
      const body = parseBody(init) ?? {};
      if (!body.name || !body.weekStart) return { status: 400, error: 'A name and a week start are required.' };
      return { status: 201, data: await menus.createMenu(body) };
    }
    return NOT_HANDLED;
  }

  if (!sub) {
    if (method === 'GET') {
      const menu = await menus.getMenu(menuId);
      return menu ? { status: 200, data: menu } : { status: 404, error: 'Menu not found' };
    }
    if (method === 'DELETE') { await menus.deleteMenu(menuId); return { status: 200, data: { success: true } }; }
    return NOT_HANDLED;
  }

  if (sub === 'nutrition' && method === 'GET') {
    return { status: 200, data: await menus.menuNutrition(menuId) };
  }

  if (sub === 'items') {
    if (!itemId && method === 'POST') {
      const body = parseBody(init) ?? {};
      if (!body.recipeId || typeof body.dayOfWeek !== 'number') {
        return { status: 400, error: 'A recipe and a day are required.' };
      }
      const created = await menus.addMenuItem(menuId, body);
      return created ? { status: 201, data: created } : { status: 404, error: 'Menu not found' };
    }
    if (itemId && method === 'PATCH') {
      const ok = await menus.updateMenuItem(menuId, itemId, parseBody(init) ?? {});
      return ok ? { status: 200, data: { success: true } } : { status: 404, error: 'Item not found' };
    }
    if (itemId && method === 'DELETE') {
      await menus.removeMenuItem(menuId, itemId);
      return { status: 200, data: { success: true } };
    }
  }

  return NOT_HANDLED;
}

/** Shopping lists — see shopping.local.ts.
 *
 *  The menu-backed half of the server's POST /shopping/generate is
 *  deliberately not ported: menus live in /api/menus, which has no local
 *  implementation, so there are never any menus to generate from in
 *  standalone mode. A menuId body reaches the explicit 501 below rather
 *  than silently producing an empty list. */
async function dispatchShopping(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, first, second, itemId, action] = segments; // segments[0] === 'shopping'

  if (!first) {
    if (method === 'GET') return { status: 200, data: await shopping.listShoppingLists() };
    return NOT_HANDLED;
  }

  if (first === 'generate' && method === 'POST') {
    const body = parseBody(init) ?? {};
    // Either source resolves to the same {recipeId, servings}[] the
    // aggregator takes — a menu is just a saved set of those.
    const recipes: Array<{ recipeId: string; servings: number }> = body.menuId
      ? await menus.menuRecipesForShopping(body.menuId)
      : Array.isArray(body.recipes) ? body.recipes : [];
    if (recipes.length === 0) {
      return { status: 400, error: body.menuId ? 'That menu has no recipes planned yet.' : 'Pick at least one recipe first.' };
    }
    const listName = typeof body.listName === 'string' && body.listName.trim() ? body.listName.trim() : 'Shopping List';
    return { status: 201, data: await shopping.generateShoppingList(recipes, listName, body.menuId ?? null) };
  }

  // /shopping/:listId/items/:itemId/check
  if (second === 'items' && itemId && action === 'check' && method === 'PATCH') {
    const body = parseBody(init) ?? {};
    const ok = await shopping.setItemChecked(first, itemId, !!body.checked);
    return ok ? { status: 200, data: { ok: true } } : { status: 404, error: 'Item not found' };
  }

  if (second === 'export' && method === 'GET') {
    const list = await shopping.loadShoppingList(first);
    if (!list) return { status: 404, error: 'Shopping list not found' };
    return { status: 200, data: { markdown: shopping.exportShoppingListMarkdown(list) } };
  }

  if (!second && method === 'GET') {
    const list = await shopping.loadShoppingList(first);
    if (!list) return { status: 404, error: 'Shopping list not found' };
    return { status: 200, data: list };
  }

  if (!second && method === 'DELETE') {
    const ok = await shopping.deleteShoppingList(first);
    return ok ? { status: 200, data: { success: true } } : { status: 404, error: 'Shopping list not found' };
  }

  return NOT_HANDLED;
}

async function dispatchGeocode(sp: URLSearchParams): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const q = sp.get('q');
  if (!q) return { status: 400, error: 'Missing q' };
  const result = isElectron() ? await electronGeocode(q) : await androidGeocode(q);
  if (!result) return { status: 404, error: 'No match found' };
  return { status: 200, data: result };
}

/** Returns `null` when `path` isn't under a prefix this stage owns at all
 *  (caller should fall through to its existing native-server/offline-cache
 *  behavior, unaffected). Returns a result object — possibly a 501 "not
 *  available offline yet" — for anything under /api/recipes*,
 *  /api/ingredients*, /api/units*, /api/tools*, /api/tags*, /api/techniques* even if that specific
 *  sub-route isn't implemented, since silently falling through there would
 *  incorrectly try to reach a server that (in standalone mode) doesn't
 *  exist. */
export async function dispatchLocal(path: string, init?: RequestInit): Promise<LocalDispatchResult | null> {
  const { segments, searchParams } = segmentsAndQuery(path);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (!['recipes', 'ingredients', 'units', 'tools', 'tags', 'techniques', 'backup', 'geocode', 'share', 'shopping', 'menus', 'collections', 'cook-log', 'pantry'].includes(segments[0])) {
    return null;
  }

  // A thrown error here (a SQL error from a stale local schema, a bad body
  // shape, ...) would otherwise propagate out of apiFetch uncaught, past
  // every caller's `catch` block as a bare, unhelpful "Network error" —
  // wrong (nothing about this is a network problem) and useless for
  // diagnosing the real cause. Surface it as a normal error response instead.
  let result: LocalDispatchResult | typeof NOT_HANDLED;
  try {
    if (segments[0] === 'recipes') result = await dispatchRecipes(segments, method, searchParams, init);
    else if (segments[0] === 'ingredients') result = await dispatchIngredients(segments, method, searchParams, init);
    else if (segments[0] === 'units') result = await dispatchUnits(segments, method, searchParams, init);
    else if (segments[0] === 'tools') result = await dispatchTools(segments, method, searchParams, init);
    else if (segments[0] === 'tags') result = await dispatchTags(segments, method, searchParams, init);
    else if (segments[0] === 'shopping') result = await dispatchShopping(segments, method, init);
    else if (segments[0] === 'menus') result = await dispatchMenus(segments, method, init);
    else if (segments[0] === 'collections') result = await dispatchCollections(segments, method, init);
    else if (segments[0] === 'cook-log') result = await dispatchCookLog(method, searchParams);
    else if (segments[0] === 'pantry') result = await dispatchPantry(segments, method, init);
    else if (segments[0] === 'techniques') result = await dispatchTechniques(segments, method, searchParams, init);
    else if (segments[0] === 'geocode') result = await dispatchGeocode(searchParams);
    else if (segments[0] === 'share') result = await dispatchShare(segments, method, init);
    else result = await dispatchBackup(segments, method, init);
  } catch (err) {
    console.error(`Local dispatch failed for ${method} ${path}:`, err);
    return { status: 500, error: err instanceof Error ? err.message : String(err) };
  }

  if (result === NOT_HANDLED) {
    return { status: 501, error: `This action isn't available in offline mode yet.` };
  }
  return result;
}
