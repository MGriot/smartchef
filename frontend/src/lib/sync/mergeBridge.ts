// ════════════════════════════════════════════════════════════════════════
// SmartChef — Merge bridge (wayfinder ticket 02's remaining connection
// point, standalone-storage-sync map)
//
// Where the git transport layer (gitObjectTransport.ts, which puts a
// fetched remote commit's objects into the Hidden Clone's object store
// without touching anything else) meets Structured Merge
// (structuredMerge.ts, a pure function with no idea what a git object is).
// Given two commits already present locally — this device's own HEAD and
// a freshly-fetched remote-tracking commit — finds their common ancestor,
// extracts each entity's JSON at all three points via readBlob (a purely
// local operation once the objects are present, no network involved), and
// runs mergeEntity() per entity. The result is made real via
// services/conflicts.local.ts: entityExists()/createEntity() for an
// entity introduced by another device, applyEntityMergeResult() for one
// already known here.
//
// Covers every entity type gitSync.ts's ALL_ENTITY_DIRS commits — recipes,
// ingredients, tools, tags, techniques. getMergeableFieldNames() (services/
// conflicts.local.ts) is what actually gates this per entity type: an
// entry here with no field list (returns null) is just skipped, so this
// list can stay a superset without harm — see the `if (!fieldNames)
// continue` below.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { gitCache } from './gitCache';
import { mergeEntity } from '../structuredMerge';
import { healEntitySides } from './referenceHeal';
import {
  entityExists, createEntity, applyEntityMergeResult, getMergeableFieldNames, loadPendingConflictIndex, laterTimestamp, deleteConflict,
  listLocalEntityIds, forceApplyEntity, discardLocalEntity, clearAllConflicts,
} from '../../services/conflicts.local';
import type { ConflictPolicy } from '../structuredMerge';
import { mapWithConcurrency, TRANSFER_CONCURRENCY } from './gitObjectTransport';

// Recipes reference ingredients/tools by id (recipe_ingredients.ingredient_id/
// unit_id, recipe_steps.tool_ids/technique_ids). Local Storage's actual
// SQLite engine DOES enforce foreign keys despite no PRAGMA foreign_keys
// statement anywhere in this codebase (confirmed the hard way — see
// db/local.ts's dropDanglingForeignKeys() for the production bug that
// taught us this) — recipe_ingredients.ingredient_id is a real FK to
// ingredients(id), and ingredients IS a synced entity type here, so a
// recipe written before the ingredient it references exists would throw,
// not just dangle silently. Processing leaf types first and recipes last
// avoids that outright: every recipe is written only after everything it
// could reference already exists. (unit_id used to have the same
// problem for a different reason — see dropDanglingForeignKeys()'s own
// comment for why that one got its FK dropped instead of reordered.)
// Combined with each entity's write now being isolated (one failure
// doesn't abort the batch — see the try/catch below), a later entity that
// *does* fail would leave that dangling reference permanent, not just
// transient.
// Categories and units first (ingredients and recipe rows point at them),
// tags before ingredients (ingredient_tags is a real foreign key).
const ENTITY_DIRS: Array<{ dirName: string; entityType: string }> = [
  { dirName: 'categories', entityType: 'category' },
  { dirName: 'units', entityType: 'unit' },
  { dirName: 'tags', entityType: 'tag' },
  { dirName: 'tools', entityType: 'tool' },
  { dirName: 'techniques', entityType: 'technique' },
  { dirName: 'ingredients', entityType: 'ingredient' },
  { dirName: 'profiles', entityType: 'profile' },
  { dirName: 'recipes', entityType: 'recipe' },
];

/** Ingredients split into base ingredients and varieties
 *  (parent_ingredient_id, a real foreign key), bases first — each batch
 *  still runs concurrently. */
async function ingredientBatches(ids: string[], read: (id: string) => Promise<Record<string, unknown> | null>): Promise<string[][]> {
  const bases: string[] = [];
  const varieties: string[] = [];
  await Promise.all(ids.map(async (id) => {
    const json = await read(id);
    (typeof json?.parent_ingredient_id === 'string' && json.parent_ingredient_id ? varieties : bases).push(id);
  }));
  return [bases, varieties];
}

async function readEntityJson(dir: string, gitdir: string, oid: string | null, filepath: string): Promise<Record<string, unknown> | null> {
  if (!oid) return null;
  try {
    const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath, cache: gitCache() });
    return JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
  } catch (err) {
    // Absent at this commit (never existed there) is expected and silent
    // — but a blob that DOES exist there and fails to read/parse anyway
    // (missing object, corruption, truncation) looks identical from here,
    // and used to be swallowed with zero trace either way. Logged now so
    // at least a connected debugger has something to go on; the caller
    // (applyOneEntity in this same file) is what actually surfaces this
    // to the user, by cross-checking against the tree listing it already
    // has — this function alone can't tell "absent" from "unreadable"
    // apart, only log that SOMETHING made it return null here.
    console.error(`SmartChef: readEntityJson failed for ${filepath} at ${oid}:`, err);
    return null;
  }
}

function entityIdsFromFiles(files: string[], dirName: string): string[] {
  const prefix = `${dirName}/`;
  return files.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => f.slice(prefix.length, -'.json'.length));
}

/** Recipes can nest — a "matrioska" recipe uses another recipe as one of
 *  its own ingredient lines (recipe_ingredients.sub_recipe_id) — so
 *  reordering entity *types* (recipes last, above) isn't enough on its
 *  own: within the recipes batch itself, a recipe that depends on another
 *  recipe still needs that other recipe written first. Topologically
 *  sorts by sub_recipe_id, preferring each candidate's remote content
 *  (what's about to be applied) and falling back to local only if this
 *  recipe doesn't exist on the remote side of this merge at all. Kahn's
 *  algorithm, but tolerant of a cycle (two recipes nested into each
 *  other, or any other malformed data) rather than hanging on it forever
 *  — a cycle just falls back to whatever order remains once no further
 *  progress is possible. */
async function orderRecipeIdsByDependency(
  ids: Set<string>,
  dir: string,
  gitdir: string,
  localOid: string | null,
  remoteOid: string
): Promise<string[]> {
  const idList = [...ids];
  const dependsOn = new Map<string, Set<string>>();

  await Promise.all(idList.map(async (id) => {
    const filepath = `recipes/${id}.json`;
    const json = (await readEntityJson(dir, gitdir, remoteOid, filepath))
      ?? (localOid ? await readEntityJson(dir, gitdir, localOid, filepath) : null);
    const ingredients = Array.isArray(json?.ingredients) ? (json!.ingredients as Array<{ sub_recipe_id?: string }>) : [];
    const deps = new Set<string>();
    for (const ingredient of ingredients) {
      if (ingredient.sub_recipe_id && ids.has(ingredient.sub_recipe_id)) deps.add(ingredient.sub_recipe_id);
    }
    dependsOn.set(id, deps);
  }));

  const sorted: string[] = [];
  const remaining = new Set(idList);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const deps = dependsOn.get(id) ?? new Set();
      return ![...deps].some((d) => remaining.has(d));
    });
    if (ready.length === 0) {
      sorted.push(...remaining); // a cycle — take what's left as-is rather than loop forever
      break;
    }
    for (const id of ready) {
      sorted.push(id);
      remaining.delete(id);
    }
  }
  return sorted;
}

export interface TouchedEntity {
  entityType: string;
  entityId: string;
  /** The complete post-merge JSON for this entity — local's own last-
   *  committed content overlaid with whatever fields fast-forwarded (or,
   *  for a brand-new entity, the complete remote content). Shaped for the
   *  caller to feed straight into a writeEntityFile()-style re-commit, so
   *  the Hidden Clone's own history reflects the merge outcome too, not
   *  just Local Storage — otherwise the next sync's merge-base comparison
   *  would still see the pre-merge value on this device's side. */
  finalFields: Record<string, unknown>;
}

export interface MergeBridgeResult {
  entitiesCreated: number;
  entitiesUpdated: number;
  conflictsRecorded: number;
  touchedEntities: TouchedEntity[];
  /** Entities whose write into Local Storage threw — logged, not silently
   *  dropped, but also not fatal to the rest of the batch (see the per-
   *  entity try/catch below). Should be empty in normal operation; a
   *  non-empty list here is a real signal something about that specific
   *  entity's data is malformed, worth surfacing rather than just hoping
   *  the next sync magically succeeds where this one silently didn't. */
  failedEntities: Array<{ entityType: string; entityId: string; error: string }>;
  /** How many files this cycle actually found under each entity type's
   *  directory, at both the local and remote tree — independent of
   *  whether any of them ended up applied. A device whose Ingredients
   *  library silently never fills in, with zero errors anywhere, means
   *  the code below never even iterated any ingredient — this is the one
   *  signal that can distinguish "found 0 remote files" (something upstream
   *  of this module — the fetch, or remoteOid itself — isn't seeing the
   *  data it should) from "found the files but nothing about them
   *  warranted a change" or "found and applied them, something later
   *  discarded it". Surfaced in Account.tsx since not everyone hitting
   *  this can attach a debugger to see it any other way. */
  entityScanCounts: Record<string, { remoteFiles: number; localFiles: number }>;
  /** Fields both sides changed that a rule settled without asking (ADR
   *  0006) — newest edit, empty side, or a set merge. */
  autoResolved: number;
  /** Every path in the remote tree that the local tree lacks. The merge
   *  commit has to contain them all: it makes the remote an ancestor, so a
   *  file missing from it would read, to every other device, as this
   *  device having deleted it. The caller copies whichever of these the
   *  merge itself didn't write. */
  remoteOnlyFiles: string[];
}

export interface MergeOptions {
  policy?: ConflictPolicy;
}

/** Merges a freshly-fetched remote commit into local state. No-op (all
 *  zero) when localOid === remoteOid — nothing to reconcile. `localOid`
 *  may be null — a genuinely fresh Hidden Clone with no commits of its own
 *  yet (this device's very first sync) — in which case there's no merge-
 *  base to find and no local tree to list; every remote entity is treated
 *  as new, the same "doesn't exist locally -> create" path an established
 *  device's brand-new-elsewhere entities already go through. Does NOT
 *  advance any ref or touch the working tree itself; the caller (syncNow())
 *  owns deciding what the Hidden Clone's own next commit looks like once
 *  Local Storage reflects the merge outcome. */
export async function mergeRemoteIntoLocal(
  dir: string,
  gitdir: string,
  localOid: string | null,
  remoteOid: string,
  options: MergeOptions = {}
): Promise<MergeBridgeResult> {
  const result: MergeBridgeResult = {
    entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [], failedEntities: [],
    entityScanCounts: {}, autoResolved: 0, remoteOnlyFiles: [],
  };
  if (localOid === remoteOid) return result;
  const policy = options.policy ?? 'newest';

  const baseOid: string | null = localOid
    ? (await git.findMergeBase({ fs: gitfs, dir, gitdir, oids: [localOid, remoteOid], cache: gitCache() }))[0] ?? null
    : null;

  const [localFiles, remoteFiles] = await Promise.all([
    localOid ? git.listFiles({ fs: gitfs, dir, gitdir, ref: localOid, cache: gitCache() }) : Promise.resolve([]),
    git.listFiles({ fs: gitfs, dir, gitdir, ref: remoteOid, cache: gitCache() }),
  ]);
  const remoteFileSet = new Set(remoteFiles);
  const localFileSet = new Set(localFiles);
  result.remoteOnlyFiles = remoteFiles.filter((f) => !localFileSet.has(f));
  const pendingIndex = await loadPendingConflictIndex();

  // Applies one entity's three-way merge and writes the outcome — same
  // logic regardless of entity type, but called either sequentially
  // (recipes, where matrioska sub-recipe dependency ordering matters — see
  // orderRecipeIdsByDependency()) or concurrently (every other entity
  // type, which have no ordering dependency on one another). Each of
  // readEntityJson/entityExists/applyEntityMergeResult/createEntity is a
  // real Android SQLite/git-object round-trip, so a device pulling a
  // sizeable library for the first time — every entity is a "create,"
  // none skippable — used to pay hundreds or thousands of these one at a
  // time in series; this is the same "sync takes a long time" fix
  // gitObjectTransport.ts's mapWithConcurrency already applies to
  // push/pull's own per-object work.
  //
  // One malformed entity (a field shape this device's schema version
  // doesn't expect, a write that violates a constraint the source device
  // didn't have) must not abort any other entity's write — each gets its
  // own outcome; a thrown write here is recorded and skipped, not
  // propagated. Mutating the shared `result` object from concurrently-
  // running calls is safe: JS has no true parallelism, so each `result.x++`/
  // `.push()` below runs to completion before another call's continuation
  // gets a turn — no locking needed.
  async function applyOneEntity(dirName: string, entityType: string, fieldNames: string[], id: string): Promise<void> {
    const filepath = `${dirName}/${id}.json`;
    const [baseJson, localJson, remoteJson] = await Promise.all([
      readEntityJson(dir, gitdir, baseOid, filepath),
      readEntityJson(dir, gitdir, localOid, filepath),
      readEntityJson(dir, gitdir, remoteOid, filepath),
    ]);

    // A file absent on the remote side never means "the other device
    // emptied every field" — nothing is ever deleted by removing its file —
    // so there is nothing to take from it. (Unreadable-but-listed is still
    // reported below.)
    if (remoteJson === null) {
      if (remoteFileSet.has(filepath)) {
        result.failedEntities.push({
          entityType,
          entityId: id,
          error: "Could not read this item's data from the sync history (listed but unreadable) — try syncing again.",
        });
      }
      return;
    }

    // A field still waiting on the user is committed with the remote's
    // value (overlayPendingConflicts), so the tree can't say what this
    // device actually holds for it — the conflict row can.
    const pending = pendingIndex.get(`${entityType}:${id}`) ?? [];
    const localForMerge: Record<string, unknown> = { ...(localJson ?? {}) };
    for (const conflict of pending) localForMerge[conflict.fieldName] = conflict.localValue;

    // Unit/category references nobody can resolve borrow what the other
    // sides hold for the same row — see referenceHeal.ts.
    const healed = healEntitySides(entityType, baseJson ?? {}, localForMerge, remoteJson);
    const merged = mergeEntity(healed.base, healed.local, healed.remote, fieldNames, {
      // Per entity, not per commit: an entity both devices created without
      // ever merging has no ancestor even when the commits share one.
      hasBase: baseJson !== null && localJson !== null,
      policy,
    });
    // This device's own rows hold the unresolvable references: rewrite
    // them from the healed value even where the merge found no change.
    for (const field of healed.localHealed) {
      if (!(field in merged.applied) && !merged.conflicts.some((c) => c.fieldName === field)) {
        merged.applied[field] = healed.local[field];
      }
    }
    result.autoResolved += merged.autoResolved?.length ?? 0;
    // Pending conflicts this merge no longer finds conflicting — the other
    // device came round to this device's value, or a rule now settles it.
    const settledPending = pending.filter((c) => !merged.conflicts.some((m) => m.fieldName === c.fieldName));
    const republish = healed.remoteHealed.length > 0;
    if (Object.keys(merged.applied).length === 0 && merged.conflicts.length === 0 && settledPending.length === 0 && !republish) {
      return;
    }

    try {
      if (await entityExists(entityType, id)) {
        const localUpdatedAt = typeof localJson?.updated_at === 'string' ? localJson.updated_at : null;
        const remoteUpdatedAt = typeof remoteJson.updated_at === 'string' ? remoteJson.updated_at : null;
        const outcome = await applyEntityMergeResult(entityType, id, merged, { localUpdatedAt, remoteUpdatedAt });
        for (const conflict of settledPending) await deleteConflict(conflict.id);
        if (outcome.appliedFields.length > 0) result.entitiesUpdated++;
        if (outcome.appliedFields.length > 0 || outcome.conflictsRecorded > 0 || settledPending.length > 0 || republish) {
          const finalFields: Record<string, unknown> = { ...healed.local, ...merged.applied };
          if (outcome.appliedFields.length > 0) finalFields.updated_at = laterTimestamp(localUpdatedAt, remoteUpdatedAt) ?? finalFields.updated_at;
          // Fields now in conflict go into the tree as the remote's value
          // until the user picks — see overlayPendingConflicts().
          for (const conflict of merged.conflicts) finalFields[conflict.fieldName] = conflict.remoteValue;
          result.touchedEntities.push({ entityType, entityId: id, finalFields });
        }
        result.conflictsRecorded += outcome.conflictsRecorded;
      } else if (remoteJson) {
        // Doesn't exist locally at all yet — nothing to merge into, this
        // is a brand-new entity another device created. mergeEntity()
        // already fast-forwarded every field it knows about (local was
        // "no value" everywhere, same as base), but a create wants the
        // complete remote row, not just the subset mergeEntity() happened
        // to consider — createEntity() itself still allowlists/drops
        // whole-array fields, same safety net as the merge path.
        await createEntity(entityType, id, healed.remote);
        result.entitiesCreated++;
        result.touchedEntities.push({ entityType, entityId: id, finalFields: healed.remote });
      }
      // Neither exists locally nor has a remote value to create from
      // shouldn't be reachable (id came from one of the two file lists),
      // but isn't treated as an error if it somehow happens — just a no-op.
    } catch (err) {
      console.error(`SmartChef: failed to write merged ${entityType} ${id} into Local Storage:`, err);
      result.failedEntities.push({ entityType, entityId: id, error: err instanceof Error ? err.message : String(err) });
      // The merge result still goes into the tree. Keeping this device's old
      // file instead, under a merge commit that names the remote as parent,
      // told every device the remote's change had been undone here. The
      // database catches up from HEAD on the next sync (sync_repair).
      if (!result.touchedEntities.some((t) => t.entityType === entityType && t.entityId === id)) {
        const finalFields: Record<string, unknown> = localJson === null
          ? healed.remote
          : { ...healed.local, ...merged.applied, updated_at: laterTimestamp(localJson.updated_at as string, remoteJson.updated_at as string) ?? healed.local.updated_at };
        for (const conflict of merged.conflicts) finalFields[conflict.fieldName] = conflict.remoteValue;
        result.touchedEntities.push({ entityType, entityId: id, finalFields });
      }
    }
  }

  for (const { dirName, entityType } of ENTITY_DIRS) {
    const fieldNames = getMergeableFieldNames(entityType);
    if (!fieldNames) continue;

    const localIdsForType = entityIdsFromFiles(localFiles, dirName);
    const remoteIdsForType = entityIdsFromFiles(remoteFiles, dirName);
    result.entityScanCounts[entityType] = { remoteFiles: remoteIdsForType.length, localFiles: localIdsForType.length };
    const ids = new Set([...localIdsForType, ...remoteIdsForType]);

    if (entityType === 'recipe') {
      const orderedIds = await orderRecipeIdsByDependency(ids, dir, gitdir, localOid, remoteOid);
      for (const id of orderedIds) await applyOneEntity(dirName, entityType, fieldNames, id);
    } else if (entityType === 'ingredient') {
      const batches = await ingredientBatches([...ids], (id) => readEntityJson(dir, gitdir, remoteOid, `${dirName}/${id}.json`));
      for (const batch of batches) {
        await mapWithConcurrency(batch, TRANSFER_CONCURRENCY, (id) => applyOneEntity(dirName, entityType, fieldNames, id));
      }
    } else {
      await mapWithConcurrency([...ids], TRANSFER_CONCURRENCY, (id) => applyOneEntity(dirName, entityType, fieldNames, id));
    }
  }

  return result;
}

// ── Replacing this device's library with a remote commit ────────────────
// The engine behind gitSync.ts replaceLocalWithRemote() — `git reset --hard`
// for Local Storage. Read everything first, touch nothing until every file
// has parsed: a half-applied replace is worse than none.

export interface RemoteSnapshot {
  /** entityType -> id -> the synced JSON. */
  entities: Map<string, Map<string, Record<string, unknown>>>;
  /** Paths listed in the remote tree that could not be read or parsed. */
  unreadable: string[];
}

/** A soft-deleted row in the synced copy counts as absent. */
function isTombstone(json: Record<string, unknown>): boolean {
  return json.sync_status === 'deleted';
}

export async function readRemoteSnapshot(dir: string, gitdir: string, remoteOid: string): Promise<RemoteSnapshot> {
  const files = await git.listFiles({ fs: gitfs, dir, gitdir, ref: remoteOid, cache: gitCache() });
  const snapshot: RemoteSnapshot = { entities: new Map(), unreadable: [] };
  for (const { dirName, entityType } of ENTITY_DIRS) {
    const byId = new Map<string, Record<string, unknown>>();
    await mapWithConcurrency(entityIdsFromFiles(files, dirName), TRANSFER_CONCURRENCY, async (id) => {
      const filepath = `${dirName}/${id}.json`;
      const json = await readEntityJson(dir, gitdir, remoteOid, filepath);
      if (json === null) snapshot.unreadable.push(filepath);
      else if (!isTombstone(json)) byId.set(id, json);
    });
    snapshot.entities.set(entityType, byId);
  }
  return snapshot;
}

export interface ReplaceOutcome {
  /** Rows written from the synced copy, per entity type. */
  applied: Record<string, number>;
  /** Rows this device had that the synced library doesn't. */
  discarded: number;
  failedEntities: Array<{ entityType: string; entityId: string; error: string }>;
}

export async function applyRemoteSnapshot(
  dir: string,
  gitdir: string,
  remoteOid: string,
  snapshot: RemoteSnapshot,
  onProgress?: (done: number, total: number) => void
): Promise<ReplaceOutcome> {
  const outcome: ReplaceOutcome = { applied: {}, discarded: 0, failedEntities: [] };
  const total = [...snapshot.entities.values()].reduce((n, m) => n + m.size, 0);
  let done = 0;

  const localOnly = new Map<string, string[]>();
  for (const { entityType } of ENTITY_DIRS) {
    const remote = snapshot.entities.get(entityType) ?? new Map();
    localOnly.set(entityType, (await listLocalEntityIds(entityType)).filter((id) => !remote.has(id)));
  }

  async function discard(entityType: string) {
    for (const id of localOnly.get(entityType) ?? []) {
      try {
        await discardLocalEntity(entityType, id);
        outcome.discarded++;
      } catch (err) {
        outcome.failedEntities.push({ entityType, entityId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function apply(entityType: string, id: string, json: Record<string, unknown>) {
    try {
      await forceApplyEntity(entityType, id, json);
      outcome.applied[entityType] = (outcome.applied[entityType] ?? 0) + 1;
    } catch (err) {
      console.error(`SmartChef: replacing ${entityType} ${id} failed:`, err);
      outcome.failedEntities.push({ entityType, entityId: id, error: err instanceof Error ? err.message : String(err) });
    }
    onProgress?.(++done, total);
  }

  // Local-only recipes go first: they are what could still reference a
  // local-only ingredient or tool that is about to be discarded.
  await discard('recipe');
  for (const { entityType } of ENTITY_DIRS) {
    if (entityType === 'recipe') continue;
    const byId = snapshot.entities.get(entityType) ?? new Map<string, Record<string, unknown>>();
    const batches = entityType === 'ingredient'
      ? await ingredientBatches([...byId.keys()], async (id) => byId.get(id) ?? null)
      : [[...byId.keys()]];
    for (const batch of batches) for (const id of batch) await apply(entityType, id, byId.get(id)!);
  }
  const recipes = snapshot.entities.get('recipe') ?? new Map();
  for (const id of await orderRecipeIdsByDependency(new Set(recipes.keys()), dir, gitdir, null, remoteOid)) {
    await apply('recipe', id, recipes.get(id)!);
  }
  for (const { entityType } of ENTITY_DIRS) {
    if (entityType !== 'recipe') await discard(entityType);
  }
  await clearAllConflicts();
  return outcome;
}
