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
// Recipes/ingredients only (matching the old design's scope — tools/tags/
// techniques were never committed to git there either); expanding that is
// a separate, later piece.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { mergeEntity } from '../structuredMerge';
import { entityExists, createEntity, applyEntityMergeResult, getMergeableFieldNames } from '../../services/conflicts.local';

const ENTITY_DIRS: Array<{ dirName: string; entityType: string }> = [
  { dirName: 'recipes', entityType: 'recipe' },
  { dirName: 'ingredients', entityType: 'ingredient' },
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

export interface MergeBridgeResult {
  entitiesCreated: number;
  entitiesUpdated: number;
  conflictsRecorded: number;
}

/** Merges a freshly-fetched remote commit into local state. No-op (all
 *  zero) when localOid === remoteOid — nothing to reconcile. Does NOT
 *  advance any ref or touch the working tree itself; the caller (syncNow())
 *  owns deciding what the Hidden Clone's own next commit looks like once
 *  Local Storage reflects the merge outcome. */
export async function mergeRemoteIntoLocal(dir: string, gitdir: string, localOid: string, remoteOid: string): Promise<MergeBridgeResult> {
  const result: MergeBridgeResult = { entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0 };
  if (localOid === remoteOid) return result;

  const mergeBaseOids = await git.findMergeBase({ fs: gitfs, dir, gitdir, oids: [localOid, remoteOid] });
  const baseOid: string | null = mergeBaseOids[0] ?? null;

  const [localFiles, remoteFiles] = await Promise.all([
    git.listFiles({ fs: gitfs, dir, gitdir, ref: localOid }),
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
        if (outcome.appliedFields.length > 0) result.entitiesUpdated++;
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
      }
      // Neither exists locally nor has a remote value to create from
      // shouldn't be reachable (id came from one of the two file lists),
      // but isn't treated as an error if it somehow happens — just a no-op.
    }
  }

  return result;
}
