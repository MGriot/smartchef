// ════════════════════════════════════════════════════════════════════════
// Moving onto sync v2 with the app's real services: saves through
// recipes.local / tags.local reach writeEntityFile(), which in v2 mode
// records into the change log and never touches the git Hidden Clone; the
// whole-library seed (syncV2Runner.recordWholeLibrary) publishes an
// existing library, seeded catalog included, and a second device with its
// own seeded catalog takes it without failures.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryStore } from '../lib/changeLog/store';

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

// v2 mode must never reach the Hidden Clone's filesystem.
vi.mock('../lib/gitfs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/gitfs')>();
  const refuse = async () => { throw new Error('git filesystem touched in v2 mode'); };
  return { ...real, gitfs: { promises: new Proxy({}, { get: () => refuse }) } };
});

const newDevice = (name: string): Device => ({ name, db: new DatabaseSync(':memory:'), prefs: new Map([['smartchef.sync.deviceId', name]]) });
let store: ReturnType<typeof createMemoryStore>;

async function on(device: Device) {
  current = device;
  vi.resetModules();
  const db = await import('../db/local');
  await db.initLocalSchema();
  const settings = await import('../lib/sync/syncSettings');
  await settings.setSyncEngine('v2');
  const log = await import('./changeLog.local');
  await log.setChangeLogEnabled(true);
  const v2 = await import('./syncV2.local');
  const runner = await import('../lib/sync/syncV2Runner');
  const sync = () => v2.syncOnceV2(store, { device: device.name, policy: 'ask' });
  return { db, log, runner, sync };
}

/** Waits for fire-and-forget background saves (syncRecipeInBackground). */
async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for a background save');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  store = createMemoryStore();
});

describe('switching a library onto sync v2', () => {
  it('records real service saves into the log, without git, and a second device receives the library', async () => {
    const A = newDevice('A');
    const B = newDevice('B');

    let m = await on(A);
    const { createTag } = await import('./tags.local');
    const { createRecipe } = await import('./recipes.local');
    await createTag({ name: 'Lievitati', groupName: 'Portata' } as never);
    const { id } = await createRecipe({
      title: 'Focaccia', servings: 6, tags: ['Lievitati'],
      steps: [{ stepNumber: 1, description: 'Impasta e lascia lievitare', durationMin: 120 } as never],
    }, null);
    await until(async () => (await m.log.buildSegment('A')).changes.some((c) => c.entityType === 'recipe' && c.entityId === id));

    // The seed: an existing library (here, the starter catalog the schema
    // seeds) published in full.
    await m.runner.recordWholeLibrary();
    const pushed = await m.sync();
    expect(pushed.pushedChanges).toBeGreaterThan(0);

    m = await on(B);
    await m.runner.recordWholeLibrary();
    const pulled = await m.sync();
    expect(pulled.failed).toEqual([]);
    const recipe = await m.db.queryOne<Record<string, unknown>>(`SELECT * FROM recipes WHERE id = $1`, [id]);
    expect(recipe).toMatchObject({ title: 'Focaccia', servings: 6 });
    const steps = await m.db.query<Record<string, unknown>>(`SELECT * FROM recipe_steps WHERE recipe_id = $1`, [id]);
    expect(steps.map((s) => s.duration_min)).toEqual([120]);
    expect(await m.db.queryOne(`SELECT id FROM tags WHERE name = 'Lievitati'`)).not.toBeNull();

    // Back on A: B's seed of the same starter catalog changes nothing there.
    m = await on(A);
    const back = await m.sync();
    expect(back.failed).toEqual([]);
    expect(back.conflicts).toBe(0);
  });
});
