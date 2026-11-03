// ════════════════════════════════════════════════════════════════════════
// SmartChef — shared cookbooks: recipes that stay in sync, both ways,
// between separate libraries (docs/plans/2026-11-01-sync-v2-change-log.md
// §5b)
//
// A cookbook is a small library of its own: the same store layout, its
// own key, in a place every member can reach (a WebDAV folder, a git
// repository). Every device of every member library syncs it as one more
// device, on its own scope of the change log (changeLog.local.ts), so the
// merge rules and conflicts are the ones devices already have.
//
// What goes where, for a recipe in a cookbook this device has joined:
//   - its content (title, steps, ingredients…) is recorded into the
//     cookbook's scope only. Recording it into the library's own log as
//     well would give each edit two stamps on two paths, and the older
//     path could overwrite a newer edit made by another member;
//   - its personal fields (rating, times cooked) and which cookbook it is
//     in are recorded into the library's own log only: they belong to this
//     library and travel to its own devices, never to other members.
//
// Catalog ids. Each library keeps its own ingredients, tools and
// techniques. A shared recipe is published with the cookbook's ids for
// them: the id of whichever member published the entry first, with that
// member's definition (its name, synonyms, translations) recorded under it.
// Arriving here, a definition is matched by name to this library's own
// row (recipeShare.local.ts, exact matching only) or created, and
// cookbook_map remembers the pairing both ways. A new row is created
// under the cookbook's id, so every device of this library that meets
// the same definition makes the same row and they merge as one.
//
// Leaving keeps a private copy of every recipe. Revoking a member needs a
// new cookbook (a new key) — there is no server to say no.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';
import { query, queryOne } from '../db/local';
import { normalizeName } from '../lib/stepRefs';
import type { SyncStore } from '../lib/changeLog/store';
import type { ImageFs } from '../lib/localImages';
import type { ConflictPolicy } from '../lib/structuredMerge';
import type { EntityWrite, EntityWriter } from './changeLog.local';
import type { CatalogKind } from './recipeShare.local';
import type { SyncV2Report } from './syncV2.local';

type Entity = Record<string, unknown>;

export type CookbookStoreConfig =
  | { kind: 'webdav'; url: string; username: string; password: string }
  | { kind: 'git'; url: string; username: string | null; token: string | null; corsProxy?: string | null };

export interface Cookbook {
  id: string;
  name: string;
  store: CookbookStoreConfig;
  /** The cookbook key as a recovery code; null for a plain cookbook. */
  key: string | null;
  joinedAt: string;
}

const COLLECTIONS_KEY = 'smartchef.cookbooks';

/** Fields of a recipe that belong to each library, never shared. */
export const PERSONAL_RECIPE_FIELDS = ['rating', 'times_cooked', 'cookbook_id'];

const CATALOG_TYPES = new Set<string>(['ingredient', 'tool', 'technique']);

/** Catalog columns that are this library's own business: its row ids, its
 *  tags, its photos. Everything else defines the entry for other members. */
const NOT_IN_DEFINITION = ['id', 'created_at', 'updated_at', 'category_id', 'tag_ids', 'sync_status', 'deleted_at', 'image_urls'];

// ── This device's cookbooks ───────────────────────────────────────────

let cached: Cookbook[] | null = null;

function isCookbook(v: unknown): v is Cookbook {
  const c = v as Cookbook;
  return !!c && typeof c.id === 'string' && typeof c.name === 'string' && !!c.store
    && (c.store.kind === 'webdav' || c.store.kind === 'git') && typeof c.store.url === 'string';
}

export async function listCookbooks(): Promise<Cookbook[]> {
  if (!cached) {
    const raw = (await Preferences.get({ key: COLLECTIONS_KEY })).value;
    try {
      cached = raw ? (JSON.parse(raw) as unknown[]).filter(isCookbook) : [];
    } catch {
      cached = [];
    }
  }
  return cached.map((c) => ({ ...c, store: { ...c.store } }));
}

async function saveCookbooks(list: Cookbook[]): Promise<void> {
  cached = list;
  await Preferences.set({ key: COLLECTIONS_KEY, value: JSON.stringify(list) });
}

export async function getCookbook(id: string): Promise<Cookbook | null> {
  return (await listCookbooks()).find((c) => c.id === id) ?? null;
}

/** Drops in-memory state — for tests that switch devices. */
export function resetCookbooksState(): void {
  cached = null;
}

export async function createCookbook(name: string, store: CookbookStoreConfig, encrypt = true): Promise<Cookbook> {
  const { newLibraryKey, formatRecoveryKey } = await import('../lib/changeLog/libraryStore');
  const cookbook: Cookbook = {
    id: crypto.randomUUID(), name: name.trim() || 'Shared recipes', store,
    key: encrypt ? formatRecoveryKey(newLibraryKey()) : null, joinedAt: new Date().toISOString(),
  };
  await saveCookbooks([...(await listCookbooks()), cookbook]);
  return cookbook;
}

/** Adds (or updates) cookbooks carried by an invite or a Setup File. */
export async function joinCookbooks(incoming: unknown[]): Promise<Cookbook[]> {
  const list = await listCookbooks();
  const joined: Cookbook[] = [];
  for (const c of incoming.filter(isCookbook)) {
    const next: Cookbook = { id: c.id, name: c.name, store: c.store, key: c.key ?? null, joinedAt: c.joinedAt ?? new Date().toISOString() };
    const at = list.findIndex((x) => x.id === c.id);
    if (at >= 0) list[at] = { ...next, joinedAt: list[at].joinedAt };
    else list.push(next);
    joined.push(next);
  }
  await saveCookbooks(list);
  return joined;
}

export async function updateCookbookStore(id: string, store: CookbookStoreConfig): Promise<void> {
  await saveCookbooks((await listCookbooks()).map((c) => (c.id === id ? { ...c, store } : c)));
}

// ── Invites ─────────────────────────────────────────────────────────────
// The Setup File's container (lib/setupConfigFile.ts): a passphrase the
// inviter tells the member some other way, because the invite carries the
// cookbook key and the store's password or token.

export const INVITE_MAGIC = 'smartchef.cookbook-invite';
export const INVITE_EXTENSION = '.scinvite';

export interface CookbookInvite {
  kind: 'smartchef-cookbook-invite';
  version: 1;
  cookbook: Cookbook;
  invitedBy?: string | null;
}

export async function buildInvite(id: string, passphrase: string, invitedBy?: string | null): Promise<string> {
  const cookbook = await getCookbook(id);
  if (!cookbook) throw new Error('This device has not joined that cookbook.');
  const { sealWithPassphrase } = await import('../lib/setupConfigFile');
  const invite: CookbookInvite = { kind: 'smartchef-cookbook-invite', version: 1, cookbook, invitedBy: invitedBy ?? null };
  return sealWithPassphrase(invite, passphrase, INVITE_MAGIC);
}

export async function readInvite(text: string, passphrase: string): Promise<CookbookInvite> {
  const { openWithPassphrase } = await import('../lib/setupConfigFile');
  const invite = (await openWithPassphrase(text, passphrase, INVITE_MAGIC)) as CookbookInvite;
  if (!invite || invite.kind !== 'smartchef-cookbook-invite' || !isCookbook(invite.cookbook)) {
    throw new Error('This file is not a SmartChef cookbook invite.');
  }
  return invite;
}

// ── Recording ───────────────────────────────────────────────────────────

const pick = (entity: Entity, fields: string[]) => Object.fromEntries(fields.filter((f) => f in entity).map((f) => [f, entity[f]]));

/** Records a save: into the library's own log, and into a cookbook's when
 *  the recipe is in one this device has joined (see the header for which
 *  fields go where). Called from writeEntityFile() once sync v2 is on. */
export async function recordEntityEverywhere(entityType: string, entityId: string, entity: Entity, device: string): Promise<void> {
  const log = await import('./changeLog.local');
  const cookbookId = entityType === 'recipe' && typeof entity.cookbook_id === 'string' ? entity.cookbook_id : null;
  if (!cookbookId || !(await getCookbook(cookbookId))) {
    await log.recordEntityChange(entityType, entityId, entity, device);
    return;
  }
  await log.recordEntityChange(entityType, entityId, pick(entity, PERSONAL_RECIPE_FIELDS), device);
  await recordIntoCookbook(cookbookId, entityId, entity, device);
}

interface Translator {
  /** Whether a cookbook id already stands for this library's row. */
  isMapped(kind: CatalogKind, localId: string): boolean;
  map(kind: CatalogKind, id: string): string;
}

/** This library's ids → the cookbook's. When several cookbook ids name
 *  the same row (two members published the same "Farina"), the one the
 *  recipe already uses in the cookbook is kept, so a save here doesn't
 *  churn ids nobody changed. */
async function toCookbookIds(scope: string, recipeId: string): Promise<Translator> {
  const rows = await query<{ entity_type: string; remote_id: string; local_id: string }>(
    `SELECT entity_type, remote_id, local_id FROM cookbook_map WHERE scope = $1 ORDER BY remote_id`, [scope],
  );
  const state = await query<{ value: string | null }>(
    `SELECT value FROM field_state WHERE scope = $1 AND entity_type = 'recipe' AND entity_id = $2`, [scope, recipeId],
  );
  const inUse = state.map((s) => s.value ?? '').join(' ');
  const byLocal = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.entity_type}::${r.local_id}`;
    if (!byLocal.has(key)) byLocal.set(key, []);
    byLocal.get(key)!.push(r.remote_id);
  }
  return {
    isMapped: (kind, id) => byLocal.has(`${kind}::${id}`),
    map: (kind, id) => {
      const candidates = byLocal.get(`${kind}::${id}`);
      if (!candidates) return id;
      return candidates.find((r) => inUse.includes(r)) ?? candidates[0];
    },
  };
}

/** The cookbook's ids → this library's. */
async function toLocalIds(scope: string): Promise<(kind: CatalogKind, id: string) => string> {
  const rows = await query<{ entity_type: string; remote_id: string; local_id: string }>(
    `SELECT entity_type, remote_id, local_id FROM cookbook_map WHERE scope = $1`, [scope],
  );
  const map = new Map(rows.map((r) => [`${r.entity_type}::${r.remote_id}`, r.local_id]));
  return (kind, id) => map.get(`${kind}::${id}`) ?? id;
}

function definitionOf(kind: CatalogKind, row: Entity, map: (kind: CatalogKind, id: string) => string): Entity {
  const def: Entity = { ...row };
  for (const f of NOT_IN_DEFINITION) delete def[f];
  if (kind === 'ingredient') {
    def.parent_ingredient_id = typeof row.parent_ingredient_id === 'string' ? map('ingredient', row.parent_ingredient_id) : null;
  }
  return def;
}

async function recordIntoCookbook(scope: string, recipeId: string, entity: Entity, device: string): Promise<void> {
  const [log, share] = await Promise.all([import('./changeLog.local'), import('./recipeShare.local')]);
  const ids = await toCookbookIds(scope, recipeId);
  // The definitions first, so a member reading the log in order meets
  // "Farina" before the recipe that uses it. Only this library's own
  // entries: a row already paired with another member's is defined there.
  const catalog = await share.loadCatalog(share.referencesOf([entity]));
  for (const [kind, rows] of [['ingredient', catalog.ingredients], ['tool', catalog.tools], ['technique', catalog.techniques]] as const) {
    for (const row of rows) {
      const id = row.id as string;
      if (ids.isMapped(kind, id)) continue;
      await log.recordEntityChange(kind, id, definitionOf(kind, row, ids.map), device, scope);
    }
  }
  const content = Object.fromEntries(Object.entries(entity).filter(([k]) => !PERSONAL_RECIPE_FIELDS.includes(k) && k !== 'toolNames'));
  await log.recordEntityChange('recipe', recipeId, share.remapRecipeIds(content, ids.map), device, scope);
}

// ── Applying what other members wrote ───────────────────────────────────

/** Writes a cookbook's incoming changes into this library: recipes with
 *  the cookbook's catalog ids turned into this library's, catalog
 *  definitions matched or created. */
export function cookbookWriter(scope: string): EntityWriter {
  const indexes = new Map<CatalogKind, Map<string, string>>();
  return async (w) => {
    if (CATALOG_TYPES.has(w.entityType)) return adoptDefinition(scope, w, indexes);
    if (w.entityType === 'recipe') return writeRecipe(scope, w);
    // Nothing else is shared.
  };
}

async function writeRecipe(scope: string, w: EntityWrite): Promise<void> {
  const [{ writeEntity }, { remapRecipeIds }] = await Promise.all([import('./changeLog.local'), import('./recipeShare.local')]);
  const local = await queryOne<{ cookbook_id: string | null }>(`SELECT cookbook_id FROM recipes WHERE id = $1`, [w.entityId]);
  if (local && local.cookbook_id !== scope) {
    // Not in this cookbook here: a copy this library kept when it left,
    // or one whose move into the cookbook hasn't arrived from this
    // library's own log yet. The winners stay in the cookbook's
    // field_state; catchUpPending() writes them if it does arrive.
    await query(`INSERT INTO cookbook_pending (scope, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [scope, w.entityId]);
    return;
  }
  const toLocal = await toLocalIds(scope);
  const tr = (fields: Entity) => remapRecipeIds(fields, toLocal);
  const trField = (field: string, value: unknown) => (value === null || value === undefined ? value : tr({ [field]: value })[field]);
  await writeEntity({
    ...w,
    applied: tr(w.applied),
    everything: local ? {} : { ...tr(w.everything), ...(await personalFields(w.entityId)), cookbook_id: scope },
    conflicts: w.conflicts.map((c) => ({ ...c, localValue: trField(c.fieldName, c.localValue), remoteValue: trField(c.fieldName, c.remoteValue) })),
  });
}

async function adoptDefinition(scope: string, w: EntityWrite, indexes: Map<CatalogKind, Map<string, string>>): Promise<void> {
  const kind = w.entityType as CatalogKind;
  const [{ createEntity, entityExists, resyncEntityToGit }, share] = await Promise.all([import('./conflicts.local'), import('./recipeShare.local')]);
  const known = await queryOne<{ local_id: string }>(
    `SELECT local_id FROM cookbook_map WHERE scope = $1 AND entity_type = $2 AND remote_id = $3`, [scope, kind, w.entityId],
  );
  if (known && (await entityExists(kind, known.local_id))) return; // later edits to another member's entry stay theirs
  const def = Object.keys(w.everything).length > 0 ? w.everything : w.applied;
  if (typeof def.name !== 'string' || !def.name.trim()) return;

  let localId: string | null = (await entityExists(kind, w.entityId)) ? w.entityId : null;
  if (!localId) {
    if (!indexes.has(kind)) indexes.set(kind, await share.nameIndex(kind));
    const index = indexes.get(kind)!;
    localId = share.entityNames(def).map((n) => index.get(normalizeName(n))).find((id): id is string => !!id) ?? null;
  }
  if (!localId) {
    const toLocal = await toLocalIds(scope);
    const fields: Entity = { ...def, sync_status: 'local' };
    if (kind === 'ingredient') {
      const parent = typeof def.parent_ingredient_id === 'string' ? toLocal('ingredient', def.parent_ingredient_id) : null;
      fields.parent_ingredient_id = parent && (await entityExists('ingredient', parent)) ? parent : null;
      if (typeof def.category_name !== 'string' || !def.category_name.trim()) fields.category_name = 'Uncategorized';
    } else {
      fields.deleted_at = null;
    }
    await createEntity(kind, w.entityId, fields);
    localId = w.entityId;
    const index = indexes.get(kind);
    if (index) for (const n of share.entityNames(def)) { const k = normalizeName(n); if (k && !index.has(k)) index.set(k, localId); }
    // Into this library's own log, so its other devices have it too.
    await resyncEntityToGit(kind, localId).catch((err) => console.warn(`SmartChef: publishing ${kind} ${localId} failed:`, err));
  }
  await query(
    `INSERT INTO cookbook_map (scope, entity_type, remote_id, local_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT(scope, entity_type, remote_id) DO UPDATE SET local_id = excluded.local_id`,
    [scope, kind, w.entityId, localId],
  );
}

/** A new shared recipe's rating and times cooked: what this library's own
 *  log already holds for it (another of its devices may have rated it
 *  first), or a fresh start. */
async function personalFields(recipeId: string): Promise<Entity> {
  const [log, { assembleFields }] = await Promise.all([import('./changeLog.local'), import('../lib/changeLog/fieldPaths')]);
  const state = await log.listFieldState('recipe', recipeId, '');
  const known = assembleFields(new Map([...state].map(([p, s]) => [p, s.value])), new Set(['rating', 'times_cooked']));
  return { rating: null, times_cooked: 0, ...known };
}

/** Recipes whose cookbook changes were held back because they weren't in
 *  the cookbook here yet, and now are: the cookbook's winners, written. */
async function catchUpPending(scope: string): Promise<void> {
  const rows = await query<{ recipe_id: string }>(
    `SELECT p.recipe_id FROM cookbook_pending p JOIN recipes r ON r.id = p.recipe_id WHERE p.scope = $1 AND r.cookbook_id = $1`, [scope],
  );
  if (rows.length === 0) return;
  const [log, { assembleFields }, { applyEntityMergeResult, getMergeableFieldNames }, { remapRecipeIds }] = await Promise.all([
    import('./changeLog.local'), import('../lib/changeLog/fieldPaths'), import('./conflicts.local'), import('./recipeShare.local'),
  ]);
  const toLocal = await toLocalIds(scope);
  const allowed = new Set((getMergeableFieldNames('recipe') ?? []).filter((f) => !PERSONAL_RECIPE_FIELDS.includes(f)));
  for (const { recipe_id } of rows) {
    const state = await log.listFieldState('recipe', recipe_id, scope);
    const values = assembleFields(new Map([...state].map(([p, s]) => [p, s.value])), allowed);
    if (Object.keys(values).length > 0) await applyEntityMergeResult('recipe', recipe_id, { applied: remapRecipeIds(values, toLocal), conflicts: [] });
    await query(`DELETE FROM cookbook_pending WHERE scope = $1 AND recipe_id = $2`, [scope, recipe_id]);
  }
}

// ── Putting recipes in and taking them out ─────────────────────────────

/** Puts recipes, and every sub-recipe they use, into a cookbook. */
export async function addRecipesToCookbook(cookbookId: string, recipeIds: string[]): Promise<string[]> {
  if (!(await getCookbook(cookbookId))) throw new Error('This device has not joined that cookbook.');
  const [{ recipeClosure }, { resyncEntityToGit }] = await Promise.all([import('./recipeShare.local'), import('./conflicts.local')]);
  const ids = await recipeClosure(recipeIds);
  for (const id of ids) {
    await query(`UPDATE recipes SET cookbook_id = $1 WHERE id = $2`, [cookbookId, id]);
    await resyncEntityToGit('recipe', id);
  }
  return ids;
}

/** Takes a recipe out of its cookbook on this library: it stays here as
 *  a private recipe, and the other members keep theirs. */
export async function removeRecipeFromCookbook(recipeId: string): Promise<void> {
  const { resyncEntityToGit } = await import('./conflicts.local');
  await query(`UPDATE recipes SET cookbook_id = NULL WHERE id = $1`, [recipeId]);
  await resyncEntityToGit('recipe', recipeId);
}

/** Leaves a cookbook: its recipes stay here as private copies. */
export async function leaveCookbook(id: string): Promise<number> {
  const [{ resyncEntityToGit }, log] = await Promise.all([import('./conflicts.local'), import('./changeLog.local')]);
  // The cookbook goes first, so each recipe below is recorded whole into
  // the library's own log again.
  await saveCookbooks((await listCookbooks()).filter((c) => c.id !== id));
  const recipes = await query<{ id: string }>(`SELECT id FROM recipes WHERE cookbook_id = $1`, [id]);
  for (const r of recipes) {
    await query(`UPDATE recipes SET cookbook_id = NULL WHERE id = $1`, [r.id]);
    await resyncEntityToGit('recipe', r.id);
  }
  await query(`DELETE FROM cookbook_map WHERE scope = $1`, [id]);
  await query(`DELETE FROM cookbook_pending WHERE scope = $1`, [id]);
  await log.dropScope(id);
  return recipes.length;
}

/** The cookbook a recipe is in here, or null. */
export async function cookbookOfRecipe(recipeId: string): Promise<string | null> {
  const row = await queryOne<{ cookbook_id: string | null }>(`SELECT cookbook_id FROM recipes WHERE id = $1`, [recipeId]);
  return row?.cookbook_id ?? null;
}

export interface CookbookSummary extends Cookbook {
  recipeCount: number;
}

/** Joined cookbooks with how many recipes each holds here, and the ids
 *  of cookbooks this library's recipes are in but this device hasn't
 *  joined (joined on another device — import its Setup File). */
export async function summarizeCookbooks(): Promise<{ joined: CookbookSummary[]; notJoined: string[] }> {
  const counts = await query<{ cookbook_id: string; n: number }>(
    `SELECT cookbook_id, COUNT(*) AS n FROM recipes WHERE cookbook_id IS NOT NULL AND sync_status != 'deleted' GROUP BY cookbook_id`,
  );
  const byId = new Map(counts.map((c) => [c.cookbook_id, Number(c.n)]));
  const joined = (await listCookbooks()).map((c) => ({ ...c, recipeCount: byId.get(c.id) ?? 0 }));
  const notJoined = [...byId.keys()].filter((id) => !joined.some((c) => c.id === id));
  return { joined, notJoined };
}

// ── Syncing ─────────────────────────────────────────────────────────────

type StoreFactory = (cookbook: Cookbook) => Promise<SyncStore>;
let storeFactory: StoreFactory = openCookbookStore;

/** Replaces how a cookbook's store is opened — for tests. */
export function setCookbookStoreFactory(open: StoreFactory | null): void {
  storeFactory = open ?? openCookbookStore;
}

/** Everything under one folder of the store, so several cookbooks (or a
 *  cookbook beside a library) can share a WebDAV folder. */
function under(root: string, store: SyncStore): SyncStore {
  const at = (path: string) => `${root}/${path}`;
  return {
    list: (prefix) => store.list(at(prefix)),
    get: (path) => store.get(at(path)),
    put: (path, data) => store.put(at(path), data),
    ...(store.remove ? { remove: (path: string) => store.remove!(at(path)) } : {}),
  };
}

async function openCookbookStore(c: Cookbook): Promise<SyncStore> {
  if (c.store.kind === 'webdav') {
    const { createWebDavStore } = await import('../lib/changeLog/webdavStore');
    return under(`smartchef-cookbook-${c.id}`, createWebDavStore(c.store));
  }
  const [{ gitfs }, { getHiddenCloneDir }, { createGitStore }, { isomorphicGitRemote }, { getDeviceName }] = await Promise.all([
    import('../lib/gitfs'), import('../lib/sync/hiddenClone'), import('../lib/changeLog/gitStore'), import('../lib/changeLog/gitStoreRemote'), import('../lib/sync/gitSync'),
  ]);
  // Its own small repository and branch, never the library's.
  const dir = `${(await getHiddenCloneDir()).replace(/\/+$/, '')}-cookbook-${c.id}`;
  const gitdir = `${dir}/.git`;
  const branch = `smartchef-cookbook-${c.id}`;
  const remote = { url: c.store.url, username: c.store.username, token: c.store.token, corsProxy: c.store.corsProxy ?? null };
  return createGitStore({ fs: gitfs, dir, gitdir, branch, remote: isomorphicGitRemote(gitfs, dir, gitdir, remote, branch), message: `${c.name}: sync from ${await getDeviceName()}` });
}

/** Only the photos of this cookbook's recipes go up to its store. */
async function cookbookImages(scope: string, fs: ImageFs): Promise<ImageFs> {
  const rows = await query<{ path: string | null }>(
    `SELECT cover_image_url AS path FROM recipes WHERE cookbook_id = $1
     UNION SELECT s.image_url AS path FROM recipe_steps s JOIN recipes r ON r.id = s.recipe_id WHERE r.cookbook_id = $1`, [scope],
  );
  const wanted = new Set(rows.map((r) => r.path).filter((p): p is string => !!p));
  return { ...fs, list: async () => (await fs.list()).filter((p) => wanted.has(p)) };
}

export interface CookbookSyncOptions {
  device: string;
  deviceName?: string;
  policy: ConflictPolicy;
  images?: ImageFs;
}

export interface CookbookSyncResult {
  id: string;
  name: string;
  report?: SyncV2Report;
  error?: string;
}

let lastResults: CookbookSyncResult[] = [];

/** What the last sync of each cookbook did, for the Account page. */
export function lastCookbookResults(): CookbookSyncResult[] {
  return lastResults;
}

export async function syncCookbook(c: Cookbook, opts: CookbookSyncOptions): Promise<SyncV2Report> {
  const [{ syncOnceV2 }, { openLibraryStore, parseRecoveryKey }] = await Promise.all([
    import('./syncV2.local'), import('../lib/changeLog/libraryStore'),
  ]);
  await catchUpPending(c.id);
  const key = c.key ? parseRecoveryKey(c.key) : null;
  const keyring = { get: async () => key, set: async () => {}, encryptNew: async () => key !== null };
  const store = openLibraryStore(await storeFactory(c), keyring, c.id);
  const report = await syncOnceV2(store, {
    device: opts.device, deviceName: opts.deviceName, policy: opts.policy,
    images: opts.images ? await cookbookImages(c.id, opts.images) : undefined,
    scope: c.id, writer: cookbookWriter(c.id), libraryId: c.id,
  });
  await catchUpPending(c.id);
  return report;
}

/** One cycle of every joined cookbook; one failing doesn't stop the others. */
export async function syncCookbooks(opts: CookbookSyncOptions): Promise<CookbookSyncResult[]> {
  const results: CookbookSyncResult[] = [];
  for (const c of await listCookbooks()) {
    try {
      results.push({ id: c.id, name: c.name, report: await syncCookbook(c, opts) });
    } catch (err) {
      results.push({ id: c.id, name: c.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  lastResults = results;
  return results;
}
