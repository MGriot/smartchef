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

const ENTITY_DIRS: Array<{ dirName: string; entityType: string }> = [
  { dirName: 'recipes', entityType: 'recipe' },
  { dirName: 'ingredients', entityType: 'ingredient' },
  { dirName: 'tools', entityType: 'tool' },
  { dirName: 'tags', entityType: 'tag' },
  { dirName: 'techniques', entityType: 'technique' },
  { dirName: 'profiles', entityType: 'profile' },
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
  const result: MergeBridgeResult = { entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [] };
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

    for (const id of ids) {
      const filepath = `${dirName}/${id}.json`;
      const [baseJson, localJson, remoteJson] = await Promise.all([
        readEntityJson(dir, gitdir, baseOid, filepath),
        readEntityJson(dir, gitdir, localOid, filepath),
        readEntityJson(dir, gitdir, remoteOid, filepath),
      ]);

      const merged = mergeEntity(baseJson ?? {}, localJson ?? {}, remoteJson ?? {}, fieldNames);
      if (Object.keys(merged.applied).length === 0 && merged.conflicts.length === 0) continue;

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
    }
  }

  return result;
}
