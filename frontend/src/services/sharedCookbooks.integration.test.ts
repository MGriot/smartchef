// ════════════════════════════════════════════════════════════════════════
// Shared cookbooks between two separate libraries on real SQLite: Anna's
// library (devices A1, A2) and Bruno's (B1, B2), each with its own store,
// meeting in one cookbook store. Saves go through writeEntityFile() in v2
// mode, as in the app.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryStore } from '../lib/changeLog/store';
import type { ImageFs } from '../lib/localImages';

// Four devices, two passphrase-derived invites per test: well inside 5 s
// alone, not always under a full parallel run.
vi.setConfig({ testTimeout: 30_000 });

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

vi.mock('../lib/gitfs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/gitfs')>();
  const refuse = async () => { throw new Error('git filesystem touched in v2 mode'); };
  return { ...real, gitfs: { promises: new Proxy({}, { get: () => refuse }) } };
});

const newDevice = (name: string): Device => ({
  name, db: new DatabaseSync(':memory:'), prefs: new Map([['smartchef.sync.deviceId', name]]), images: new Map(),
});

const imageFs = (d: Device): ImageFs => ({
  exists: async (p) => d.images.has(p),
  readFile: async (p) => { const b = d.images.get(p); if (!b) throw new Error(`missing ${p}`); return b; },
  writeFile: async (p, data) => { d.images.set(p, data); },
  list: async () => [...d.images.keys()],
});

let annaStore: ReturnType<typeof createMemoryStore>;
let brunoStore: ReturnType<typeof createMemoryStore>;
let bookStore: ReturnType<typeof createMemoryStore>;

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
  const conflicts = await import('./conflicts.local');
  const books = await import('./sharedCookbooks.local');
  books.setCookbookStoreFactory(async () => bookStore);
  const library = device.name.startsWith('A') ? annaStore : brunoStore;
  const syncLibrary = () => v2.syncOnceV2(library, { device: device.name, policy: 'ask' });
  const syncBook = async () => {
    const [book] = await books.listCookbooks();
    return books.syncCookbook(book, { device: device.name, policy: 'ask', images: imageFs(device) });
  };
  /** A save, as the app makes one: the row, then writeEntityFile(). */
  const save = async (type: string, id: string, fields: Record<string, unknown>) => {
    if (await conflicts.entityExists(type, id)) {
      await conflicts.applyEntityMergeResult(type, id, { applied: fields, conflicts: [] });
    } else {
      await conflicts.createEntity(type, id, fields);
    }
    await conflicts.resyncEntityToGit(type, id);
  };
  const recipe = (id: string) => db.queryOne<Record<string, unknown>>(`SELECT * FROM recipes WHERE id = $1`, [id]);
  return { db, log, books, conflicts, syncLibrary, syncBook, save, recipe };
}

let A1: Device; let A2: Device; let B1: Device; let B2: Device;

beforeEach(() => {
  annaStore = createMemoryStore();
  brunoStore = createMemoryStore();
  bookStore = createMemoryStore();
  A1 = newDevice('A1'); A2 = newDevice('A2'); B1 = newDevice('B1'); B2 = newDevice('B2');
});

/** Anna makes a cookbook and puts her focaccia in it; Bruno joins. */
async function annaSharesFocaccia() {
  let m = await on(A1);
  const book = await m.books.createCookbook('Cucina di famiglia', { kind: 'webdav', url: 'https://dav.example/shared', username: 'u', password: 'p' });
  const { hashBytes } = await import('../lib/localImages');
  const photo = new TextEncoder().encode('focaccia photo');
  const photoPath = `images/${await hashBytes(photo)}.jpg`;
  A1.images.set(photoPath, photo);
  A1.images.set(`images/${await hashBytes(new TextEncoder().encode('private'))}.jpg`, new TextEncoder().encode('private'));
  await m.save('tool', 'tool-teglia', { name: 'Teglia' });
  await m.save('ingredient', 'ing-farina-A', { name: 'Farina 00', category_name: 'Cereali' });
  await m.save('ingredient', 'ing-rosmarino-A', { name: 'Rosmarino', category_name: 'Erbe', synonyms: '["Ramerino"]' });
  await m.save('recipe', 'focaccia', {
    title: 'Focaccia', servings: 6, rating: 5, cover_image_url: photoPath,
    ingredients: [
      { id: 'ri-1', sort_order: 0, ingredient_id: 'ing-farina-A', quantity: 500, unit_symbol: 'g' },
      { id: 'ri-2', sort_order: 1, ingredient_id: 'ing-rosmarino-A', quantity: 1 },
    ],
    steps: [{ id: 'st-1', step_number: 1, description: 'Stendi nella {{tool:tool-teglia}} e inforna', tool_ids: '["tool-teglia"]' }],
    toolIds: ['tool-teglia'],
  });
  await m.books.addRecipesToCookbook(book.id, ['focaccia']);
  const first = await m.syncBook();
  expect(first.failed).toEqual([]);
  await m.syncLibrary();
  const invite = await m.books.buildInvite(book.id, 'pass phrase 1', 'Anna');

  // Bruno's library already has rosemary (by its synonym) and a baking tin.
  m = await on(B1);
  await m.save('ingredient', 'ing-ramerino-B', { name: 'Ramerino', category_name: 'Erbe' });
  await m.save('tool', 'tool-teglia-B', { name: 'Teglia' });
  const { cookbook } = await m.books.readInvite(invite, 'pass phrase 1');
  await m.books.joinCookbooks([cookbook]);
  const joined = await m.syncBook();
  expect(joined.failed).toEqual([]);
  return { book, invite, photoPath };
}

describe('shared cookbooks', () => {
  it('a member receives the recipe on its own catalog, its photo, and none of the sharer’s personal fields', async () => {
    const { photoPath } = await annaSharesFocaccia();
    const m = await on(B1);
    const r = await m.recipe('focaccia');
    expect(r).toMatchObject({ title: 'Focaccia', servings: 6, rating: null });
    expect(r!.cookbook_id).toBeTruthy();

    const rows = await m.db.query<{ ingredient_id: string }>(`SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = 'focaccia' ORDER BY sort_order`);
    expect(rows[1].ingredient_id).toBe('ing-ramerino-B');
    // Farina was new here: made under the cookbook's id, in Bruno's catalog.
    expect(rows[0].ingredient_id).toBe('ing-farina-A');
    expect(await m.db.queryOne(`SELECT name FROM ingredients WHERE id = 'ing-farina-A'`)).toMatchObject({ name: 'Farina 00' });
    const step = await m.db.queryOne<{ description: string; tool_ids: string }>(`SELECT description, tool_ids FROM recipe_steps WHERE recipe_id = 'focaccia'`);
    expect(step!.description).toBe('Stendi nella {{tool:tool-teglia-B}} e inforna');
    expect(JSON.parse(step!.tool_ids)).toEqual(['tool-teglia-B']);

    // Only the shared recipe's photo went into the cookbook.
    expect(B1.images.has(photoPath)).toBe(true);
    expect(B1.images.size).toBe(1);
  });

  it('a member’s edit reaches the sharer in the sharer’s ids; ratings stay in each library', async () => {
    await annaSharesFocaccia();
    let m = await on(B1);
    await m.save('recipe', 'focaccia', {
      servings: 8, rating: 3,
      steps: [{ id: 'st-1', step_number: 1, description: 'Stendi nella {{tool:tool-teglia-B}}, condisci e inforna', tool_ids: '["tool-teglia-B"]' }],
    });
    expect((await m.syncBook()).pushedChanges).toBeGreaterThan(0);

    // The library's own log carries Bruno's rating and where the recipe is,
    // never its content: that travels in the cookbook only.
    const own = await m.log.buildSegment('B1', 0, '');
    const recipePaths = own.changes.filter((c) => c.entityId === 'focaccia').map((c) => c.path);
    expect(recipePaths.sort()).toEqual(['cookbook_id', 'rating', 'times_cooked']);
    // The Farina made from the cookbook is in Bruno's own log, for his other devices.
    expect(own.changes.some((c) => c.entityType === 'ingredient' && c.entityId === 'ing-farina-A')).toBe(true);

    m = await on(A1);
    const back = await m.syncBook();
    expect(back.failed).toEqual([]);
    expect(await m.recipe('focaccia')).toMatchObject({ servings: 8, rating: 5 });
    const step = await m.db.queryOne<{ description: string }>(`SELECT description FROM recipe_steps WHERE recipe_id = 'focaccia'`);
    expect(step!.description).toBe('Stendi nella {{tool:tool-teglia}}, condisci e inforna');
    const rows = await m.db.query<{ ingredient_id: string }>(`SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = 'focaccia' ORDER BY sort_order`);
    expect(rows.map((r) => r.ingredient_id)).toEqual(['ing-farina-A', 'ing-rosmarino-A']);
    // Nothing Bruno did is a conflict for Anna, and Anna saved nothing new.
    expect(back.conflicts).toBe(0);
    expect((await m.syncBook()).pushedChanges).toBe(0);
  });

  it('a second device of the member library gets the cookbook from the Setup File, with no duplicate catalog rows', async () => {
    await annaSharesFocaccia();
    let m = await on(B1);
    await m.save('recipe', 'focaccia', { rating: 4 });
    await m.syncLibrary();
    const setup = await m.books.listCookbooks();

    m = await on(B2);
    await m.books.joinCookbooks(setup);
    expect((await m.syncLibrary()).failed).toEqual([]);
    const fromBook = await m.syncBook();
    expect(fromBook.failed).toEqual([]);
    expect(await m.recipe('focaccia')).toMatchObject({ title: 'Focaccia', rating: 4 });
    expect(await m.db.query(`SELECT id FROM ingredients WHERE name = 'Farina 00'`)).toHaveLength(1);
    expect(await m.db.query(`SELECT id FROM tools WHERE name = 'Teglia'`)).toHaveLength(1);
  });

  it('changes that arrive before the recipe’s move into the cookbook are written once the move arrives', async () => {
    let m = await on(A1);
    const book = await m.books.createCookbook('Pane', { kind: 'webdav', url: 'https://dav.example/pane', username: 'u', password: 'p' }, false);
    await m.save('recipe', 'pane', { title: 'Pane', servings: 2 });
    await m.syncLibrary();
    const setup = await m.books.listCookbooks();

    m = await on(A2);
    await m.books.joinCookbooks(setup);
    await m.syncLibrary();
    expect(await m.recipe('pane')).toMatchObject({ title: 'Pane', cookbook_id: null });

    m = await on(A1);
    await m.books.addRecipesToCookbook(book.id, ['pane']);
    await m.save('recipe', 'pane', { title: 'Pane di semola' });
    await m.syncBook();
    await m.syncLibrary();

    // A2 reads the cookbook before its own library says the recipe moved.
    m = await on(A2);
    await m.syncBook();
    expect(await m.recipe('pane')).toMatchObject({ title: 'Pane' });
    await m.syncLibrary();
    await m.syncBook();
    expect(await m.recipe('pane')).toMatchObject({ title: 'Pane di semola', cookbook_id: book.id });
  });

  it('leaving keeps a private copy, recorded whole into the library again', async () => {
    const { book } = await annaSharesFocaccia();
    const m = await on(B1);
    expect(await m.books.leaveCookbook(book.id)).toBe(1);
    expect(await m.recipe('focaccia')).toMatchObject({ title: 'Focaccia', cookbook_id: null });
    expect(await m.books.listCookbooks()).toEqual([]);
    const own = await m.log.buildSegment('B1', 0, '');
    expect(own.changes.some((c) => c.entityId === 'focaccia' && c.path === 'title')).toBe(true);
    expect(await m.db.query(`SELECT * FROM field_state WHERE scope = $1`, [book.id])).toEqual([]);
  });

  it('an invite opens only with its passphrase', async () => {
    const { invite } = await annaSharesFocaccia();
    const m = await on(B2);
    await expect(m.books.readInvite(invite, 'wrong passphrase')).rejects.toThrow();
  });

  it('a device upgrading from before scopes keeps its log as the library’s own', async () => {
    A1.db.exec(`
      CREATE TABLE change_log (seq INTEGER PRIMARY KEY, hlc TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT);
      CREATE TABLE field_state (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT, hlc TEXT NOT NULL, device TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (entity_type, entity_id, path));
      CREATE TABLE sync_cursor (device TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      INSERT INTO change_log VALUES (1, '000000000000001:00000:A1', 'recipe', 'r1', 'title', '"Pane"');
      INSERT INTO field_state VALUES ('recipe', 'r1', 'title', '"Pane"', '000000000000001:00000:A1', 'A1', 1);
      INSERT INTO sync_cursor VALUES ('B9', 7);
    `);
    const m = await on(A1);
    expect((await m.log.buildSegment('A1')).changes.map((c) => c.path)).toEqual(['title']);
    expect(await m.log.readCursors()).toEqual({ B9: 7 });
    expect((await m.log.listFieldState('recipe', 'r1')).get('title')?.value).toBe('Pane');
  });

  it('a cookbook store holding another library is refused', async () => {
    const m = await on(A1);
    await m.books.createCookbook('X', { kind: 'webdav', url: 'https://dav.example/x', username: 'u', password: 'p' }, false);
    bookStore = annaStore;
    await m.syncLibrary();
    await expect(m.syncBook()).rejects.toThrow(/different SmartChef library/);
  });
});
