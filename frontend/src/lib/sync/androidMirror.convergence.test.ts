import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSafTree, createFakeLocalFs, createFakeDb, getText, type FakeSafTree, type FakeDb } from './testUtils/fakes';

// Real isomorphic-git needs a fully spec-compliant fs (proper Stats
// objects, ENOENT error codes, etc.) that createFakeLocalFs() was never
// built to provide — it only needed to satisfy androidMirror.ts's own
// narrow usage for tasks 6a/7a. Building that fidelity here would mostly
// re-test git plumbing tasks 6a/7a/8a already cover via controlled fakes.
// What THIS test actually needs to verify is the SQLite convergence
// behavior (does data really flow device A -> shared tree -> device B),
// so isomorphic-git itself is mocked at the level syncNow()/initSyncRepo()
// consume it: resolveRef succeeds iff a local ref file exists (same
// pattern as gitSync.pullBeforeInit.test.ts), init/commit write a
// plausible-looking ref so later resolveRef calls succeed, statusMatrix
// always reports a change so commitNow() always proceeds — none of that
// needs to be real for reconcileEntity()/upsertFlatRow() (the actual
// logic under test here) to run for real against the fake db/fs.
vi.mock('isomorphic-git', () => ({
  resolveRef: async ({ fs, dir }: { fs: { promises: { stat: (p: string) => Promise<unknown> } }; dir: string }) => {
    await fs.promises.stat(`${dir}/.git/refs/heads/main`);
    return 'resolved-oid';
  },
  init: async ({ fs, gitdir }: { fs: { promises: { writeFile: (p: string, d: string) => Promise<void> } }; gitdir: string }) => {
    await fs.promises.writeFile(`${gitdir}/HEAD`, 'ref: refs/heads/main\n');
  },
  add: async () => {},
  commit: async ({
    fs,
    gitdir,
  }: {
    fs: { promises: { writeFile: (p: string, d: string) => Promise<void> } };
    gitdir: string;
  }) => {
    const oid = `commit-${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(`${gitdir}/refs/heads/main`, `${oid}\n`);
    return oid;
  },
  statusMatrix: async () => [['recipes/placeholder.json', 1, 2, 1]],
}));

// End-to-end convergence tests: two independent "devices" (each with its
// own private working copy, SQLite, and mirror state, wired up the same
// way createDevice() below does) sharing one fake SAF tree. Exercises the
// full syncNow() cycle (pull -> reconcile -> commit -> push) task 9 wired
// up, not just androidMirror.ts's pull/push logic in isolation the way
// tasks 6a/7a did.
//
// Each device gets its own vi.doMock() registrations + vi.resetModules()
// + fresh dynamic import — the module-level state gitSync.ts/
// androidMirror.ts keep (commitTimer, initDone, cachedState, deviceId)
// would otherwise be shared across "devices" within one test file, which
// would defeat the entire point of simulating two separate installs.
// Functions captured from one device's import stay bound to that device's
// own mocks even after a second device's vi.doMock() calls run — ES
// module namespace objects are resolved once at import time, not
// re-evaluated on each call — so calling deviceA.syncNow() after
// deviceB has been created still operates on device A's own state.

interface Device {
  syncNow: () => Promise<{ applied: number; committed: boolean; lastSyncAt: string }>;
  writeEntityFile: (type: 'recipes' | 'ingredients', id: string, data: Record<string, unknown>) => Promise<void>;
  getDeviceId: () => Promise<string>;
  db: FakeDb;
}

async function createDevice(tree: FakeSafTree): Promise<Device> {
  const localFs = createFakeLocalFs();
  const db = createFakeDb();
  const prefsStore = new Map<string, string>();

  vi.doMock('@capacitor/preferences', () => ({
    Preferences: {
      get: async ({ key }: { key: string }) => ({ value: prefsStore.get(key) ?? null }),
      set: async ({ key, value }: { key: string; value: string }) => {
        prefsStore.set(key, value);
      },
    },
  }));
  vi.doMock('../gitfs', () => ({
    gitfs: localFs,
    getSyncBasePath: async () => '/private',
    ensureSyncFolderPermission: async () => {},
    base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
    bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  }));
  vi.doMock('../electronBridge', () => ({ isElectron: () => false }));
  vi.doMock('../safMirrorBridge', () => ({ SafMirror: tree.plugin }));
  vi.doMock('../../db/local', () => ({ query: db.query, queryOne: db.queryOne }));

  vi.resetModules();

  const gitSync = await import('./gitSync');
  const androidMirror = await import('./androidMirror');
  await androidMirror.setMirrorTree(tree.uri, 'Fake');

  return { syncNow: gitSync.syncNow, writeEntityFile: gitSync.writeEntityFile, getDeviceId: gitSync.getDeviceId, db };
}

let tree: FakeSafTree;

beforeEach(() => {
  tree = createFakeSafTree('fake://shared-tree');
});

describe('two-device convergence (syncNow end to end)', () => {
  it('device A creates a recipe, device B syncs and sees it', async () => {
    const deviceA = await createDevice(tree);
    await deviceA.writeEntityFile('recipes', 'r1', { id: 'r1', title: 'Soup', updated_at: '2026-01-01T00:00:00.000Z' });
    await deviceA.syncNow();

    expect(deviceA.db.tables.recipes.get('r1')).toMatchObject({ title: 'Soup' });

    const deviceB = await createDevice(tree);
    await deviceB.syncNow();

    expect(deviceB.db.tables.recipes.get('r1')).toMatchObject({ id: 'r1', title: 'Soup' });
  });

  it('concurrent edits to different recipes converge on both devices without conflict', async () => {
    const deviceA = await createDevice(tree);
    const deviceB = await createDevice(tree);

    await deviceA.writeEntityFile('recipes', 'r1', { id: 'r1', title: 'A recipe', updated_at: '2026-01-01T00:00:00.000Z' });
    await deviceB.writeEntityFile('recipes', 'r2', { id: 'r2', title: 'B recipe', updated_at: '2026-01-01T00:00:00.000Z' });

    await deviceA.syncNow(); // pushes r1
    await deviceB.syncNow(); // pulls r1, pushes r2
    await deviceA.syncNow(); // pulls r2

    expect(deviceA.db.tables.recipes.get('r1')).toMatchObject({ title: 'A recipe' });
    expect(deviceA.db.tables.recipes.get('r2')).toMatchObject({ title: 'B recipe' });
    expect(deviceB.db.tables.recipes.get('r1')).toMatchObject({ title: 'A recipe' });
    expect(deviceB.db.tables.recipes.get('r2')).toMatchObject({ title: 'B recipe' });
  });

  it('concurrent edits to the same recipe converge via last-write-wins', async () => {
    const deviceA = await createDevice(tree);
    const deviceB = await createDevice(tree);

    // Both devices edit the same recipe without knowledge of each other —
    // B's edit is newer and must win everywhere once synced.
    await deviceA.writeEntityFile('recipes', 'r1', { id: 'r1', title: 'A version', updated_at: '2026-01-01T00:00:00.000Z' });
    await deviceB.writeEntityFile('recipes', 'r1', {
      id: 'r1',
      title: 'B version (newer)',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    await deviceA.syncNow(); // pushes A's older version first
    await deviceB.syncNow(); // pulls A's version, but B's local edit is newer — keeps it (the LWW-aware pull fix this exercises), pushes it
    await deviceA.syncNow(); // pulls B's newer version, adopts it

    expect(deviceA.db.tables.recipes.get('r1')).toMatchObject({ title: 'B version (newer)' });
    expect(deviceB.db.tables.recipes.get('r1')).toMatchObject({ title: 'B version (newer)' });
  });
});

describe('device registry (task 11)', () => {
  it('each device writes its own devices/<id>.json to the shared target on syncNow(), without touching the other\'s', async () => {
    const deviceA = await createDevice(tree);
    const deviceB = await createDevice(tree);
    const idA = await deviceA.getDeviceId();
    const idB = await deviceB.getDeviceId();
    expect(idA).not.toBe(idB);

    const before = new Date().toISOString();
    await deviceA.syncNow();
    await deviceB.syncNow();

    const recordA = JSON.parse(getText(tree, `devices/${idA}.json`)!);
    const recordB = JSON.parse(getText(tree, `devices/${idB}.json`)!);

    expect(recordA).toMatchObject({ deviceId: idA, platform: 'android' });
    expect(recordB).toMatchObject({ deviceId: idB, platform: 'android' });
    expect(recordA.lastSyncAt >= before).toBe(true);
    expect(recordB.lastSyncAt >= before).toBe(true);

    // A second cycle for A must refresh its own record without disturbing B's.
    await deviceA.syncNow();
    const recordARefreshed = JSON.parse(getText(tree, `devices/${idA}.json`)!);
    const recordBUnchanged = JSON.parse(getText(tree, `devices/${idB}.json`)!);
    expect(recordARefreshed.lastSyncAt >= recordA.lastSyncAt).toBe(true);
    expect(recordBUnchanged).toEqual(recordB);
  });
});
