// ════════════════════════════════════════════════════════════════════════
// "Send a copy" between two separate libraries on real SQLite: the share
// file built on one, imported on the other with its own catalog.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

interface Library { db: DatabaseSync; prefs: Map<string, string>; images: Map<string, Uint8Array> }
let current: Library;

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
      retrieveConnection: async () => { throw new Error('one connection per library turn'); },
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

vi.mock('../lib/localImages', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/localImages')>();
  const fs = () => ({
    exists: async (p: string) => current.images.has(p),
    readFile: async (p: string) => { const b = current.images.get(p); if (!b) throw new Error(`missing ${p}`); return b; },
    writeFile: async (p: string, d: Uint8Array) => { current.images.set(p, d); },
    list: async () => [...current.images.keys()],
  });
  return { ...real, defaultImageFs: fs, storeImage: (bytes: Uint8Array, ext: string) => real.storeImage(bytes, ext, fs()) };
});

const newLibrary = (): Library => ({ db: new DatabaseSync(':memory:'), prefs: new Map(), images: new Map() });

async function on(lib: Library) {
  current = lib;
  vi.resetModules();
  const db = await import('../db/local');
  await db.initLocalSchema();
  const conflicts = await import('./conflicts.local');
  const share = await import('./recipeShare.local');
  return { db, conflicts, share };
}

let A: Library;
let B: Library;

beforeEach(() => {
  A = newLibrary();
  B = newLibrary();
});

describe('send a copy between libraries', () => {
  async function shareFromA() {
    const m = await on(A);
    const { hashBytes } = await import('../lib/localImages');
    const photo = new TextEncoder().encode('focaccia photo');
    const photoPath = `images/${await hashBytes(photo)}.jpg`;
    A.images.set(photoPath, photo);
    await m.conflicts.createEntity('tool', 'tool-teglia', { name: 'Teglia' });
    await m.conflicts.createEntity('ingredient', 'ing-farina-A', { name: 'Farina 00', category_name: 'Cereali' });
    await m.conflicts.createEntity('ingredient', 'ing-rosmarino-A', { name: 'Rosmarino', category_name: 'Erbe', synonyms: '["Ramerino"]' });
    await m.conflicts.createEntity('recipe', 'rec-A', {
      title: 'Focaccia', servings: 6, rating: 5, cover_image_url: photoPath,
      ingredients: [
        { id: 'ri-1', sort_order: 0, ingredient_id: 'ing-farina-A', quantity: 500, unit_symbol: 'g' },
        { id: 'ri-2', sort_order: 1, ingredient_id: 'ing-rosmarino-A', quantity: 1 },
      ],
      steps: [{ id: 'st-1', step_number: 1, description: 'Stendi nella {{tool:tool-teglia}} e inforna', tool_ids: '["tool-teglia"]' }],
      toolIds: ['tool-teglia'],
    });
    return m.share.buildShareFile(['rec-A'], 'Anna');
  }

  it('builds a self-contained file with the recipe, what it uses and its photo', async () => {
    const file = await shareFromA();
    expect(file.recipes.map((r) => r.title)).toEqual(['Focaccia']);
    expect(file.ingredients.map((i) => i.name).sort()).toEqual(['Farina 00', 'Rosmarino']);
    expect(file.tools.map((t) => t.name)).toEqual(['Teglia']);
    expect(Object.keys(file.images)).toHaveLength(1);
  });

  it('imports as the receiver’s own recipe: its ingredients matched by name, new ones created, references relinked', async () => {
    const file = JSON.parse(JSON.stringify(await shareFromA()));

    const m = await on(B);
    // B already has rosemary, under its synonym and another id.
    await m.conflicts.createEntity('ingredient', 'ing-rosmarino-B', { name: 'Ramerino', category_name: 'Erbe' });
    const report = await m.share.importShareFile(file);

    expect(report.recipes).toHaveLength(1);
    expect(report.matched.ingredients).toBe(1);
    expect(report.created).toMatchObject({ ingredients: 1, tools: 1 });
    expect(report.images).toBe(1);

    const id = report.recipes[0].id;
    expect(id).not.toBe('rec-A');
    const recipe = await m.db.queryOne<Record<string, unknown>>(`SELECT * FROM recipes WHERE id = $1`, [id]);
    expect(recipe).toMatchObject({ title: 'Focaccia', servings: 6, rating: null });
    expect(JSON.parse(String(recipe!.sources))).toEqual([{ type: 'other', label: 'Shared by Anna' }]);

    const rows = await m.db.query<Record<string, unknown>>(`SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY sort_order`, [id]);
    expect(rows[1].ingredient_id).toBe('ing-rosmarino-B');
    const farina = await m.db.queryOne<{ name: string }>(`SELECT name FROM ingredients WHERE id = $1`, [rows[0].ingredient_id]);
    expect(farina?.name).toBe('Farina 00');

    const tool = await m.db.queryOne<{ id: string }>(`SELECT id FROM tools WHERE name = 'Teglia'`);
    const step = await m.db.queryOne<Record<string, unknown>>(`SELECT description, tool_ids FROM recipe_steps WHERE recipe_id = $1`, [id]);
    expect(step!.description).toBe(`Stendi nella {{tool:${tool!.id}}} e inforna`);
    expect(JSON.parse(String(step!.tool_ids))).toEqual([tool!.id]);
    expect(B.images.size).toBe(1);
  });

  it('importing the same file twice gives two recipes, each with its own rows', async () => {
    const file = JSON.parse(JSON.stringify(await shareFromA()));
    const m = await on(B);
    const first = await m.share.importShareFile(file);
    const second = await m.share.importShareFile(file);
    expect(first.recipes[0].id).not.toBe(second.recipes[0].id);
    for (const r of [first, second]) {
      const rows = await m.db.query(`SELECT id FROM recipe_ingredients WHERE recipe_id = $1`, [r.recipes[0].id]);
      expect(rows).toHaveLength(2);
    }
    // The second import reuses what the first created.
    expect(second.created).toMatchObject({ ingredients: 0, tools: 0 });
  });

  it('refuses something that is not a share file', async () => {
    const m = await on(B);
    await expect(m.share.importShareFile({ formatVersion: 1, recipes: [] } as never)).rejects.toThrow(/not a SmartChef share file/);
  });
});
