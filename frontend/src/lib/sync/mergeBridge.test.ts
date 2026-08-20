import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real structuredMerge.ts is used unmocked — it's pure and already
// thoroughly tested on its own; exercising it for real here is what
// actually proves the bridge wires it up correctly, not just that it's
// called with *some* arguments.
vi.mock('../gitfs', () => ({ gitfs: {} }));

interface FakeCommitTree {
  [filepath: string]: Record<string, unknown>;
}
const trees: Record<string, FakeCommitTree> = {}; // oid -> {filepath: parsedJson}

vi.mock('isomorphic-git', () => ({
  findMergeBase: async ({ oids }: { oids: string[] }) => {
    // Tests set `trees['base']` as the merge-base tree and pass 'base' as a synthetic oid
    // via the mocked resolution below — findMergeBase itself just needs to return *an* oid.
    return [`${oids[0]}-${oids[1]}-base`];
  },
  listFiles: async ({ ref }: { ref: string }) => {
    const tree = trees[ref] ?? {};
    return Object.keys(tree);
  },
  readBlob: async ({ oid, filepath }: { oid: string; filepath: string }) => {
    const tree = trees[oid] ?? {};
    if (!(filepath in tree)) throw new Error(`ENOENT: no blob for '${filepath}' at '${oid}'`);
    return { oid: 'blob-oid', blob: new TextEncoder().encode(JSON.stringify(tree[filepath])) };
  },
}));

// Lightweight in-memory fake standing in for services/conflicts.local.ts —
// verifies the bridge's orchestration (create vs. merge, which fields,
// conflicts recorded) without re-exercising that module's own SQL, which
// conflicts.local.test.ts already covers thoroughly.
const dbEntities: Record<string, Map<string, Record<string, unknown>>> = { recipe: new Map(), ingredient: new Map() };
const dbConflicts: Array<{ entityType: string; entityId: string; fieldName: string }> = [];

vi.mock('../../services/conflicts.local', () => ({
  entityExists: async (entityType: string, entityId: string) => dbEntities[entityType]?.has(entityId) ?? false,
  createEntity: async (entityType: string, entityId: string, fields: Record<string, unknown>) => {
    dbEntities[entityType].set(entityId, { id: entityId, ...fields });
  },
  applyEntityMergeResult: async (entityType: string, entityId: string, result: { applied: Record<string, unknown>; conflicts: Array<{ fieldName: string }> }) => {
    const row = dbEntities[entityType].get(entityId) ?? { id: entityId };
    for (const [k, v] of Object.entries(result.applied)) row[k] = v;
    dbEntities[entityType].set(entityId, row);
    for (const c of result.conflicts) dbConflicts.push({ entityType, entityId, fieldName: c.fieldName });
    return { appliedFields: Object.keys(result.applied), unsupportedFields: [], conflictsRecorded: result.conflicts.length };
  },
  getMergeableFieldNames: (entityType: string) =>
    entityType === 'recipe' ? ['title', 'servings', 'steps'] : entityType === 'ingredient' ? ['name', 'calories_kcal'] : null,
}));

let mergeRemoteIntoLocal: typeof import('./mergeBridge').mergeRemoteIntoLocal;

beforeEach(async () => {
  for (const key of Object.keys(trees)) delete trees[key];
  dbEntities.recipe.clear();
  dbEntities.ingredient.clear();
  dbConflicts.length = 0;
  vi.resetModules();
  ({ mergeRemoteIntoLocal } = await import('./mergeBridge'));
});

// findMergeBase is mocked to always return `${local}-${remote}-base` — set
// that key in `trees` to control what the "common ancestor" looks like.
function baseKey(localOid: string, remoteOid: string): string {
  return `${localOid}-${remoteOid}-base`;
}

describe('mergeRemoteIntoLocal', () => {
  it('does nothing when local and remote are the same commit', async () => {
    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'same-oid', 'same-oid');
    expect(result).toEqual({ entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [] });
  });

  it('creates a brand-new entity that only exists on the remote side', async () => {
    trees['local'] = {};
    trees['remote'] = { 'recipes/r1.json': { title: 'Lasagna', servings: 4 } };
    trees[baseKey('local', 'remote')] = {};

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.entitiesCreated).toBe(1);
    expect(dbEntities.recipe.get('r1')).toEqual({ id: 'r1', title: 'Lasagna', servings: 4 });
    expect(result.touchedEntities).toEqual([{ entityType: 'recipe', entityId: 'r1', finalFields: { title: 'Lasagna', servings: 4 } }]);
  });

  it('fast-forwards a field that only changed on the remote for an entity that already exists locally', async () => {
    dbEntities.recipe.set('r1', { id: 'r1', title: 'Lasagna', servings: 4 });
    trees[baseKey('local', 'remote')] = { 'recipes/r1.json': { title: 'Lasagna', servings: 4 } };
    trees['local'] = { 'recipes/r1.json': { title: 'Lasagna', servings: 4 } };
    trees['remote'] = { 'recipes/r1.json': { title: 'Lasagna', servings: 6 } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.entitiesUpdated).toBe(1);
    expect(dbEntities.recipe.get('r1')?.servings).toBe(6);
    // finalFields = local's last-committed content overlaid with the fast-forwarded field —
    // ready to re-serialize into the Hidden Clone's next commit as-is.
    expect(result.touchedEntities).toEqual([{ entityType: 'recipe', entityId: 'r1', finalFields: { title: 'Lasagna', servings: 6 } }]);
  });

  it('records a conflict when both sides changed the same field to different values', async () => {
    dbEntities.recipe.set('r1', { id: 'r1', title: "Grandma's Lasagna" });
    trees[baseKey('local', 'remote')] = { 'recipes/r1.json': { title: 'Lasagna' } };
    trees['local'] = { 'recipes/r1.json': { title: "Grandma's Lasagna" } };
    trees['remote'] = { 'recipes/r1.json': { title: "Nonna's Lasagna" } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.conflictsRecorded).toBe(1);
    expect(dbConflicts).toEqual([{ entityType: 'recipe', entityId: 'r1', fieldName: 'title' }]);
    // The conflicted field itself is untouched locally — only handled via the Conflict record.
    expect(dbEntities.recipe.get('r1')?.title).toBe("Grandma's Lasagna");
  });

  it('does nothing for an entity that is byte-identical on both sides', async () => {
    dbEntities.recipe.set('r1', { id: 'r1', title: 'Lasagna' });
    trees[baseKey('local', 'remote')] = { 'recipes/r1.json': { title: 'Lasagna' } };
    trees['local'] = { 'recipes/r1.json': { title: 'Lasagna' } };
    trees['remote'] = { 'recipes/r1.json': { title: 'Lasagna' } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result).toEqual({ entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [] });
  });

  it('treats every remote entity as new when this device has no local commits yet (first sync)', async () => {
    trees['remote'] = { 'recipes/r1.json': { title: 'Lasagna', servings: 4 } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', null, 'remote');

    expect(result.entitiesCreated).toBe(1);
    expect(dbEntities.recipe.get('r1')).toEqual({ id: 'r1', title: 'Lasagna', servings: 4 });
  });

  it('merges across both entity types (recipes and ingredients) in one call', async () => {
    trees[baseKey('local', 'remote')] = {};
    trees['local'] = {};
    trees['remote'] = {
      'recipes/r1.json': { title: 'Lasagna' },
      'ingredients/i1.json': { name: 'Tomato' },
    };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.entitiesCreated).toBe(2);
    expect(dbEntities.recipe.has('r1')).toBe(true);
    expect(dbEntities.ingredient.has('i1')).toBe(true);
  });
});
