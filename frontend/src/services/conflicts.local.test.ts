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

vi.mock('../db/local', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const trimmed = sql.trim();

    const updateMatch = trimmed.match(/^UPDATE (\w+) SET (\w+) = \$1, updated_at = now\(\) WHERE id = \$2$/);
    if (updateMatch) {
      const [, table, col] = updateMatch;
      const [value, id] = params;
      const row = entityTables[table]?.get(id as string);
      if (!row) throw new Error(`fake db/local: no row '${id}' in '${table}'`);
      row[col] = value;
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

    throw new Error(`fake db/local: unrecognized query — ${sql}`);
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    const trimmed = sql.trim();
    if (trimmed.startsWith('SELECT * FROM sync_conflicts WHERE id')) {
      const [id] = params as string[];
      return rows.find((r) => r.id === id) ?? null;
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

const { upsertConflict, listPendingConflicts, listPendingConflictsForEntity, resolveConflict, applyResolvedConflict, getEntityDisplayName } = await import('./conflicts.local');

beforeEach(() => {
  rows.length = 0;
  now = 0;
  for (const table of Object.values(entityTables)) table.clear();
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

  it('rejects the whole-array recipe fields — not a plain column, needs the future Sync Engine write-back path', async () => {
    entityTables.recipes.set('r1', { id: 'r1' });
    await expect(
      applyResolvedConflict({ entityType: 'recipe', entityId: 'r1', fieldName: 'steps', chosenValue: ['a'] })
    ).rejects.toThrow(/whole-array/);
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
