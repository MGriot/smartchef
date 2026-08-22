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
import { mergeEntity } from '../structuredMerge';
import { entityExists, createEntity, applyEntityMergeResult, getMergeableFieldNames } from '../../services/conflicts.local';

// Recipes reference ingredients/tools by id (recipe_ingredients.ingredient_id/
// unit_id, recipe_steps.tool_ids/technique_ids) — nothing in Local Storage
// enforces those as real foreign keys (no PRAGMA foreign_keys here), so a
// recipe written before what it references exists doesn't throw, but it
// does leave a dangling reference until the rest of the batch catches up.
// Combined with each entity's write now being isolated (one failure
// doesn't abort the batch — see the try/catch below), a later entity that
// *does* fail would leave that dangling reference permanent, not just
// transient. Processing leaf types first and recipes last means every
// recipe is written after everything it could reference already exists.
const ENTITY_DIRS: Array<{ dirName: string; entityType: string }> = [
  { dirName: 'ingredients', entityType: 'ingredient' },
  { dirName: 'tools', entityType: 'tool' },
  { dirName: 'tags', entityType: 'tag' },
  { dirName: 'techniques', entityType: 'technique' },
  { dirName: 'profiles', entityType: 'profile' },
  { dirName: 'recipes', entityType: 'recipe' },
];

async function readEntityJson(dir: string, gitdir: string, oid: string | null, filepath: string): Promise<Record<string, unknown> | null> {
  if (!oid) return null;
  try {
    const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath });
    return JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
  } catch {
    return null; // absent at this commit (never existed there, or a corrupt blob) — treated as "no value", same tolerance reconcileEntity() already has for a bad file
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
export async function mergeRemoteIntoLocal(dir: string, gitdir: string, localOid: string | null, remoteOid: string): Promise<MergeBridgeResult> {
  const result: MergeBridgeResult = { entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [], failedEntities: [] };
  if (localOid === remoteOid) return result;

  const baseOid: string | null = localOid
    ? (await git.findMergeBase({ fs: gitfs, dir, gitdir, oids: [localOid, remoteOid] }))[0] ?? null
    : null;

  const [localFiles, remoteFiles] = await Promise.all([
    localOid ? git.listFiles({ fs: gitfs, dir, gitdir, ref: localOid }) : Promise.resolve([]),
    git.listFiles({ fs: gitfs, dir, gitdir, ref: remoteOid }),
  ]);

  for (const { dirName, entityType } of ENTITY_DIRS) {
    const fieldNames = getMergeableFieldNames(entityType);
    if (!fieldNames) continue;

    const ids = new Set([...entityIdsFromFiles(localFiles, dirName), ...entityIdsFromFiles(remoteFiles, dirName)]);
    const orderedIds = entityType === 'recipe' ? await orderRecipeIdsByDependency(ids, dir, gitdir, localOid, remoteOid) : [...ids];

    for (const id of orderedIds) {
      const filepath = `${dirName}/${id}.json`;
      const [baseJson, localJson, remoteJson] = await Promise.all([
        readEntityJson(dir, gitdir, baseOid, filepath),
        readEntityJson(dir, gitdir, localOid, filepath),
        readEntityJson(dir, gitdir, remoteOid, filepath),
      ]);

      const merged = mergeEntity(baseJson ?? {}, localJson ?? {}, remoteJson ?? {}, fieldNames);
      if (Object.keys(merged.applied).length === 0 && merged.conflicts.length === 0) continue;

      // One malformed entity (a field shape this device's schema version
      // doesn't expect, a write that violates a constraint the source
      // device didn't have) must not silently abort every entity after it
      // in iteration order — Set iteration order isn't something a caller
      // should ever have their whole sync's completeness depend on. Each
      // entity gets its own outcome; a thrown write here is recorded and
      // skipped, not propagated.
      try {
        if (await entityExists(entityType, id)) {
          const outcome = await applyEntityMergeResult(entityType, id, merged);
          if (outcome.appliedFields.length > 0) {
            result.entitiesUpdated++;
            result.touchedEntities.push({ entityType, entityId: id, finalFields: { ...localJson, ...merged.applied } });
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
          await createEntity(entityType, id, remoteJson);
          result.entitiesCreated++;
          result.touchedEntities.push({ entityType, entityId: id, finalFields: remoteJson });
        }
        // Neither exists locally nor has a remote value to create from
        // shouldn't be reachable (id came from one of the two file lists),
        // but isn't treated as an error if it somehow happens — just a no-op.
      } catch (err) {
        console.error(`SmartChef: failed to write merged ${entityType} ${id} into Local Storage:`, err);
        result.failedEntities.push({ entityType, entityId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}
