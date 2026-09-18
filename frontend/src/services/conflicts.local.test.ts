// Fakes db/local's query()/queryOne() surface at the same abstraction level
// testUtils/fakes.ts's createFakeDb() already uses for gitSync tests — an
// in-memory table routed by matching the small, fixed set of SQL templates
// conflicts.local.ts actually generates, not a real SQL engine.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Row {
  id: string;
  entity_type: string;
  entity_id: string;
  field_name: string;
  base_value: string | null;
  local_value: string | null;
  remote_value: string | null;
  detected_at: string;
}

const rows: Row[] = [];
let now = 0;

// Generic entity tables (recipes/ingredients/etc.) — just enough to exercise
// applyResolvedConflict()/getEntityDisplayName()'s SELECT <col>/UPDATE <col>
// shape, not full relational fidelity.
const entityTables: Record<string, Map<string, Record<string, unknown>>> = {
  recipes: new Map(),
  ingredients: new Map(),
  tools: new Map(),
  tags: new Map(),
  techniques: new Map(),
};

// recipe_ingredients/recipe_steps/recipe_tools — normalized child tables
// writeArrayField() delete+reinserts into, keyed by table name, each row a
// plain object. No `id`-keyed Map here (recipe_tools has no `id` column at
// all, a composite recipe_id+tool_id key instead) — a flat array per table
// is enough to exercise delete-then-reinsert semantics.
const childTables: Record<string, Array<Record<string, unknown>>> = {
  recipe_ingredients: [],
  recipe_steps: [],
  recipe_tools: [],
};

vi.mock('../db/local', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const trimmed = sql.trim();
    // Multi-line INSERT/DELETE templates (readability in the real SQL)
    // collapse to one line here so the same regexes match regardless of
    // how the production query string wraps.
    const normalized = trimmed.replace(/\s+/g, ' ');

    const childDeleteMatch = normalized.match(/^DELETE FROM (recipe_ingredients|recipe_steps|recipe_tools) WHERE recipe_id = \$1$/);
    if (childDeleteMatch) {
      const [, table] = childDeleteMatch;
      const [recipeId] = params as string[];
      childTables[table] = childTables[table].filter((r) => r.recipe_id !== recipeId);
      return [];
    }

    // Trailing ON CONFLICT(id) DO UPDATE SET ... is optional in the match so
    // this fake also accepts the pre-upsert-fix SQL shape — only the id-
    // collision test below actually depends on the upsert clause being
    // present and honored.
    const childInsertMatch = normalized.match(/^INSERT INTO (recipe_ingredients|recipe_steps) \(([^)]+)\) VALUES \(([^)]+)\)(?: ON CONFLICT\(id\) DO UPDATE SET .+)?$/);
    if (childInsertMatch) {
      const [, table, columnsRaw] = childInsertMatch;
      const columns = columnsRaw.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => { row[col] = params[i]; });
      // Real SQLite upsert semantics: a row with this id already existing
      // ANYWHERE (not just under the same recipe_id — id is the table's
      // global primary key, see writeArrayField()'s own doc comment) gets
      // fully replaced in place rather than causing a duplicate-key error.
      const existingIdx = childTables[table].findIndex((r) => r.id === row.id);
      if (existingIdx !== -1) childTables[table][existingIdx] = row;
      else childTables[table].push(row);
      return [];
    }

    if (normalized === 'INSERT INTO recipe_tools (recipe_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING') {
      const [recipeId, toolId] = params as string[];
      const already = childTables.recipe_tools.some((r) => r.recipe_id === recipeId && r.tool_id === toolId);
      if (!already) childTables.recipe_tools.push({ recipe_id: recipeId, tool_id: toolId });
      return [];
    }

    const updateMatch = trimmed.match(/^UPDATE (\w+) SET (\w+) = \$1, updated_at = now\(\) WHERE id = \$2$/);
    if (updateMatch) {
      const [, table, col] = updateMatch;
      const [value, id] = params;
      const row = entityTables[table]?.get(id as string);
      if (!row) throw new Error(`fake db/local: no row '${id}' in '${table}'`);
      row[col] = value;
      return [];
    }

    const insertMatch = trimmed.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT\(id\) DO NOTHING$/);
    if (insertMatch && insertMatch[1] !== 'sync_conflicts') {
      const [, table, columnsRaw] = insertMatch;
      const columns = columnsRaw.split(',').map((c) => c.trim());
      const targetTable = entityTables[table];
      if (!targetTable) throw new Error(`fake db/local: unknown table '${table}'`);
      const id = params[0] as string;
      if (targetTable.has(id)) return []; // ON CONFLICT DO NOTHING
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => { row[col] = params[i]; });
      targetTable.set(id, row);
      return [];
    }

    if (trimmed.startsWith('INSERT INTO sync_conflicts')) {
      const [id, entity_type, entity_id, field_name, base_value, local_value, remote_value] = params as string[];
      const existing = rows.find((r) => r.entity_type === entity_type && r.entity_id === entity_id && r.field_name === field_name);
      const detected_at = `t${now++}`;
      if (existing) {
        // local_value deliberately NOT overwritten on upsert — see
        // conflicts.local.ts's upsertConflict() doc comment.
        existing.base_value = base_value;
        existing.remote_value = remote_value;
        existing.detected_at = detected_at;
      } else {
        rows.push({ id, entity_type, entity_id, field_name, base_value, local_value, remote_value, detected_at });
      }
      return [];
    }

    if (trimmed.startsWith('SELECT * FROM sync_conflicts WHERE entity_type')) {
      const [entity_type, entity_id] = params as string[];
      return rows.filter((r) => r.entity_type === entity_type && r.entity_id === entity_id);
    }

    if (trimmed.startsWith('SELECT * FROM sync_conflicts ORDER BY detected_at DESC')) {
      return [...rows].sort((a, b) => (a.detected_at < b.detected_at ? 1 : -1));
    }

    if (trimmed.startsWith('DELETE FROM sync_conflicts WHERE id')) {
      const [id] = params as string[];
      const idx = rows.findIndex((r) => r.id === id);
      if (idx !== -1) rows.splice(idx, 1);
      return [];
    }

    // Step / ingredient-row translations (ADR 0006) ride along with the
    // whole-array writes; nothing here asserts on them.
    if (/^(DELETE FROM|INSERT INTO) recipe_(step|ingredient)_translations/.test(trimmed)) return [];

    throw new Error(`fake db/local: unrecognized query — ${sql}`);
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    const trimmed = sql.trim();
    if (trimmed.startsWith('SELECT * FROM sync_conflicts WHERE id')) {
      const [id] = params as string[];
      return rows.find((r) => r.id === id) ?? null;
    }
    const existsMatch = trimmed.match(/^SELECT id FROM (\w+) WHERE id = \$1$/);
    if (existsMatch) {
      const [, table] = existsMatch;
      const [id] = params as string[];
      return entityTables[table]?.has(id) ? { id } : null;
    }
    const selectMatch = trimmed.match(/^SELECT (\w+) as name FROM (\w+) WHERE id = \$1$/);
    if (selectMatch) {
      const [, col, table] = selectMatch;
      const [id] = params as string[];
      const row = entityTables[table]?.get(id);
      return row ? { name: row[col] } : null;
    }
    throw new Error(`fake db/local: unrecognized queryOne — ${sql}`);
  }),
}));

const { upsertConflict, listPendingConflicts, listPendingConflictsForEntity, resolveConflict, applyResolvedConflict, getEntityDisplayName, applyEntityMergeResult, entityExists, createEntity, getMergeableFieldNames } = await import('./conflicts.local');

beforeEach(() => {
  rows.length = 0;
  now = 0;
  for (const table of Object.values(entityTables)) table.clear();
  for (const table of Object.keys(childTables)) childTables[table] = [];
});

describe('upsertConflict', () => {
  it('creates one row for a new (entity, field) conflict', async () => {
    await upsertConflict({
      entityType: 'recipe', entityId: 'r1', fieldName: 'title',
      baseValue: 'Lasagna', localValue: "Grandma's Lasagna", remoteValue: "Nonna's Lasagna",
    });
    const all = await listPendingConflicts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      entityType: 'recipe', entityId: 'r1', fieldName: 'title',
      baseValue: 'Lasagna', localValue: "Grandma's Lasagna", remoteValue: "Nonna's Lasagna",
    });
  });

  it('upserts in place on a repeated sync for the same (entity, field) — no duplicate row', async () => {
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'title', baseValue: 'A', localValue: 'B', remoteValue: 'C' });
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'title', baseValue: 'A', localValue: 'B', remoteValue: 'D' });
    const all = await listPendingConflicts();
    expect(all).toHaveLength(1);
    expect(all[0].remoteValue).toBe('D');
  });

  it('does not refresh local_value on a repeated upsert — it stays pinned to what was first detected', async () => {
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'title', baseValue: 'A', localValue: 'first-local', remoteValue: 'C' });
    // Second sync: remote moved on again, and (hypothetically) this device's
    // own field also changed locally in between — but the pinned local_value
    // should NOT pick that up, since the conflict already captured it.
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'title', baseValue: 'A', localValue: 'second-local', remoteValue: 'D' });

    const [conflict] = await listPendingConflicts();
    expect(conflict.localValue).toBe('first-local');
    expect(conflict.remoteValue).toBe('D');
  });

  it('keeps conflicts on different fields of the same entity independent', async () => {
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'title', baseValue: 'A', localValue: 'B', remoteValue: 'C' });
    await upsertConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'steps', baseValue: [1], localValue: [1, 2], remoteValue: [1, 3] });
    const all = await listPendingConflictsForEntity('recipe', 'r1');
    expect(all.map((c) => c.fieldName).sort()).toEqual(['steps', 'title']);
  });

  it('round-trips array-valued fields (whole-array conflicts, per ADR 0002)', async () => {
    await upsertConflict({
      entityType: 'recipe', entityId: 'r1', fieldName: 'steps',
      baseValue: ['a', 'b'], localValue: ['a', 'b', 'c'], remoteValue: ['a'],
    });
    const [conflict] = await listPendingConflicts();
    expect(conflict.localValue).toEqual(['a', 'b', 'c']);
    expect(conflict.remoteValue).toEqual(['a']);
  });
});

describe('resolveConflict', () => {
  it('deletes the conflict and reports the chosen value', async () => {
    await upsertConflict({ entityType: 'ingredient', entityId: 'i1', fieldName: 'calories_kcal', baseValue: 110, localValue: 120, remoteValue: 95 });
    const [{ id }] = await listPendingConflicts();

    const resolved = await resolveConflict(id, 'remote');

    expect(resolved).toEqual({ entityType: 'ingredient', entityId: 'i1', fieldName: 'calories_kcal', chosenValue: 95 });
    expect(await listPendingConflicts()).toHaveLength(0);
  });

  it('resolving "local" reports the local value, not the remote one', async () => {
    await upsertConflict({ entityType: 'ingredient', entityId: 'i1', fieldName: 'calories_kcal', baseValue: 110, localValue: 120, remoteValue: 95 });
    const [{ id }] = await listPendingConflicts();

    const resolved = await resolveConflict(id, 'local');

    expect(resolved?.chosenValue).toBe(120);
  });

  it('returns null for an id that is not a pending conflict', async () => {
    expect(await resolveConflict('does-not-exist', 'local')).toBeNull();
  });
});

describe('applyResolvedConflict', () => {
  it('writes the chosen value onto the entity row for a recognized scalar field', async () => {
    entityTables.ingredients.set('i1', { id: 'i1', calories_kcal: 120 });

    await applyResolvedConflict({ entityType: 'ingredient', entityId: 'i1', fieldName: 'calories_kcal', chosenValue: 95 });

    expect(entityTables.ingredients.get('i1')?.calories_kcal).toBe(95);
  });

  it('rejects an unrecognized field name rather than trusting it into SQL', async () => {
    entityTables.ingredients.set('i1', { id: 'i1' });
    await expect(
      applyResolvedConflict({ entityType: 'ingredient', entityId: 'i1', fieldName: 'DROP TABLE ingredients', chosenValue: 'x' })
    ).rejects.toThrow(/not a recognized/);
  });

  it('rejects an unknown entity type', async () => {
    await expect(
      applyResolvedConflict({ entityType: 'not-a-real-entity', entityId: 'x', fieldName: 'name', chosenValue: 'x' })
    ).rejects.toThrow();
  });

  it('writes a resolved whole-array field (steps) as a delete+reinsert of recipe_steps, same as an automatic fast-forward', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });
    childTables.recipe_steps.push({ id: 'stale', recipe_id: 'r1', step_number: 1, description: 'Old step' });

    await applyResolvedConflict({
      entityType: 'recipe',
      entityId: 'r1',
      fieldName: 'steps',
      chosenValue: [{ id: 's1', step_number: 1, description: 'Boil water', tool_ids: '[]', step_ingredients: '[]' }],
    });

    expect(childTables.recipe_steps).toEqual([
      { id: 's1', recipe_id: 'r1', step_number: 1, title: null, description: 'Boil water', duration_min: null, tool_ids: '[]', technique_ids: '[]', notes: null, image_url: null, step_ingredients: '[]' },
    ]);
  });

  it('does not throw when a resolved step id already exists under a DIFFERENT recipe — upserts in place instead', async () => {
    // recipe_steps.id/recipe_ingredients.id are GLOBAL primary keys (only
    // UNIQUE(recipe_id, step_number) is recipe-scoped), so two devices can
    // each generate a row sharing an id across unrelated recipes. Resolving
    // a conflict whose chosen value includes such an id used to throw
    // "UNIQUE constraint failed: recipe_steps.id" — a real crash a user
    // hit — because writeArrayField()'s DELETE only clears rows for the
    // recipe being written, not whichever recipe already owns that id.
    entityTables.recipes.set('r1', { id: 'r1' });
    entityTables.recipes.set('other-recipe', { id: 'other-recipe' });
    childTables.recipe_steps.push({ id: 'shared-id', recipe_id: 'other-recipe', step_number: 1, description: "Someone else's step" });

    await expect(
      applyResolvedConflict({
        entityType: 'recipe',
        entityId: 'r1',
        fieldName: 'steps',
        chosenValue: [{ id: 'shared-id', step_number: 1, description: 'My step', tool_ids: '[]', step_ingredients: '[]' }],
      })
    ).resolves.not.toThrow();

    // The row now belongs to r1 with r1's data — not duplicated, not left
    // owned by the other recipe.
    expect(childTables.recipe_steps).toEqual([
      { id: 'shared-id', recipe_id: 'r1', step_number: 1, title: null, description: 'My step', duration_min: null, tool_ids: '[]', technique_ids: '[]', notes: null, image_url: null, step_ingredients: '[]' },
    ]);
  });
});

describe('applyEntityMergeResult', () => {
  it('writes fast-forwarded scalar fields onto the entity row', async () => {
    entityTables.ingredients.set('i1', { id: 'i1', calories_kcal: 110, name: 'Tomato Sauce' });

    const outcome = await applyEntityMergeResult('ingredient', 'i1', {
      applied: { calories_kcal: 95 },
      conflicts: [],
    });

    expect(entityTables.ingredients.get('i1')?.calories_kcal).toBe(95);
    expect(outcome).toEqual({ appliedFields: ['calories_kcal'], unsupportedFields: [], conflictsRecorded: 0 });
  });

  it('records a Conflict for each conflict in the merge result instead of applying it', async () => {
    entityTables.recipes.set('r1', { id: 'r1', title: "Grandma's Lasagna" });

    const outcome = await applyEntityMergeResult('recipe', 'r1', {
      applied: {},
      conflicts: [{ fieldName: 'title', baseValue: 'Lasagna', localValue: "Grandma's Lasagna", remoteValue: "Nonna's Lasagna" }],
    });

    expect(outcome.conflictsRecorded).toBe(1);
    const pending = await listPendingConflictsForEntity('recipe', 'r1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ fieldName: 'title', localValue: "Grandma's Lasagna", remoteValue: "Nonna's Lasagna" });
  });

  it('writes a whole-array fast-forward (steps) as a delete+reinsert of recipe_steps', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });
    childTables.recipe_steps.push({ id: 'stale', recipe_id: 'r1', step_number: 1, description: 'Old step' });

    const outcome = await applyEntityMergeResult('recipe', 'r1', {
      applied: { steps: [{ id: 's1', step_number: 1, description: 'Boil water', tool_ids: '[]', step_ingredients: '[]' }] },
      conflicts: [],
    });

    expect(outcome).toEqual({ appliedFields: ['steps'], unsupportedFields: [], conflictsRecorded: 0 });
    expect(childTables.recipe_steps).toEqual([
      { id: 's1', recipe_id: 'r1', step_number: 1, title: null, description: 'Boil water', duration_min: null, tool_ids: '[]', technique_ids: '[]', notes: null, image_url: null, step_ingredients: '[]' },
    ]);
  });

  it('applies scalar and whole-array fields together in the same call', async () => {
    entityTables.recipes.set('r1', { id: 'r1', servings: 4 });

    const outcome = await applyEntityMergeResult('recipe', 'r1', {
      applied: { servings: 6, toolIds: ['knife', 'pan'] },
      conflicts: [],
    });

    expect(entityTables.recipes.get('r1')?.servings).toBe(6);
    expect(outcome.appliedFields.sort()).toEqual(['servings', 'toolIds']);
    expect(outcome.unsupportedFields).toEqual([]);
    expect(childTables.recipe_tools).toEqual([
      { recipe_id: 'r1', tool_id: 'knife' },
      { recipe_id: 'r1', tool_id: 'pan' },
    ]);
  });

  it('rejects an unrecognized field rather than trusting it into SQL', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });
    await expect(
      applyEntityMergeResult('recipe', 'r1', { applied: { 'DROP TABLE recipes': 'x' }, conflicts: [] })
    ).rejects.toThrow(/not a recognized/);
  });

  it('records conflicts before attempting field writes — an unrecognized field later in the same call cannot lose an already-detected conflict', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });

    await expect(
      applyEntityMergeResult('recipe', 'r1', {
        applied: { 'DROP TABLE recipes': 'x' },
        conflicts: [{ fieldName: 'title', baseValue: 'A', localValue: 'B', remoteValue: 'C' }],
      })
    ).rejects.toThrow(/not a recognized/);

    const pending = await listPendingConflictsForEntity('recipe', 'r1');
    expect(pending).toHaveLength(1);
    expect(pending[0].fieldName).toBe('title');
  });

  it('rejects an unknown entity type', async () => {
    await expect(
      applyEntityMergeResult('not-a-real-entity', 'x', { applied: {}, conflicts: [] })
    ).rejects.toThrow();
  });
});

describe('entityExists', () => {
  it('is false for an id that has no row', async () => {
    expect(await entityExists('recipe', 'nope')).toBe(false);
  });

  it('is true once a row with that id exists', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });
    expect(await entityExists('recipe', 'r1')).toBe(true);
  });

  it('is false for an unrecognized entity type', async () => {
    expect(await entityExists('not-a-real-entity', 'x')).toBe(false);
  });
});

describe('createEntity', () => {
  it('inserts a new row with every recognized scalar field', async () => {
    await createEntity('ingredient', 'i1', { name: 'Tomato Sauce', calories_kcal: 95, category_id: 'c1' });

    expect(entityTables.ingredients.get('i1')).toEqual({ id: 'i1', name: 'Tomato Sauce', calories_kcal: 95, category_id: 'c1' });
  });

  it('drops unrecognized fields rather than trusting them into SQL', async () => {
    await createEntity('ingredient', 'i1', { name: 'Tomato Sauce', 'DROP TABLE ingredients': 'x' });

    const row = entityTables.ingredients.get('i1');
    expect(row).toEqual({ id: 'i1', name: 'Tomato Sauce' });
  });

  it('writes whole-array fields (steps/ingredients/toolIds) via the child tables, not as scalar columns', async () => {
    await createEntity('recipe', 'r1', {
      title: 'Lasagna',
      steps: [{ id: 's1', step_number: 1, description: 'Boil water', tool_ids: '[]', step_ingredients: '[]' }],
      ingredients: [{ id: 'ri1', sort_order: 0, ingredient_id: 'tomato', quantity: 2, is_optional: 0 }],
      toolIds: ['pot'],
    });

    expect(entityTables.recipes.get('r1')).toEqual({ id: 'r1', title: 'Lasagna' });
    expect(childTables.recipe_steps).toEqual([
      { id: 's1', recipe_id: 'r1', step_number: 1, title: null, description: 'Boil water', duration_min: null, tool_ids: '[]', technique_ids: '[]', notes: null, image_url: null, step_ingredients: '[]' },
    ]);
    expect(childTables.recipe_ingredients).toEqual([
      { id: 'ri1', recipe_id: 'r1', sort_order: 0, ingredient_id: 'tomato', subtype_id: null, sub_recipe_id: null, quantity: 2, quantity_text: null, unit_id: null, notes: null, is_optional: 0, group_name: null, substitute_for: null },
    ]);
    expect(childTables.recipe_tools).toEqual([{ recipe_id: 'r1', tool_id: 'pot' }]);
  });

  it('does nothing if the entity already exists (ON CONFLICT DO NOTHING) rather than clobbering it', async () => {
    entityTables.recipes.set('r1', { id: 'r1', title: 'Original' });

    await createEntity('recipe', 'r1', { title: 'Would-be overwrite' });

    expect(entityTables.recipes.get('r1')).toEqual({ id: 'r1', title: 'Original' });
  });

  it('does not touch an existing recipe\'s own steps when the row already existed (a losing race)', async () => {
    entityTables.recipes.set('r1', { id: 'r1', title: 'Original' });
    childTables.recipe_steps.push({ id: 'existing-step', recipe_id: 'r1', description: 'Keep me' });

    await createEntity('recipe', 'r1', { title: 'Would-be overwrite', steps: [{ id: 'intruder', description: 'Should not land' }] });

    expect(childTables.recipe_steps).toEqual([{ id: 'existing-step', recipe_id: 'r1', description: 'Keep me' }]);
  });

  it('rejects an unknown entity type', async () => {
    await expect(createEntity('not-a-real-entity', 'x', {})).rejects.toThrow();
  });
});

describe('getMergeableFieldNames', () => {
  it('includes the three whole-array pseudo-fields for recipes, using the real toolIds key', () => {
    const fields = getMergeableFieldNames('recipe')!;
    expect(fields).toContain('steps');
    expect(fields).toContain('ingredients');
    expect(fields).toContain('toolIds');
    expect(fields).not.toContain('tools');
  });

  it('does not include whole-array fields for a non-recipe entity type', () => {
    const fields = getMergeableFieldNames('ingredient')!;
    expect(fields).not.toContain('steps');
    expect(fields).toContain('name');
  });

  it('includes deleted_at for tool/tag/technique, so a soft-delete propagates through merge like any scalar field', () => {
    expect(getMergeableFieldNames('tool')).toContain('deleted_at');
    expect(getMergeableFieldNames('tag')).toContain('deleted_at');
    expect(getMergeableFieldNames('technique')).toContain('deleted_at');
  });

  it('returns null for an unrecognized entity type', () => {
    expect(getMergeableFieldNames('not-a-real-entity')).toBeNull();
  });
});

describe('getEntityDisplayName', () => {
  it('reads a recipe by its title column', async () => {
    entityTables.recipes.set('r1', { id: 'r1', title: "Grandma's Lasagna" });
    expect(await getEntityDisplayName('recipe', 'r1')).toBe("Grandma's Lasagna");
  });

  it('reads an ingredient by its name column', async () => {
    entityTables.ingredients.set('i1', { id: 'i1', name: 'Tomato Sauce' });
    expect(await getEntityDisplayName('ingredient', 'i1')).toBe('Tomato Sauce');
  });

  it('returns null for a missing entity', async () => {
    expect(await getEntityDisplayName('recipe', 'does-not-exist')).toBeNull();
  });
});
