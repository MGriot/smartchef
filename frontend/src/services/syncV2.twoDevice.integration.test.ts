// ════════════════════════════════════════════════════════════════════════
// Sync v2 phase 2, end to end: two devices on real SQLite (node:sqlite),
// each with its own image folder, syncing through one shared store.
// Switching devices resets the module graph, as two installs would be.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryStore } from '../lib/changeLog/store';
import { paths, parseSegmentName } from '../lib/changeLog/files';
import type { ImageFs } from '../lib/localImages';

interface Device { name: string; db: DatabaseSync; prefs: Map<string, string>; images: Map<string, Uint8Array> }
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

const newDevice = (name: string): Device => ({ name, db: new DatabaseSync(':memory:'), prefs: new Map(), images: new Map() });

const imageFsOf = (d: Device): ImageFs => ({
  exists: async (p) => d.images.has(p),
  readFile: async (p) => { const b = d.images.get(p); if (!b) throw new Error(`missing ${p}`); return b; },
  writeFile: async (p, data) => { d.images.set(p, data); },
  list: async () => [...d.images.keys()],
});

let A: Device;
let B: Device;
let store: ReturnType<typeof createMemoryStore>;

async function on(device: Device) {
  current = device;
  vi.resetModules();
  const db = await import('../db/local');
  await db.initLocalSchema();
  const log = await import('./changeLog.local');
  const conflicts = await import('./conflicts.local');
  const v2 = await import('./syncV2.local');
  const sync = (policy: 'ask' | 'newest' = 'ask') => v2.syncOnceV2(store, { device: device.name, policy, images: imageFsOf(device) });
  return { db, log, conflicts, v2, sync };
}
type DeviceCtx = Awaited<ReturnType<typeof on>>;

const recipeRow = (m: DeviceCtx, id: string) => m.db.queryOne<Record<string, unknown>>(`SELECT * FROM recipes WHERE id = $1`, [id]);

async function edit(m: DeviceCtx, id: string, set: Record<string, unknown>) {
  const cols = Object.keys(set);
  await m.db.query(`UPDATE recipes SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`, [...Object.values(set), id]);
  await m.log.recordEntityChange('recipe', id, (await recipeRow(m, id))!, current.name);
}

async function hashName(bytes: Uint8Array, ext: string) {
  const { hashBytes } = await import('../lib/localImages');
  return `images/${await hashBytes(bytes)}.${ext}`;
}

beforeEach(() => {
  A = newDevice('A');
  B = newDevice('B');
  store = createMemoryStore();
});

describe('sync v2 through a shared store', () => {
  it('carries a recipe and its photo from one device to another, and back', async () => {
    const photo = new Uint8Array([1, 2, 3, 4]);
    const photoPath = await hashName(photo, 'webp');
    A.images.set(photoPath, photo);

    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane', servings: 4, cover_image_url: photoPath });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    const first = await m.sync();
    expect(first).toMatchObject({ pushedChanges: expect.any(Number), imagesUploaded: 1, failed: [] });
    expect(first.pushedChanges).toBeGreaterThan(0);
    expect(store.files.has('format.json')).toBe(true);

    m = await on(B);
    const second = await m.sync();
    expect(second).toMatchObject({ libraryId: first.libraryId, imagesDownloaded: 1, failed: [], incompleteDevices: [] });
    expect(await recipeRow(m, 'r1')).toMatchObject({ title: 'Pane', servings: 4, cover_image_url: photoPath });
    expect(B.images.get(photoPath)).toEqual(photo);

    await edit(m, 'r1', { title: 'Pane casereccio' });
    expect((await m.sync()).pushedChanges).toBe(1);

    m = await on(A);
    await m.sync();
    expect((await recipeRow(m, 'r1'))!.title).toBe('Pane casereccio');
  });

  it('is a no-op when nothing changed, and writes nothing new', async () => {
    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane' });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    await m.sync();
    m = await on(B);
    await m.sync();
    const before = new Map(store.files);
    const again = await m.sync();
    expect(again).toMatchObject({ pulledChanges: 0, pushedChanges: 0 });
    expect([...store.files.keys()]).toEqual([...before.keys()]);
  });

  it('never skips over a missing segment: it waits for it, then catches up', async () => {
    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Uno' });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    await m.sync();
    await edit(m, 'r1', { title: 'Due' });
    await m.sync();

    // The first segment hasn't arrived yet on B's side (a slow cloud folder).
    const segs = [...store.files.keys()].filter((k) => k.startsWith('devices/A/log/')).sort();
    expect(segs).toHaveLength(2);
    const held = store.files.get(segs[0])!;
    store.files.delete(segs[0]);

    m = await on(B);
    const partial = await m.sync();
    expect(partial.incompleteDevices).toEqual(['A']);
    expect(await recipeRow(m, 'r1')).toBeNull();

    store.files.set(segs[0], held);
    const full = await m.sync();
    expect(full.incompleteDevices).toEqual([]);
    expect((await recipeRow(m, 'r1'))!.title).toBe('Due');
  });

  it('splits a large first push into several segments with contiguous ranges', async () => {
    const m = await on(A);
    for (let i = 0; i < 5; i++) {
      await m.conflicts.createEntity('recipe', `r${i}`, { title: `Ricetta ${i}`, servings: i + 1 });
      await m.log.recordEntityChange('recipe', `r${i}`, (await recipeRow(m, `r${i}`))!, 'A');
    }
    const total = (await m.log.buildSegment('A')).changes.length;
    await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', segmentMaxChanges: 4 });
    const ranges = (await store.list(paths.log('A'))).map((n) => parseSegmentName(n)!).sort((a, b) => a.from - b.from);
    expect(ranges.length).toBe(Math.ceil(total / 4));
    // Contiguity is what the reader relies on.
    expect(ranges[0].from).toBe(1);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBe(ranges[i - 1].to + 1);
    expect(ranges[ranges.length - 1].to).toBe(total);

    const b = await on(B);
    await b.sync();
    expect((await b.db.query(`SELECT id FROM recipes WHERE id LIKE 'r%'`)).length).toBe(5);
  });

  it('two devices editing at the same time end in the same state after two rounds', async () => {
    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane', tags: '["Dolce"]' });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    await m.sync();
    m = await on(B);
    await m.sync();

    // Offline edits on both.
    await edit(m, 'r1', { tags: '["Dolce","Forno"]', servings: 2 });
    m = await on(A);
    await edit(m, 'r1', { tags: '["Dolce","Veloce"]', title: 'Pane di casa' });

    // Each comes online in turn, twice.
    await m.sync();
    m = await on(B); await m.sync();
    m = await on(A); await m.sync();
    const rowA = (await recipeRow(m, 'r1'))!;
    m = await on(B);
    const rowB = (await recipeRow(m, 'r1'))!;

    for (const row of [rowA, rowB]) {
      expect(JSON.parse(String(row.tags)).sort()).toEqual(['Dolce', 'Forno', 'Veloce']);
      expect(row.title).toBe('Pane di casa');
      expect(row.servings).toBe(2);
    }
  });

  it('syncs a recipe and its photo through an encrypted store that never sees either in the clear', async () => {
    const { openLibraryStore } = await import('../lib/changeLog/libraryStore');
    let key: Uint8Array | null = null;
    const ring = { get: async () => key, set: async (k: Uint8Array) => { key = k; }, encryptNew: async () => true };
    const photo = new TextEncoder().encode('PHOTO-BYTES-1234');
    const photoPath = await hashName(photo, 'jpg');
    A.images.set(photoPath, photo);

    let m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane segreto', cover_image_url: photoPath });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    const imagesOf = (d: Device): ImageFs => imageFsOf(d);
    await m.v2.syncOnceV2(openLibraryStore(store, ring), { device: 'A', policy: 'ask', images: imagesOf(A) });

    const everything = [...store.files.values()].map((b) => new TextDecoder('latin1').decode(b)).join('|');
    expect(everything).not.toContain('Pane segreto');
    expect(everything).not.toContain('PHOTO-BYTES');
    expect(everything).not.toContain(photoPath.slice(7, 30));

    m = await on(B);
    const report = await m.v2.syncOnceV2(openLibraryStore(store, ring), { device: 'B', policy: 'ask', images: imagesOf(B) });
    expect(report).toMatchObject({ imagesDownloaded: 1, failed: [] });
    expect((await recipeRow(m, 'r1'))!.title).toBe('Pane segreto');
    expect(B.images.get(photoPath)).toEqual(photo);
  });

  it('a new device starts from a snapshot; old segments are compacted once everyone has read them', async () => {
    const C = newDevice('C');
    const tune = { snapshotEveryChanges: 3, retentionMs: 0 };
    // B already belongs to the library, so A must wait for it to read.
    let m = await on(B);
    await m.v2.syncOnceV2(store, { device: 'B', policy: 'ask', ...tune });
    m = await on(A);
    for (let i = 0; i < 3; i++) {
      await m.conflicts.createEntity('recipe', `r${i}`, { title: `Ricetta ${i}` });
      await m.log.recordEntityChange('recipe', `r${i}`, (await recipeRow(m, `r${i}`))!, 'A');
    }
    const first = await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', ...tune });
    expect(first.snapshotWritten).toBe(true);
    expect(first.segmentsCompacted).toBe(0);
    expect([...store.files.keys()].filter((k) => k.startsWith('snapshots/'))).toHaveLength(2);

    // B reads A's segments (it is new, so it starts from the snapshot).
    m = await on(B);
    const onB = await m.v2.syncOnceV2(store, { device: 'B', policy: 'ask', ...tune });
    expect(onB).toMatchObject({ caughtUpFromSnapshot: true, failed: [], incompleteDevices: [] });
    expect((await m.db.query(`SELECT id FROM recipes WHERE id LIKE 'r%'`)).length).toBe(3);

    // B's head now says it read all of A, so A may drop what the snapshot covers.
    m = await on(A);
    const compacted = await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', ...tune });
    expect(compacted.segmentsCompacted).toBeGreaterThan(0);
    expect(await store.list(paths.log('A'))).toEqual([]);

    // A later edit is a fresh segment after the compacted range.
    await edit(m, 'r1', { title: 'Ricetta uno' });
    await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', ...tune });

    // C arrives after the compaction: snapshot, then the segment after it.
    m = await on(C);
    const onC = await m.v2.syncOnceV2(store, { device: 'C', policy: 'ask', ...tune });
    expect(onC).toMatchObject({ caughtUpFromSnapshot: true, failed: [], incompleteDevices: [] });
    expect((await recipeRow(m, 'r0'))!.title).toBe('Ricetta 0');
    expect((await recipeRow(m, 'r1'))!.title).toBe('Ricetta uno');
  });

  it('never compacts what another device has not read yet', async () => {
    const tune = { snapshotEveryChanges: 1, retentionMs: 0 };
    let m = await on(B);
    await m.v2.syncOnceV2(store, { device: 'B', policy: 'ask', ...tune }); // B exists, has read nothing of A
    m = await on(A);
    await m.conflicts.createEntity('recipe', 'r1', { title: 'Pane' });
    await m.log.recordEntityChange('recipe', 'r1', (await recipeRow(m, 'r1'))!, 'A');
    await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', ...tune });
    const again = await m.v2.syncOnceV2(store, { device: 'A', policy: 'ask', ...tune });
    expect(again.segmentsCompacted).toBe(0);
    expect((await store.list(paths.log('A'))).length).toBeGreaterThan(0);
  });

  it('refuses a store written by a newer format', async () => {
    const { plainJson } = await import('../lib/changeLog/files');
    await store.put(paths.format, plainJson.encode({ format: 'smartchef-sync', version: 99, libraryId: 'x', createdAt: '' }));
    const m = await on(A);
    await expect(m.sync()).rejects.toThrow(/newer version/);
  });
});
