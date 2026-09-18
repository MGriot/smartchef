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
const dbEntities: Record<string, Map<string, Record<string, unknown>>> = { recipe: new Map(), ingredient: new Map(), tool: new Map() };
const dbConflicts: Array<{ entityType: string; entityId: string; fieldName: string }> = [];
// Settable per-test to simulate one specific entity's write throwing (a
// malformed field shape, a constraint violation) without needing a real
// SQLite error — see the "one bad entity doesn't abort the rest" test.
let createEntityShouldThrowFor: string | null = null;
// Records the order createEntity() actually ran in — what the ordering
// tests (entity types, matrioska/sub-recipe dependency) assert against.
const creationOrder: Array<{ entityType: string; entityId: string }> = [];

vi.mock('../../services/conflicts.local', () => ({
  loadPendingConflictIndex: async () => new Map(),
  laterTimestamp: (a: string | null | undefined, b: string | null | undefined) => b ?? a ?? null,
  deleteConflict: async () => {},
  entityExists: async (entityType: string, entityId: string) => dbEntities[entityType]?.has(entityId) ?? false,
  createEntity: async (entityType: string, entityId: string, fields: Record<string, unknown>) => {
    if (entityId === createEntityShouldThrowFor) throw new Error(`simulated write failure for ${entityId}`);
    creationOrder.push({ entityType, entityId });
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
    entityType === 'recipe' ? ['title', 'servings', 'steps']
    : entityType === 'ingredient' ? ['name', 'calories_kcal']
    : entityType === 'tool' ? ['name', 'deleted_at']
    : null,
}));

let mergeRemoteIntoLocal: typeof import('./mergeBridge').mergeRemoteIntoLocal;

beforeEach(async () => {
  for (const key of Object.keys(trees)) delete trees[key];
  dbEntities.recipe.clear();
  dbEntities.ingredient.clear();
  dbEntities.tool.clear();
  dbConflicts.length = 0;
  createEntityShouldThrowFor = null;
  creationOrder.length = 0;
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
    expect(result).toEqual({ entitiesCreated: 0, entitiesUpdated: 0, conflictsRecorded: 0, touchedEntities: [], failedEntities: [], entityScanCounts: {}, autoResolved: 0, remoteOnlyFiles: [] });
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

  it('one entity failing to write does not abort the rest of the batch — each entity is isolated', async () => {
    createEntityShouldThrowFor = 'bad-recipe';
    trees['local'] = {};
    trees['remote'] = {
      'recipes/bad-recipe.json': { title: 'Malformed', servings: 4 },
      'recipes/good-recipe.json': { title: 'Fine', servings: 2 },
    };
    trees[baseKey('local', 'remote')] = {};

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.entitiesCreated).toBe(1);
    expect(dbEntities.recipe.get('good-recipe')).toEqual({ id: 'good-recipe', title: 'Fine', servings: 2 });
    expect(dbEntities.recipe.has('bad-recipe')).toBe(false);
    expect(result.failedEntities).toEqual([{ entityType: 'recipe', entityId: 'bad-recipe', error: 'simulated write failure for bad-recipe' }]);
  });

  it('surfaces a failedEntities entry when a file the remote tree lists fails to read, instead of silently treating it as unchanged', async () => {
    // Regression test for a real, shipped, production bug: an entity type
    // could produce zero applied fields for EVERY one of its entities,
    // forever, with no visible error anywhere — because readEntityJson()
    // deliberately can't tell "this file legitimately doesn't exist at
    // this commit" apart from "this file is listed but its blob failed to
    // read" (see that function's own comment) and mergeEntity() treats an
    // empty remote object as "nothing changed" either way. This is the
    // one place that CAN tell them apart, using the tree listing itself.
    trees['local'] = {};
    trees['remote'] = { 'ingredients/i1.json': { name: 'Salt', calories_kcal: 0 } };
    trees[baseKey('local', 'remote')] = {};

    const git = await import('isomorphic-git');
    const realReadBlob = git.readBlob;
    // Reject specifically for the remote-side read (Promise.all fires
    // base/local/remote concurrently, in no guaranteed completion order,
    // so a plain mockRejectedValueOnce could just as easily hit the
    // base or local read instead of the one this test actually cares
    // about) — the base/local reads fall through to the real (fake)
    // implementation, which already correctly no-ops for a nonexistent
    // path in an empty tree.
    const readBlobSpy = vi.spyOn(git, 'readBlob').mockImplementation(async (args) => {
      if (args.oid === 'remote') throw new Error('simulated blob read failure');
      return realReadBlob(args);
    });

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    readBlobSpy.mockRestore();
    expect(dbEntities.ingredient.has('i1')).toBe(false); // never created — mergeEntity() saw nothing to apply
    expect(result.entitiesCreated).toBe(0);
    expect(result.failedEntities).toEqual([
      { entityType: 'ingredient', entityId: 'i1', error: expect.stringContaining('sync history') },
    ]);
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

    expect(result).toEqual({
      entitiesCreated: 0,
      entitiesUpdated: 0,
      conflictsRecorded: 0,
      touchedEntities: [],
      failedEntities: [],
      autoResolved: 0,
      remoteOnlyFiles: [],
      entityScanCounts: {
        ingredient: { remoteFiles: 0, localFiles: 0 },
        tool: { remoteFiles: 0, localFiles: 0 },
        recipe: { remoteFiles: 1, localFiles: 1 },
      },
    });
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

  it('creates ingredients (and other leaf types) before recipes, so a recipe never gets written ahead of what it references', async () => {
    trees['local'] = {};
    trees['remote'] = {
      // Deliberately listed recipe-first in the source tree — proves the
      // ordering comes from ENTITY_DIRS processing recipes last, not from
      // this test happening to already list things in a lucky order.
      'recipes/r1.json': { title: 'Lasagna' },
      'ingredients/i1.json': { name: 'Tomato' },
      'tools/t1.json': { name: 'Whisk' },
    };

    await mergeRemoteIntoLocal('/dir', '/dir/.git', null, 'remote');

    const recipeIndex = creationOrder.findIndex((c) => c.entityType === 'recipe');
    const ingredientIndex = creationOrder.findIndex((c) => c.entityType === 'ingredient');
    const toolIndex = creationOrder.findIndex((c) => c.entityType === 'tool');
    expect(ingredientIndex).toBeLessThan(recipeIndex);
    expect(toolIndex).toBeLessThan(recipeIndex);
  });

  it('orders a "matrioska" recipe (one that uses another recipe as a sub-recipe ingredient) after the recipe it depends on', async () => {
    trees['local'] = {};
    trees['remote'] = {
      // Listed in dependency-violating order on purpose: the recipe that
      // NEEDS the other one comes first in the source tree, so this only
      // passes if orderRecipeIdsByDependency() actually reorders it.
      'recipes/mother-sauce-lasagna.json': { title: 'Lasagna', ingredients: [{ sub_recipe_id: 'bechamel' }] },
      'recipes/bechamel.json': { title: 'Bechamel Sauce', ingredients: [] },
    };

    await mergeRemoteIntoLocal('/dir', '/dir/.git', null, 'remote');

    const bechamelIndex = creationOrder.findIndex((c) => c.entityId === 'bechamel');
    const lasagnaIndex = creationOrder.findIndex((c) => c.entityId === 'mother-sauce-lasagna');
    expect(bechamelIndex).toBeLessThan(lasagnaIndex);
  });

  it('does not hang on a genuine sub-recipe cycle — falls back to processing what remains rather than looping forever', async () => {
    trees['local'] = {};
    trees['remote'] = {
      'recipes/a.json': { title: 'A', ingredients: [{ sub_recipe_id: 'b' }] },
      'recipes/b.json': { title: 'B', ingredients: [{ sub_recipe_id: 'a' }] },
    };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', null, 'remote');

    expect(result.entitiesCreated).toBe(2);
    expect(dbEntities.recipe.has('a')).toBe(true);
    expect(dbEntities.recipe.has('b')).toBe(true);
  });

  it('also covers non-recipe/ingredient entity types wired into ENTITY_DIRS (e.g. tools)', async () => {
    trees['local'] = {};
    trees['remote'] = { 'tools/t1.json': { name: 'Whisk' } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', null, 'remote');

    expect(result.entitiesCreated).toBe(1);
    expect(dbEntities.tool.get('t1')).toEqual({ id: 't1', name: 'Whisk' });
  });

  it('propagates a soft-delete tombstone (deleted_at) as a fast-forwarded field, same as any other scalar', async () => {
    dbEntities.tool.set('t1', { id: 't1', name: 'Whisk', deleted_at: null });
    trees[baseKey('local', 'remote')] = { 'tools/t1.json': { name: 'Whisk', deleted_at: null } };
    trees['local'] = { 'tools/t1.json': { name: 'Whisk', deleted_at: null } };
    trees['remote'] = { 'tools/t1.json': { name: 'Whisk', deleted_at: '2026-08-20T00:00:00.000Z' } };

    const result = await mergeRemoteIntoLocal('/dir', '/dir/.git', 'local', 'remote');

    expect(result.entitiesUpdated).toBe(1);
    expect(dbEntities.tool.get('t1')?.deleted_at).toBe('2026-08-20T00:00:00.000Z');
  });
});
