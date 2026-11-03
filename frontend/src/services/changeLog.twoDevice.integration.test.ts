// ════════════════════════════════════════════════════════════════════════
// Sync v2 phase 1, two devices on real SQLite (node:sqlite), no transport:
// segments are handed from one device to the other in memory. Each device
// is its own database and Preferences, and switching devices resets the
// module graph, as in lib/sync/twoDevice.sync.integration.test.ts.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

interface Device { name: string; db: DatabaseSync; prefs: Map<string, string> }
let current: Device;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) { current.db.exec(sql); return; }
          current.db.exec('BEGIN');
          try { current.db.exec(sql); current.db.exec('COMMIT'); } catch (err) { current.db.exec('ROLLBACK'); throw err; }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: current.db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { current.db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => { throw new Error('one connection per device turn'); },
    };
  }),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: current.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => { current.prefs.set(key, value); },
    remove: async ({ key }: { key: string }) => { current.prefs.delete(key); },
  },
}));

const newDevice = (name: string): Device => ({ name, db: new DatabaseSync(':memory:'), prefs: new Map() });
let A: Device;
let B: Device;

/** Switches to `device` with a fresh module graph, as a separate install. */
async function on(device: Device) {
  current = device;
  vi.resetModules();
  const db = await import('../db/local');
  await db.initLocalSchema();
  const log = await import('./changeLog.local');
  const conflicts = await import('./conflicts.local');
  return { db, log, conflicts };
}

type DeviceCtx = Awaited<ReturnType<typeof on>>;
const lastSeq = (s: { changes: Array<{ seq: number }> }) => s.changes[s.changes.length - 1].seq;

const recipeRow = async (m: DeviceCtx, id: string) => m.db.queryOne<Record<string, unknown>>(`SELECT * FROM recipes WHERE id = $1`, [id]);
const tagsOf = (row: Record<string, unknown> | null) => (JSON.parse(String(row?.tags ?? '[]')) as string[]).sort();

/** A save on the current device: the row changes, then the hook records it. */
async function edit(m: DeviceCtx, id: string, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  await m.db.query(`UPDATE recipes SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, [...Object.values(set), id]);
  return m.log.recordEntityChange('recipe', id, (await recipeRow(m, id))!, current.name);
}

beforeEach(() => {
  A = newDevice('A');
  B = newDevice('B');
});

describe('sync v2 change log between two devices', () => {
  async function shareRecipe(policy: 'ask' | 'newest') {
    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane', servings: 4, difficulty: 'easy', tags: '["Dolce"]' });
    expect(await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A')).toBeGreaterThan(0);
    const first = await m.log.buildSegment('A');

    m = await on(B);
    const report = await m.log.applySegment(first, { device: 'B', policy });
    expect(report.failed).toEqual([]);
    return first;
  }

  it('creates on the other device what one device recorded', async () => {
    await shareRecipe('ask');
    const m = await on(B);
    const row = await recipeRow(m, 'r1');
    expect(row).toMatchObject({ title: 'Pane', servings: 4, difficulty: 'easy' });
    expect(tagsOf(row)).toEqual(['Dolce']);
    // Applying a change is not a local change: nothing to send back.
    expect((await m.log.buildSegment('B')).changes).toEqual([]);
  });

  it('is idempotent: the same segment twice changes nothing', async () => {
    const first = await shareRecipe('ask');
    const m = await on(B);
    expect(await m.log.applySegment(first, { device: 'B', policy: 'ask' })).toMatchObject({ applied: 0, conflicts: 0 });
  });

  it('merges concurrent edits: sets keep both sides, the same field converges, and "ask" records the disagreement', async () => {
    const first = await shareRecipe('ask');

    let m = await on(A);
    await edit(m, 'r1', { title: 'Pane di A', tags: '["Dolce","Veloce"]' });
    const fromA = await m.log.buildSegment('A', lastSeq(first));

    m = await on(B);
    await edit(m, 'r1', { title: 'Pane di B', tags: '["Dolce","Forno"]', servings: 6 });
    const fromB = await m.log.buildSegment('B');
    expect(fromB.seen).toEqual({ A: lastSeq(first) });
    const onB = await m.log.applySegment(fromA, { device: 'B', policy: 'ask' });
    expect(onB.conflicts).toBe(1);

    m = await on(A);
    const onA = await m.log.applySegment(fromB, { device: 'A', policy: 'ask' });
    expect(onA.conflicts).toBe(1);
    const rowA = await recipeRow(m, 'r1');
    const pendingA = await m.conflicts.listPendingConflictsForEntity('recipe', 'r1');
    const stateA = await m.log.listFieldState('recipe', 'r1');

    m = await on(B);
    const rowB = await recipeRow(m, 'r1');
    const pendingB = await m.conflicts.listPendingConflictsForEntity('recipe', 'r1');
    const stateB = await m.log.listFieldState('recipe', 'r1');

    // Both tag additions survive on both devices; B's servings reached A.
    expect(tagsOf(rowA)).toEqual(['Dolce', 'Forno', 'Veloce']);
    expect(tagsOf(rowB)).toEqual(['Dolce', 'Forno', 'Veloce']);
    expect(rowA!.servings).toBe(6);
    // The title: each device keeps its own on screen and asks.
    expect(rowA!.title).toBe('Pane di A');
    expect(rowB!.title).toBe('Pane di B');
    expect(pendingA.map((c) => c.fieldName)).toEqual(['title']);
    expect(pendingB.map((c) => c.fieldName)).toEqual(['title']);
    // …while the log agrees on which one is newest, so the pick converges.
    expect(stateA.get('title')!.hlc).toBe(stateB.get('title')!.hlc);
  });

  it('with "newest", concurrent edits converge on the same value with no question', async () => {
    const first = await shareRecipe('newest');

    let m = await on(A);
    await edit(m, 'r1', { title: 'Pane di A' });
    const fromA = await m.log.buildSegment('A', lastSeq(first));

    m = await on(B);
    await edit(m, 'r1', { title: 'Pane di B' });
    const fromB = await m.log.buildSegment('B');
    await m.log.applySegment(fromA, { device: 'B', policy: 'newest' });
    const titleB = (await recipeRow(m, 'r1'))!.title;

    m = await on(A);
    await m.log.applySegment(fromB, { device: 'A', policy: 'newest' });
    const titleA = (await recipeRow(m, 'r1'))!.title;

    expect(titleA).toBe(titleB);
    expect(await m.conflicts.listPendingConflictsForEntity('recipe', 'r1')).toEqual([]);
  });

  it('an edit made after reading the other device is a plain update, not a conflict', async () => {
    const first = await shareRecipe('ask');

    let m = await on(B);
    await edit(m, 'r1', { title: 'Pane integrale' });
    const fromB = await m.log.buildSegment('B');

    m = await on(A);
    expect(await m.log.applySegment(fromB, { device: 'A', policy: 'ask' })).toMatchObject({ conflicts: 0 });
    expect((await recipeRow(m, 'r1'))!.title).toBe('Pane integrale');
    expect(first.changes.length).toBeGreaterThan(0);
  });

  it('carries a whole recipe as the app serializes it: steps, tools and a tool it depends on', async () => {
    let m = await on(A);
    await m.conflicts.createEntity('tool', 'tool-forno', { name: 'Forno' });
    await m.conflicts.createEntity('recipe', 'r2', {
      title: 'Focaccia',
      steps: [
        { id: 's1', step_number: 1, title: null, description: 'Impasta', duration_min: 10 },
        { id: 's2', step_number: 2, title: null, description: 'Cuoci', duration_min: 25 },
      ],
      toolIds: ['tool-forno'],
    });
    const { buildRecipeEntity } = await import('./recipes.local');
    const toolRow = (await m.db.queryOne<Record<string, unknown>>(`SELECT * FROM tools WHERE id = 'tool-forno'`))!;
    await m.log.recordEntityChange('tool', 'tool-forno', toolRow, 'A');
    await m.log.recordEntityChange('recipe', 'r2', (await buildRecipeEntity('r2'))!, 'A');
    // A re-serialization of the same recipe is not a change.
    expect(await m.log.recordEntityChange('recipe', 'r2', (await buildRecipeEntity('r2'))!, 'A')).toBe(0);
    const segment = await m.log.buildSegment('A');

    m = await on(B);
    const report = await m.log.applySegment(segment, { device: 'B', policy: 'ask' });
    expect(report.failed).toEqual([]);
    const { buildRecipeEntity: buildOnB } = await import('./recipes.local');
    const onB = (await buildOnB('r2'))!;
    expect((onB.steps as Array<Record<string, unknown>>).map((s) => [s.step_number, s.description, s.duration_min]))
      .toEqual([[1, 'Impasta', 10], [2, 'Cuoci', 25]]);
    expect(onB.toolIds).toEqual(['tool-forno']);
    // B recording its own copy finds nothing new to publish.
    expect(await m.log.recordEntityChange('recipe', 'r2', onB, 'B')).toBe(0);
  });

  it('a delete travels as a field like any other', async () => {
    const first = await shareRecipe('ask');
    let m = await on(A);
    await edit(m, 'r1', { sync_status: 'deleted' });
    const fromA = await m.log.buildSegment('A', lastSeq(first));
    m = await on(B);
    await m.log.applySegment(fromA, { device: 'B', policy: 'ask' });
    expect((await recipeRow(m, 'r1'))!.sync_status).toBe('deleted');
  });
});
