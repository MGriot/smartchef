// ════════════════════════════════════════════════════════════════════════
// Two devices, one Sync Folder, the real sync engine end to end (ADR 0006).
//
// Every other sync test mocks either git or SQLite. That is how the
// original defect lived for months: mergeBridge.test.ts mocks findMergeBase
// to always return a base, so nothing ever noticed that two real devices
// never share one — each merge commit had a single parent, the remote
// never became an ancestor, and every field that differed came back as a
// conflict on every sync.
//
// Here both devices run the real gitSync.syncNow(): real isomorphic-git on
// real directories (a remapping gitfs mock over node:fs), real SQLite
// (node:sqlite), and folder-mode transport against a shared temp dir. A
// "device" is its own clone root, its own database and its own Preferences;
// switching devices resets the module graph so no in-memory state leaks
// from one to the other — exactly what two separate installs look like.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as nodeFs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

interface Device {
  name: string;
  root: string;
  db: DatabaseSync;
  prefs: Map<string, string>;
}

let current: Device;
let sharedFolder: string;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) {
            current.db.exec(sql);
            return;
          }
          current.db.exec('BEGIN');
          try {
            current.db.exec(sql);
            current.db.exec('COMMIT');
          } catch (err) {
            current.db.exec('ROLLBACK');
            throw err;
          }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: current.db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => {
          current.db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('one connection per device turn');
      },
    };
  }),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: current.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      current.prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      current.prefs.delete(key);
    },
  },
}));

// The app's paths ("/clone/recipes/x.json") land under the current device's
// own temp root. Every function is async on purpose: isomorphic-git decides
// whether an fs is promise-based by calling readFile() with no arguments and
// checking for a returned promise — a synchronous throw there makes it treat
// the fs as callback-style, and every git call then hangs forever.
function real(p: string): string {
  return nodePath.join(current.root, p);
}

vi.mock('../gitfs', () => {
  const promises = {
    readFile: async (p: string, options?: unknown) => nodeFs.readFile(real(p), options as never),
    writeFile: async (p: string, data: Uint8Array | string) => {
      await nodeFs.mkdir(nodePath.dirname(real(p)), { recursive: true });
      await nodeFs.writeFile(real(p), data);
    },
    unlink: async (p: string) => nodeFs.unlink(real(p)),
    readdir: async (p: string) => nodeFs.readdir(real(p)),
    mkdir: async (p: string) => nodeFs.mkdir(real(p), { recursive: true }).then(() => undefined),
    rmdir: async (p: string) => nodeFs.rm(real(p), { recursive: true, force: true }),
    stat: async (p: string) => nodeFs.stat(real(p)),
    lstat: async (p: string) => nodeFs.lstat(real(p)),
    readlink: async (p: string) => nodeFs.readlink(real(p)),
    symlink: async (target: string, p: string) => nodeFs.symlink(target, real(p)),
    chmod: async (p: string, mode: number) => nodeFs.chmod(real(p), mode),
  };
  return {
    gitfs: { promises },
    getSyncBasePath: async () => '/private',
    getElectronFolder: async () => sharedFolder,
    ensureSyncFolderPermission: async () => {},
    base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
    bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  };
});

vi.mock('../electronBridge', () => ({
  isElectron: () => true,
  getHiddenCloneDir: async () => '/clone',
}));

// Folder mode, with the Sync Folder being a plain shared directory — what
// Syncthing presents to each device once it has replicated.
vi.mock('./electronRemoteTransport', () => ({
  createElectronRemoteTransport: async () => ({
    exists: async (rel: string) => nodeFs.access(nodePath.join(sharedFolder, rel)).then(() => true, () => false),
    readFile: async (rel: string) => new Uint8Array(await nodeFs.readFile(nodePath.join(sharedFolder, rel))),
    writeFile: async (rel: string, data: Uint8Array) => {
      const target = nodePath.join(sharedFolder, rel);
      await nodeFs.mkdir(nodePath.dirname(target), { recursive: true });
      await nodeFs.writeFile(target, data);
    },
    listDir: async (rel: string) => nodeFs.readdir(nodePath.join(sharedFolder, rel)).catch(() => [] as string[]),
  }),
}));

// Images have their own tests (imageSync.test.ts) and need a real app image
// store; nothing here involves a photo.
vi.mock('./imageSync', () => ({
  copyImagesIntoClone: async () => ({ copied: 0 }),
  copyImagesOutOfClone: async () => ({ copied: 0 }),
  materializeImagesFromCommit: async () => ({ copied: 0 }),
}));

let tempDirs: string[] = [];

async function newDevice(name: string): Promise<Device> {
  const root = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), `smartchef-${name}-`));
  tempDirs.push(root);
  return { name, root, db: new DatabaseSync(':memory:'), prefs: new Map([['smartchef.sync.deviceId', `device-${name}`]]) };
}

/** Switches to `device` with a fresh module graph, as a separate install
 *  would have, and hands back the modules a test drives it through. */
async function on(device: Device) {
  current = device;
  vi.resetModules();
  const local = await import('../../db/local');
  await local.initLocalSchema();
  const gitSync = await import('./gitSync');
  const conflicts = await import('../../services/conflicts.local');
  const recipes = await import('../../services/recipes.local');
  const settings = await import('./syncSettings');
  const ingredients = await import('../../services/ingredients.local');
  return {
    ...local, ...gitSync, ...conflicts, ...recipes, ...settings,
    syncIngredient: ingredients.syncIngredient, createCategory: ingredients.createCategory, createUnit: ingredients.createUnit,
  };
}

type DeviceApi = Awaited<ReturnType<typeof on>>;

async function createRecipe(api: DeviceApi, id: string, fields: Record<string, unknown>, updatedAt = '2026-09-01 10:00:00') {
  await api.createEntity('recipe', id, { id, servings: 4, ...fields });
  await api.query('UPDATE recipes SET updated_at = $1 WHERE id = $2', [updatedAt, id]);
  await api.syncRecipe(id);
}

/** A local edit, as the editor would make it: new value, fresh updated_at,
 *  re-serialized into the Hidden Clone. */
async function editRecipe(api: DeviceApi, id: string, column: string, value: unknown, updatedAt: string) {
  await api.query(`UPDATE recipes SET ${column} = $1, updated_at = $2 WHERE id = $3`, [value, updatedAt, id]);
  await api.syncRecipe(id);
}

async function recipeRow(api: DeviceApi, id: string) {
  return api.queryOne<Record<string, unknown>>('SELECT * FROM recipes WHERE id = $1', [id]);
}

beforeEach(async () => {
  // writeEntityFile() schedules a debounced commit on a timer; syncNow()
  // commits pending work itself, and a stray timer firing after the test has
  // switched devices would commit into the wrong clone.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sharedFolder = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), 'smartchef-syncfolder-'));
  tempDirs = [sharedFolder];
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs) await nodeFs.rm(dir, { recursive: true, force: true });
});

describe('two devices syncing through one Sync Folder', { timeout: 60_000 }, () => {
  it('shares history after the first merge, so later edits to different fields merge with no conflicts', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', { title: 'Lasagna', tips: 'Riposo 10 min', tags: '["Primo"]' });
    await api.syncNow();

    api = await on(b);
    const first = await api.syncNow();
    expect(first.conflicts).toBe(0);
    expect((await recipeRow(api, 'r1'))?.title).toBe('Lasagna');

    // Different fields on each side.
    await editRecipe(api, 'r1', 'tips', 'Riposo di 20 minuti', '2026-09-10 10:00:00');
    await api.syncNow();

    api = await on(a);
    await editRecipe(api, 'r1', 'title', 'Lasagna della nonna', '2026-09-11 10:00:00');
    const onA = await api.syncNow();
    expect(onA.conflicts).toBe(0);
    // The heart of ADR 0006: A's history now contains B's merge commit, so
    // the two devices share an ancestor — before, they never did.
    const git = await import('isomorphic-git');
    const { gitfs } = await import('../gitfs');
    const head = await git.resolveRef({ fs: gitfs, dir: '/clone', gitdir: '/clone/.git', ref: 'HEAD' });
    const remote = await git.resolveRef({ fs: gitfs, dir: '/clone', gitdir: '/clone/.git', ref: 'refs/remotes/sync-folder/main' });
    expect(
      await git.isDescendent({ fs: gitfs, dir: '/clone', gitdir: '/clone/.git', oid: head, ancestor: remote, depth: -1 }),
      `HEAD ${head} should descend from ${remote}; sync result ${JSON.stringify(onA)}; pause ${current.prefs.get('smartchef.sync.pauseReason') ?? JSON.stringify([...current.prefs.entries()].filter(([k]) => /pause/i.test(k)))}`
    ).toBe(true);
    const rowA = await recipeRow(api, 'r1');
    expect(rowA?.title).toBe('Lasagna della nonna');
    expect(rowA?.tips).toBe('Riposo di 20 minuti');

    api = await on(b);
    const onB = await api.syncNow();
    expect(onB.conflicts).toBe(0);
    const rowB = await recipeRow(api, 'r1');
    expect(rowB?.title).toBe('Lasagna della nonna');
    expect(rowB?.tips).toBe('Riposo di 20 minuti');

    // And a sync with nothing new is a no-op, not a fresh round of conflicts.
    const idle = await api.syncNow();
    expect(idle.conflicts).toBe(0);
    expect(idle.applied).toBe(0);
    expect(await api.listPendingConflicts()).toEqual([]);
  });

  it('newest policy: when both change the same field, the later edit wins on both devices', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', { title: 'Guacamole', description: 'Originale' });
    await api.syncNow();
    api = await on(b);
    await api.syncNow();

    await editRecipe(api, 'r1', 'description', 'Versione di B (più recente)', '2026-09-15 10:00:00');
    await api.syncNow();

    api = await on(a);
    await editRecipe(api, 'r1', 'description', 'Versione di A (più vecchia)', '2026-09-12 10:00:00');
    const result = await api.syncNow();
    expect(result.conflicts).toBe(0);
    expect(result.autoResolved).toBeGreaterThan(0);
    expect((await recipeRow(api, 'r1'))?.description).toBe('Versione di B (più recente)');

    api = await on(b);
    await api.syncNow();
    expect((await recipeRow(api, 'r1'))?.description).toBe('Versione di B (più recente)');
  });

  it('mixed policies: the device that merges decides once, and the asking device is never asked again', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', { title: 'Pan di Spagna' });
    await api.syncNow();
    // A edits but has not synced yet.
    await editRecipe(api, 'r1', 'title', 'Pan di Spagna di A', '2026-09-12 10:00:00');

    // B (policy: ask) edits the same field later and pushes first.
    api = await on(b);
    await api.setConflictPolicy('ask');
    await api.syncNow();
    await editRecipe(api, 'r1', 'title', 'Pan di Spagna di B', '2026-09-13 10:00:00');
    await api.syncNow();

    // A (default policy: newest) is the one that meets the disagreement,
    // and settles it for B's newer edit.
    api = await on(a);
    const onA = await api.syncNow();
    expect(onA.conflicts).toBe(0);
    expect((await recipeRow(api, 'r1'))?.title).toBe('Pan di Spagna di B');

    // B then receives a merge that already agrees with it: nothing to ask.
    api = await on(b);
    const onB = await api.syncNow();
    expect(onB.conflicts).toBe(0);
    expect(await api.listPendingConflicts()).toEqual([]);
    expect((await recipeRow(api, 'r1'))?.title).toBe('Pan di Spagna di B');
  });

  it('ask policy on both devices: a genuine disagreement is asked once, and the choice propagates', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await api.setConflictPolicy('ask');
    await createRecipe(api, 'r1', { title: 'Mini cheesecake' });
    await api.syncNow();

    api = await on(b);
    await api.setConflictPolicy('ask');
    await api.syncNow();
    await editRecipe(api, 'r1', 'title', 'Mini cheesecake (B)', '2026-09-13 10:00:00');
    await api.syncNow();

    api = await on(a);
    await editRecipe(api, 'r1', 'title', 'Mini cheesecake (A)', '2026-09-14 10:00:00');
    const onA = await api.syncNow();
    expect(onA.conflicts).toBe(1);
    const [conflict] = await api.listPendingConflicts();
    expect(conflict.fieldName).toBe('title');
    expect(conflict.localValue).toBe('Mini cheesecake (A)');
    expect(conflict.remoteValue).toBe('Mini cheesecake (B)');

    // Until A decides, B must not receive A's value as if it were an edit.
    api = await on(b);
    await api.syncNow();
    expect((await recipeRow(api, 'r1'))?.title).toBe('Mini cheesecake (B)');

    // A keeps its own.
    api = await on(a);
    const resolved = await api.resolveConflict(conflict.id, 'local');
    await api.applyResolvedConflict(resolved!);
    const afterResolve = await api.syncNow();
    expect(afterResolve.conflicts).toBe(0);

    api = await on(b);
    const onB = await api.syncNow();
    expect(onB.conflicts).toBe(0);
    expect((await recipeRow(api, 'r1'))?.title).toBe('Mini cheesecake (A)');
  });

  it('devices that never shared history converge without conflicts on identical content and fill each other’s gaps', async () => {
    // The real-world upgrade case: two devices each hold the same library
    // (imported separately, or synced under the old single-parent commits),
    // serialized with different child-row ids and one side missing fields.
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', {
      title: 'Marmellata di rabarbaro',
      description: 'Confettura di rabarbaro con una mela.',
      tags: '["Confettura","Dolce"]',
      steps: [
        { id: 'a-step-1', step_number: 1, description: 'Macerare con zucchero e limone.' },
        { id: 'a-step-2', step_number: 2, description: 'Cuocere e frullare.' },
      ],
    });
    await api.syncNow();

    api = await on(b);
    await api.setConflictPolicy('ask'); // nothing here should need asking even so
    await createRecipe(api, 'r1', {
      title: 'Marmellata di rabarbaro',
      description: '',
      tips: 'Invasare ancora calda.',
      tags: '["Dolce","Confettura"]',
      steps: [
        { id: 'b-step-2', step_number: 2, description: 'Cuocere e frullare.' },
        { id: 'b-step-1', step_number: 1, description: 'Macerare con zucchero e limone.' },
      ],
    });
    const result = await api.syncNow();
    expect(result.conflicts).toBe(0);
    const row = await recipeRow(api, 'r1');
    expect(row?.description).toBe('Confettura di rabarbaro con una mela.');
    expect(row?.tips).toBe('Invasare ancora calda.');

    api = await on(a);
    const back = await api.syncNow();
    expect(back.conflicts).toBe(0);
    expect((await recipeRow(api, 'r1'))?.tips).toBe('Invasare ancora calda.');
  });

  it('gives seeded categories the same portable id on every device, so a synced ingredient lands in its category', async () => {
    // Categories used to be seeded with random ids per device: the same
    // "Frutta" had a different id everywhere, and every synced ingredient
    // landed in "Uncategorized" with every category showing 0.
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    const fruttaOnA = await api.queryOne<{ id: string }>("SELECT id FROM ingredient_categories WHERE name = 'Frutta'");
    expect(fruttaOnA!.id).toBe('cat-frutta');
    await api.createEntity('ingredient', 'ing-1', { id: 'ing-1', name: 'Mela', category_id: fruttaOnA!.id });
    await api.syncIngredient('ing-1');
    await api.syncNow();

    api = await on(b);
    const first = await api.syncNow();
    expect(first.conflicts).toBe(0);
    const mela = await api.queryOne<{ category_id: string }>('SELECT category_id FROM ingredients WHERE id = $1', ['ing-1']);
    expect(mela?.category_id).toBe('cat-frutta');
    // No duplicate "Frutta" from the synced category file.
    const frutta = await api.query("SELECT id FROM ingredient_categories WHERE name = 'Frutta' AND deleted_at IS NULL");
    expect(frutta).toHaveLength(1);

    api = await on(a);
    expect((await api.syncNow()).conflicts).toBe(0);
  });

  it('replace from synced data: this device becomes exactly the synced library, keeping a backup and its cooking history', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', { title: 'Lasagna' });
    await createRecipe(api, 'r2', { title: 'Tiramisù' });
    await api.syncNow();

    api = await on(b);
    await api.syncNow();
    await editRecipe(api, 'r1', 'title', 'Lasagna (versione di B)', '2026-09-15 10:00:00');
    await api.syncNow();

    // A drifts: a recipe only it has, an unsynced edit, and some cooking.
    api = await on(a);
    await createRecipe(api, 'r3', { title: 'Solo su A' });
    await editRecipe(api, 'r2', 'title', 'Tiramisù modificato su A', '2026-09-16 10:00:00');
    await api.query(`INSERT INTO cook_log (id, recipe_id) VALUES ('cook-1', 'r1')`);
    const git = await import('isomorphic-git');
    const { gitfs } = await import('../gitfs');
    const repo = { fs: gitfs, dir: '/clone', gitdir: '/clone/.git' };

    const preview = await api.previewReplaceFromRemote();
    expect(preview.local.recipe).toBe(3);
    expect(preview.remote.recipe).toBe(2);
    // The preview changes nothing.
    expect((await recipeRow(api, 'r3'))?.title).toBe('Solo su A');

    const result = await api.replaceLocalWithRemote();
    expect(result.failedEntities).toEqual([]);
    expect(result.discarded).toBe(1);
    expect((await recipeRow(api, 'r1'))?.title).toBe('Lasagna (versione di B)');
    expect((await recipeRow(api, 'r2'))?.title).toBe('Tiramisù');
    expect(await recipeRow(api, 'r3')).toBeNull();
    expect(await api.queryOne('SELECT id FROM cook_log WHERE id = $1', ['cook-1'])).not.toBeNull();

    // The old history — including the discarded recipe — is still there.
    expect(result.backupRef).toMatch(/^refs\/backups\/pre-replace-/);
    const backupOid = await git.resolveRef({ ...repo, ref: result.backupRef! });
    const backupFiles = await git.listFiles({ ...repo, ref: backupOid });
    expect(backupFiles).toContain('recipes/r3.json');

    // And the next sync has nothing to merge or commit: this device now
    // sits exactly on the synced commit. (Folder-mode push still uploads the
    // loose objects of the backed-up history — unreferenced, and harmless.)
    const next = await api.syncNow();
    expect(next.conflicts).toBe(0);
    expect(next.applied).toBe(0);
    expect(next.committed).toBe(false);
    const head = await git.resolveRef({ ...repo, ref: 'HEAD' });
    expect(head).toBe(await git.resolveRef({ ...repo, ref: 'refs/remotes/sync-folder/main' }));
  });

  it('commits an edit that keeps the file the same size, made within the same second as the previous write', async () => {
    // isomorphic-git's statusMatrix trusts the index stat cache (size + mtime
    // seconds): "Riposo 10 min" -> "Riposo 20 min" rewritten right after a
    // merge used to be seen as unchanged and never committed.
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    await createRecipe(api, 'r1', { title: 'Lasagna', tips: 'Riposo 10 min' });
    await api.syncNow();

    api = await on(b);
    await api.syncNow();
    await editRecipe(api, 'r1', 'tips', 'Riposo 20 min', '2026-09-01 10:00:01');
    const pushed = await api.syncNow();
    expect(pushed.committed).toBe(true);

    api = await on(a);
    await api.syncNow();
    expect((await recipeRow(api, 'r1'))?.tips).toBe('Riposo 20 min');
  });

  it('syncs the whole library: translations, step translations, ingredient tags, a new category and a new unit', async () => {
    const a = await newDevice('a');
    const b = await newDevice('b');

    let api = await on(a);
    const { id: categoryId } = await api.createCategory({ name: 'Conserve', translations: [{ lang: 'en', name: 'Preserves' }] });
    const { id: unitId } = await api.createUnit({ name: 'vasetto', symbol: 'vas', unitType: 'count', translations: [{ lang: 'en', name: 'jar' }] });
    expect(categoryId).toBe('cat-conserve');
    expect(unitId).toBe('unit-vas');
    await api.query(`INSERT INTO tags (id, name) VALUES ('tag-dolce', 'Dolce')`);
    await api.createEntity('ingredient', 'ing-1', { id: 'ing-1', name: 'Rabarbaro', category_id: categoryId });
    await api.query(`INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ('ing-1', 'tag-dolce')`);
    await api.query(`INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ('it-1', 'ing-1', 'en', 'Rhubarb')`);
    await createRecipe(api, 'r1', {
      title: 'Marmellata di rabarbaro',
      steps: [{ id: 's1', step_number: 1, description: 'Cuocere.' }],
      ingredients: [{ id: 'ri1', sort_order: 0, ingredient_id: 'ing-1', quantity: 2, unit_id: unitId }],
    });
    await api.query(`INSERT INTO recipe_translations (id, recipe_id, language_code, title) VALUES ('rt1', 'r1', 'en', 'Rhubarb jam')`);
    await api.query(`INSERT INTO recipe_step_translations (id, step_id, language_code, description) VALUES ('st1', 's1', 'en', 'Cook.')`);
    // Everything lives outside the recipe/ingredient rows themselves, so the
    // tag sync and the re-serialize are what carry them.
    const tags = await import('../../services/tags.local');
    await tags.syncTag('tag-dolce');
    await api.syncIngredient('ing-1');
    await api.syncRecipe('r1');
    await api.syncNow();

    api = await on(b);
    const onB = await api.syncNow();
    expect(onB.failedEntities).toEqual([]);
    expect(onB.conflicts).toBe(0);
    expect(await api.queryOne(`SELECT name FROM ingredient_categories WHERE id = 'cat-conserve'`)).toEqual({ name: 'Conserve' });
    expect(await api.queryOne(`SELECT name FROM ingredient_category_translations WHERE category_id = 'cat-conserve' AND language_code = 'en'`)).toEqual({ name: 'Preserves' });
    expect(await api.queryOne(`SELECT symbol FROM units WHERE id = 'unit-vas'`)).toEqual({ symbol: 'vas' });
    expect(await api.queryOne(`SELECT name FROM unit_translations WHERE unit_id = 'unit-vas'`)).toEqual({ name: 'jar' });
    expect(await api.queryOne(`SELECT category_id FROM ingredients WHERE id = 'ing-1'`)).toEqual({ category_id: 'cat-conserve' });
    expect(await api.query(`SELECT tag_id FROM ingredient_tags WHERE ingredient_id = 'ing-1'`)).toEqual([{ tag_id: 'tag-dolce' }]);
    expect(await api.queryOne(`SELECT translated_name FROM ingredient_translations WHERE ingredient_id = 'ing-1'`)).toEqual({ translated_name: 'Rhubarb' });
    expect(await api.queryOne(`SELECT title FROM recipe_translations WHERE recipe_id = 'r1'`)).toEqual({ title: 'Rhubarb jam' });
    expect(await api.queryOne(`SELECT description FROM recipe_step_translations WHERE step_id = 's1'`)).toEqual({ description: 'Cook.' });
    expect(await api.queryOne(`SELECT unit_id FROM recipe_ingredients WHERE recipe_id = 'r1'`)).toEqual({ unit_id: 'unit-vas' });

    // Each device adds a different language: both survive, no conflict.
    await api.query(`INSERT INTO recipe_translations (id, recipe_id, language_code, title) VALUES ('rt-fr', 'r1', 'fr', 'Confiture de rhubarbe')`);
    await api.query(`UPDATE recipes SET updated_at = '2026-09-12 10:00:00' WHERE id = 'r1'`);
    await api.syncRecipe('r1');
    await api.syncNow();

    api = await on(a);
    await api.query(`INSERT INTO recipe_translations (id, recipe_id, language_code, title) VALUES ('rt-es', 'r1', 'es', 'Mermelada de ruibarbo')`);
    await api.query(`UPDATE recipes SET updated_at = '2026-09-13 10:00:00' WHERE id = 'r1'`);
    await api.syncRecipe('r1');
    const onA = await api.syncNow();
    expect(onA.conflicts).toBe(0);
    const langs = (await api.query<{ language_code: string }>(`SELECT language_code FROM recipe_translations WHERE recipe_id = 'r1' ORDER BY language_code`)).map((r) => r.language_code);
    expect(langs).toEqual(['en', 'es', 'fr']);
  });
});
