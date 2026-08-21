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
import { importSnapshot } from './backup.local';
import { getStandaloneProfile } from '../lib/standalone';

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
  if (segments[1] === 'parse') {
    return { status: 501, error: `Smart Import needs a server-configured LLM provider — not available in offline mode yet.` };
  }
  if (segments[1] === 'filter-by-pantry') {
    return { status: 501, error: `Filtering recipes by pantry contents isn't implemented yet — this is a stable, reserved endpoint for a future feature, not an offline-mode gap.` };
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
    if (method === 'GET') return { status: 200, data: await ingredients.listTools({ lang: sp.get('lang') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await ingredients.createTool(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await ingredients.updateTool(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await ingredients.deleteTool(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

async function dispatchTags(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await tags.listTags({ lang: sp.get('lang') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await tags.createTag(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await tags.updateTag(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await tags.deleteTag(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

async function dispatchTechniques(segments: string[], method: string, sp: URLSearchParams, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, id] = segments;
  if (!id) {
    if (method === 'GET') return { status: 200, data: await techniques.listTechniques({ lang: sp.get('lang') ?? undefined }) };
    if (method === 'POST') return { status: 200, data: await techniques.createTechnique(parseBody(init)) };
    return NOT_HANDLED;
  }
  if (method === 'PUT') { await techniques.updateTechnique(id, parseBody(init)); return { status: 200, data: { success: true } }; }
  if (method === 'DELETE') { await techniques.deleteTechnique(id); return { status: 200, data: { success: true } }; }
  return NOT_HANDLED;
}

/** One-shot "bring an existing library into this fresh device" import —
 *  see backup.local.ts. Only `import` is handled locally; `export` is
 *  deliberately left unhandled here (falls through to dispatchLocal's
 *  caller, which errors clearly) since Folder Sync already covers
 *  continuous, versioned backup for standalone mode. */
async function dispatchBackup(segments: string[], method: string, init?: RequestInit): Promise<LocalDispatchResult | typeof NOT_HANDLED> {
  const [, action] = segments;
  if (action === 'import' && method === 'POST') {
    const summary = await importSnapshot(parseBody(init));
    return { status: 200, data: summary };
  }
  return NOT_HANDLED;
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

  let result: LocalDispatchResult | typeof NOT_HANDLED;
  if (segments[0] === 'recipes') result = await dispatchRecipes(segments, method, searchParams, init);
  else if (segments[0] === 'ingredients') result = await dispatchIngredients(segments, method, searchParams, init);
  else if (segments[0] === 'units') result = await dispatchUnits(segments, method, searchParams, init);
  else if (segments[0] === 'tools') result = await dispatchTools(segments, method, searchParams, init);
  else if (segments[0] === 'tags') result = await dispatchTags(segments, method, searchParams, init);
  else if (segments[0] === 'techniques') result = await dispatchTechniques(segments, method, searchParams, init);
  else if (segments[0] === 'backup') result = await dispatchBackup(segments, method, init);
  else return null;

  if (result === NOT_HANDLED) {
    return { status: 501, error: `This action isn't available in offline mode yet.` };
  }
  return result;
}
