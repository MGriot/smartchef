// ════════════════════════════════════════════════════════════════════════
// SmartChef — Git-based folder sync (standalone mode)
//
// Every device that shares the same folder converges through real git
// history instead of the folder-sync.service.ts server build's whole-
// JSON-snapshot exchange. Which folder that is depends on platform — a
// private-storage working copy mirrored to a user-picked SAF tree on
// Android, a user-chosen folder used directly on Electron (see gitfs.ts's
// getSyncBasePath()) — but the merge semantics here are
// identical either way: per-row last-write-wins by `updated_at`, applied
// as a full working-tree rescan rather than a diff walk — simpler, and
// correct because an OS-level cloud client (OneDrive/Drive/Syncthing) is
// what actually moves the bytes between devices, invisibly to this code;
// all this does is reconcile whatever's currently on disk into the local
// SQLite datastore, then commit the result so there's a real history to
// browse (see SyncHistory.tsx).
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { Preferences } from '@capacitor/preferences';
import { gitfs, ensureSyncFolderPermission, getSyncBasePath } from '../gitfs';
import { isElectron } from '../electronBridge';
import { pullFromTarget, pushToTarget } from './androidMirror';
import { query, queryOne } from '../../db/local';

const DEVICE_ID_KEY = 'smartchef.sync.deviceId';
const DEVICE_NAME_KEY = 'smartchef.sync.deviceName';
const LAST_SYNC_KEY = 'smartchef.sync.lastSyncAt';

/** Resolved fresh on every call (cheap — getSyncBasePath() is itself
 *  memoized) rather than cached here, so an Electron user changing folders
 *  via chooseElectronSyncFolder() takes effect on the very next sync tick
 *  with no separate cache-invalidation to wire up. */
async function dirs(): Promise<{ dir: string; gitdir: string }> {
  const dir = await getSyncBasePath();
  return { dir, gitdir: `${dir}/.git` };
}

type EntityType = 'recipes' | 'ingredients';

let deviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
  if (value) {
    deviceId = value;
    return value;
  }
  const id = `device-${crypto.randomUUID().slice(0, 8)}`;
  await Preferences.set({ key: DEVICE_ID_KEY, value: id });
  deviceId = id;
  return id;
}

/** Human-friendly name for this device's devices/<id>.json — a user-set
 *  override (Account.tsx, task 12) always wins; otherwise falls back to
 *  @capacitor/device's reported model name; otherwise the anonymous
 *  device-xxxxxxxx id itself, matching the design doc's fallback chain.
 *  Loaded dynamically rather than imported at module scope so every
 *  existing sync test — none of which mock @capacitor/device — keeps
 *  working unchanged: the web implementation throws without a real
 *  navigator.userAgent (true in Vitest's node environment, never true in
 *  an actual browser/WebView), and that failure is just another case of
 *  "fall back to the device id," not a bug to route around. */
export async function getDeviceName(): Promise<string> {
  const { value } = await Preferences.get({ key: DEVICE_NAME_KEY });
  if (value) return value;
  try {
    const { Device } = await import('@capacitor/device');
    const { model } = await Device.getInfo();
    if (model) return model;
  } catch {
    // No usable Device API in this environment — fall through to the id.
  }
  return getDeviceId();
}

export async function setDeviceName(name: string): Promise<void> {
  await Preferences.set({ key: DEVICE_NAME_KEY, value: name });
}

let initDone = false;

/** Runs once per app session (the initDone guard). The Android pull here
 *  is specifically about first-run correctness, not periodic sync — see
 *  androidMirror.ts's pullFromTarget() docstring for why it has to happen
 *  before the hasGit check below: a device joining an already-populated
 *  SAF target must adopt that history instead of git.init-ing a
 *  disconnected empty one. syncNow() (task 9) separately calls
 *  pullFromTarget()/pushToTarget() again on every cycle for ongoing sync
 *  once this has run — meaning the very first sync tick pulls twice
 *  (once here, once there), which is harmless (the second call finds
 *  nothing new) and simpler than threading an "already pulled once" flag
 *  through two functions for a one-time no-op. Electron never calls this
 *  at all — it has no SAF target to pull from; isomorphic-git already
 *  points straight at the real shared folder. A pull failure here (no
 *  tree configured yet, target unreachable, permission lost) must never
 *  block local git init — standalone mode has to work fully offline. */
export async function initSyncRepo(): Promise<void> {
  if (initDone) return;
  await ensureSyncFolderPermission();

  const { dir, gitdir } = await dirs();
  await gitfs.promises.mkdir(`${dir}/recipes`);
  await gitfs.promises.mkdir(`${dir}/ingredients`);

  if (!isElectron()) {
    await pullFromTarget().catch((err) => console.warn('SmartChef: initial SAF pull failed:', err));
  }

  let hasGit = true;
  try {
    await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    await git.init({ fs: gitfs, dir, gitdir, defaultBranch: 'main' });
  }
  initDone = true;
}

function author() {
  return { name: 'SmartChef', email: 'sync@smartchef.local' };
}

/** Serializes one row's current state to its own file — called right
 *  after every local create/update/delete in recipes.local.ts/
 *  ingredients.local.ts. One file per row (not per entity type) so a git
 *  diff on a single recipe is meaningful and two recipes edited at once
 *  don't collide in the same file. */
export async function writeEntityFile(type: EntityType, id: string, data: Record<string, unknown>): Promise<void> {
  await initSyncRepo();
  const { dir } = await dirs();
  await gitfs.promises.writeFile(`${dir}/${type}/${id}.json`, JSON.stringify(data, null, 2));
  scheduleCommit();
}

// ── Debounced commit — a burst of edits (typing a form, saving several
// ingredient rows) becomes one commit, not dozens. ──────────────────────

let commitTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleCommit(delayMs = 2000): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    commitNow().catch((err) => console.error('SmartChef sync commit failed:', err));
  }, delayMs);
}

/** Stages and commits whatever changed under recipes/ or ingredients/ —
 *  a no-op if nothing did (checked via statusMatrix first, so periodic
 *  sync ticks don't spam empty commits). */
export async function commitNow(): Promise<boolean> {
  await initSyncRepo();
  const { dir, gitdir } = await dirs();
  const matrix = await git.statusMatrix({ fs: gitfs, dir, gitdir, filepaths: ['recipes', 'ingredients'] });
  const changed = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (!changed) return false;

  await git.add({ fs: gitfs, dir, gitdir, filepath: ['recipes', 'ingredients'] });
  const id = await getDeviceId();
  const changedCount = matrix.filter(([, head, workdir]) => head !== workdir).length;
  await git.commit({
    fs: gitfs,
    dir,
    gitdir,
    message: `sync: ${changedCount} change${changedCount === 1 ? '' : 's'} from ${id}`,
    author: author(),
  });
  return true;
}

// ── Pull: reconcile whatever's on disk into local SQLite ────────────────

async function listEntityFiles(type: EntityType): Promise<string[]> {
  try {
    const { dir } = await dirs();
    const names = await gitfs.promises.readdir(`${dir}/${type}`);
    return names.filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

// Columns that only ever appear in an API-response row (joined-in display
// data, not real table columns) — stripped before building the flat
// recipes/ingredients INSERT below. Recipe entity files additionally carry
// `ingredients`/`steps`/`toolIds` (the raw child-table rows, not the
// display-nested shape `getRecipe()` returns) — see recipes.local.ts's
// `writeEntityFile` call site for exactly what's written.
const DISPLAY_ONLY_COLUMNS = new Set([
  'category_name', 'category_icon', 'category_color', 'translated_name',
  'translated_category_name', 'translations', 'tags_display',
  'translated_title', 'translated_description', 'creator_avatar_url',
  'ingredient_count',
]);

async function upsertFlatRow(table: EntityType, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row).filter((k) => !DISPLAY_ONLY_COLUMNS.has(k) && k !== 'ingredients' && k !== 'steps' && k !== 'toolIds');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = columns.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(', ');
  const values = columns.map((c) => row[c]);
  await query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
    values
  );
}

async function reconcileRecipeChildren(recipeId: string, incoming: Record<string, unknown>): Promise<void> {
  const ingredients = Array.isArray(incoming.ingredients) ? incoming.ingredients as Array<Record<string, unknown>> : [];
  const steps = Array.isArray(incoming.steps) ? incoming.steps as Array<Record<string, unknown>> : [];
  const toolIds = Array.isArray(incoming.toolIds) ? incoming.toolIds as string[] : [];

  await query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
  for (const ing of ingredients) {
    await query(
      `INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id, subtype_id, sub_recipe_id, quantity, quantity_text, unit_id, notes, is_optional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ing.id ?? crypto.randomUUID(), recipeId, ing.sort_order ?? 0, ing.ingredient_id ?? null, ing.subtype_id ?? null,
       ing.sub_recipe_id ?? null, ing.quantity ?? null, ing.quantity_text ?? null, ing.unit_id ?? null, ing.notes ?? null, ing.is_optional ? 1 : 0]
    );
  }

  await query('DELETE FROM recipe_steps WHERE recipe_id=$1', [recipeId]);
  for (const step of steps) {
    await query(
      `INSERT INTO recipe_steps (id, recipe_id, step_number, title, description, duration_min, tool_ids, notes, image_url, step_ingredients)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [step.id ?? crypto.randomUUID(), recipeId, step.step_number ?? 1, step.title ?? null, step.description ?? '',
       step.duration_min ?? null, step.tool_ids ?? [], step.notes ?? null, step.image_url ?? null, step.step_ingredients ?? []]
    );
  }

  await query('DELETE FROM recipe_tools WHERE recipe_id=$1', [recipeId]);
  for (const toolId of toolIds) {
    await query('INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [recipeId, toolId]);
  }
}

async function reconcileEntity(type: EntityType, fileName: string): Promise<boolean> {
  const id = fileName.replace(/\.json$/, '');
  let raw: string;
  try {
    const { dir } = await dirs();
    raw = (await gitfs.promises.readFile(`${dir}/${type}/${fileName}`, 'utf8')) as string;
  } catch {
    return false;
  }
  let incoming: Record<string, unknown>;
  try {
    incoming = JSON.parse(raw);
  } catch {
    return false; // corrupt/partially-written file (e.g. mid-cloud-sync) — skip, next tick retries
  }

  const existing = await queryOne<{ updated_at: string }>(`SELECT updated_at FROM ${type} WHERE id = $1`, [id]);
  const incomingUpdatedAt = String(incoming.updated_at ?? '');
  if (existing && incomingUpdatedAt <= existing.updated_at) {
    return false; // local copy is same age or newer — ours wins, nothing to do
  }

  await upsertFlatRow(type, incoming);
  if (type === 'recipes') {
    await reconcileRecipeChildren(id, incoming);
  }
  return true;
}

// ── Device registry — devices/<id>.json, one file per device, disjoint by
// writer so no merge logic is needed (see the design doc's Data Model
// section). Not committed to git (commitNow() only stages recipes/
// ingredients) — always-fresh state, not history. androidMirror.ts's
// pushToTarget()/pullFromTarget() already read/write this same path;
// this is what actually puts real content there. ─────────────────────────

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'electron';
  lastSyncAt: string;
}

/** Writes only this device's own devices/<id>.json, never another
 *  device's. Electron writes straight into the shared folder (no separate
 *  mirror step, same as recipes/ingredients); Android writes into the
 *  private working copy, where pushToTarget() picks it up like any other
 *  push target file — so this must run before that push, per the design
 *  doc's control-flow step 4. No explicit mkdir: gitfs.writeFile() creates
 *  parent directories recursively on both platforms. */
async function writeDeviceRecord(): Promise<void> {
  const { dir } = await dirs();
  const id = await getDeviceId();
  const record: DeviceRecord = {
    deviceId: id,
    deviceName: await getDeviceName(),
    platform: isElectron() ? 'electron' : 'android',
    lastSyncAt: new Date().toISOString(),
  };
  await gitfs.promises.writeFile(`${dir}/devices/${id}.json`, JSON.stringify(record, null, 2));
}

/** Every device that's ever synced through this shared folder, newest
 *  `lastSyncAt` first — Account.tsx's device list and SyncHistory.tsx both
 *  read this. A corrupt/partially-written file (same mid-cloud-sync
 *  tolerance as reconcileEntity()) is skipped rather than failing the
 *  whole list. Empty (not an error) when nothing's synced yet. */
export async function listDeviceRecords(): Promise<DeviceRecord[]> {
  const { dir } = await dirs();
  let names: string[];
  try {
    names = await gitfs.promises.readdir(`${dir}/devices`);
  } catch {
    return [];
  }
  const records: DeviceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = (await gitfs.promises.readFile(`${dir}/devices/${name}`, 'utf8')) as string;
      records.push(JSON.parse(raw) as DeviceRecord);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => b.lastSyncAt.localeCompare(a.lastSyncAt));
}

export interface SyncResult {
  applied: number;
  committed: boolean;
  lastSyncAt: string;
}

/** The main entry point — call on app foreground/resume, on a periodic
 *  timer, and from a manual "Sync Now" button. Folder/files not existing
 *  yet (first run, nothing synced down from another device yet) is
 *  "nothing to pull", never an error.
 *
 *  Android's full per-cycle order matches the design doc's control flow:
 *  pull (so this cycle's reconcile sees whatever arrived from other
 *  devices since last time — initSyncRepo()'s own pull is a first-run-only
 *  concern, not a substitute for this), reconcile, commit, write this
 *  device's own devices/<id>.json with a fresh lastSyncAt, push. A pull or
 *  push failure is caught and logged rather than thrown — reconcile/commit
 *  work against local data regardless of sync connectivity, and must keep
 *  succeeding even when the SAF target is unreachable. Electron runs the
 *  same device-record write (both platforms share one registry) but never
 *  pulls/pushes: isomorphic-git already points straight at the real shared
 *  folder, there's no separate mirror step. */
export async function syncNow(): Promise<SyncResult> {
  await initSyncRepo();

  if (!isElectron()) {
    await pullFromTarget().catch((err) => console.warn('SmartChef: SAF pull failed:', err));
  }

  let applied = 0;
  for (const type of ['recipes', 'ingredients'] as const) {
    const files = await listEntityFiles(type);
    for (const file of files) {
      if (await reconcileEntity(type, file)) applied++;
    }
  }

  const committed = await commitNow();

  await writeDeviceRecord().catch((err) => console.warn('SmartChef: writing device record failed:', err));

  if (!isElectron()) {
    await pushToTarget().catch((err) => console.warn('SmartChef: SAF push failed:', err));
  }

  const lastSyncAt = new Date().toISOString();
  await Preferences.set({ key: LAST_SYNC_KEY, value: lastSyncAt });
  return { applied, committed, lastSyncAt };
}

export async function getLastSyncAt(): Promise<string | null> {
  const { value } = await Preferences.get({ key: LAST_SYNC_KEY });
  return value ?? null;
}

// ── History (read-only for this stage — see SyncHistory.tsx) ───────────

export interface SyncCommit {
  oid: string;
  message: string;
  authorName: string;
  timestamp: number;
  changedFiles: string[];
}

export async function getSyncHistory(limit = 50): Promise<SyncCommit[]> {
  await initSyncRepo();
  let commits;
  try {
    const { dir, gitdir } = await dirs();
    commits = await git.log({ fs: gitfs, dir, gitdir, depth: limit, includeChanges: true });
  } catch {
    return []; // no commits yet
  }
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message,
    authorName: c.commit.author.name,
    timestamp: c.commit.author.timestamp * 1000,
    changedFiles: (c.commit.changes ?? []).map((change) => String(change[2])),
  }));
}

// ── Watcher — mirrors offlineSync.ts's startOfflineSyncWatcher() pattern:
// sync on app resume, plus a periodic fallback. No connectivity listener
// (unlike that watcher) — a shared folder being "reachable" is a
// filesystem question, not a network one; whatever OS-level client keeps
// it synced does its own thing on its own schedule, so a fixed timer is
// all there is to trigger a re-check with.

let watcherStarted = false;

export function startFolderSyncWatcher(intervalMs = 5 * 60_000): void {
  if (watcherStarted) return;
  watcherStarted = true;

  syncNow().catch((err) => console.error('SmartChef initial folder sync failed:', err));
  setInterval(() => {
    syncNow().catch((err) => console.error('SmartChef periodic folder sync failed:', err));
  }, intervalMs);

  import('@capacitor/app').then(({ App }) => {
    App.addListener('resume', () => {
      syncNow().catch((err) => console.error('SmartChef resume folder sync failed:', err));
    });
  }).catch(() => {});
}
