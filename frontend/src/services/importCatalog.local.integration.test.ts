// ════════════════════════════════════════════════════════════════════════
// The library catalog that gets handed to the model on an AI import.
//
// Runs against real SQLite (node:sqlite, same mock as
// localMatcher.language.integration.test.ts) rather than a stub, because
// every property under test is a property of the SQL: the soft-delete
// filters, the translation joins, the usage ordering behind the cap. A
// mocked query() would assert nothing about any of them.
//
// The query-count test at the bottom is the one worth not deleting. The
// obvious "simplification" here is to call listIngredients()/listTools()/
// listTechniques() instead of hand-rolled SQL — and those fan out into
// several more batched queries each for tags, category translations and
// full translation sets, every one a real Capacitor bridge crossing on
// Android, to produce fields the prompt then discards.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
let queryCount = 0;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) {
            db.exec(sql);
            return;
          }
          db.exec('BEGIN');
          try {
            db.exec(sql);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        },
        query: async (sql: string, params: unknown[] = []) => {
          queryCount++;
          const stmt = db.prepare(sql);
          return { values: stmt.all(...(params as never[])) };
        },
        run: async (sql: string, params: unknown[] = []) => {
          queryCount++;
          db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected in this test — one connection, created once');
      },
    };
  }),
}));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  queryCount = 0;
  vi.resetModules();
});

/** An English-named library with Italian translations on file — the shape
 *  a real install has (base name English, translations alongside). */
async function seedLibrary() {
  const { initLocalSchema, query } = await import('../db/local');
  await initLocalSchema();

  await query(`INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)`, ['cat-1', 'Pantry']);

  const ingredients: Array<[string, string, string | null]> = [
    ['ing-butter', 'Butter', 'Burro'],
    ['ing-flour', 'Flour', 'Farina'],
    // Deliberately untranslated: an ingredient that only has an English
    // name must still reach the prompt, bare.
    ['ing-tahini', 'Tahini', null],
  ];
  for (const [id, name, italian] of ingredients) {
    await query(
      `INSERT INTO ingredients (id, name, category_id, sync_status) VALUES ($1, $2, $3, 'synced')`,
      [id, name, 'cat-1']
    );
    if (italian) {
      await query(
        `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
         VALUES ($1, $2, $3, $4)`,
        [`itr-${id}`, id, 'it', italian]
      );
    }
  }

  await query(`INSERT INTO tools (id, name) VALUES ($1, $2)`, ['tool-mixer', 'Stand Mixer']);
  await query(
    `INSERT INTO tool_translations (id, tool_id, language_code, name) VALUES ($1, $2, $3, $4)`,
    ['ttr-mixer', 'tool-mixer', 'it', 'Planetaria']
  );

  await query(`INSERT INTO techniques (id, name) VALUES ($1, $2)`, ['tec-braise', 'Braise']);
  await query(
    `INSERT INTO technique_translations (id, technique_id, language_code, name) VALUES ($1, $2, $3, $4)`,
    ['tectr-braise', 'tec-braise', 'it', 'Brasare']
  );
}

/** Links an ingredient to N recipes, so the usage ordering has something
 *  to sort on. */
async function useIngredient(id: string, times: number) {
  const { query } = await import('../db/local');
  for (let i = 0; i < times; i++) {
    const recipeId = `rec-${id}-${i}`;
    await query(`INSERT INTO recipes (id, title) VALUES ($1, $2)`, [recipeId, `Recipe ${recipeId}`]);
    await query(
      `INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, sort_order) VALUES ($1, $2, $3, 0)`,
      [`ri-${recipeId}`, recipeId, id]
    );
  }
}

describe('loadImportCatalog()', () => {
  it('returns empty lists for a fresh install, so the prompt is unchanged', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const { loadImportCatalog } = await import('./importCatalog.local');

    expect(await loadImportCatalog('it')).toEqual({ ingredients: [], tools: [], techniques: [] });
  });

  it('labels every list in the requested language', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it');

    expect(catalog.ingredients).toContainEqual({ name: 'Butter', translatedName: 'Burro' });
    expect(catalog.tools).toEqual([{ name: 'Stand Mixer', translatedName: 'Planetaria' }]);
    expect(catalog.techniques).toEqual([{ name: 'Braise', translatedName: 'Brasare' }]);
  });

  it('leaves translatedName null where no translation exists', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it');

    expect(catalog.ingredients).toContainEqual({ name: 'Tahini', translatedName: null });
  });

  it('returns a different language as untranslated rather than as Italian', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('fr');

    expect(catalog.ingredients.every((i) => i.translatedName === null)).toBe(true);
    expect(catalog.tools[0].translatedName).toBeNull();
  });

  // The legacy /llm/parse route calls through with no language at all.
  it('works with no language, sending base names only', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog();

    expect(catalog.ingredients.map((i) => i.name).sort()).toEqual(['Butter', 'Flour', 'Tahini']);
    expect(catalog.ingredients.every((i) => i.translatedName === null)).toBe(true);
  });

  it('matches the language case-insensitively', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('IT');

    expect(catalog.tools[0].translatedName).toBe('Planetaria');
  });

  it('excludes deleted ingredients, tools and techniques', async () => {
    await seedLibrary();
    const { query } = await import('../db/local');
    await query(`UPDATE ingredients SET sync_status = 'deleted' WHERE id = $1`, ['ing-flour']);
    await query(`UPDATE tools SET deleted_at = '2026-01-01' WHERE id = $1`, ['tool-mixer']);
    await query(`UPDATE techniques SET deleted_at = '2026-01-01' WHERE id = $1`, ['tec-braise']);

    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it');

    expect(catalog.ingredients.map((i) => i.name)).not.toContain('Flour');
    expect(catalog.tools).toEqual([]);
    expect(catalog.techniques).toEqual([]);
  });

  // An ingredient used in one recipe must not be one row per recipe.
  it('lists an ingredient once however many recipes use it', async () => {
    await seedLibrary();
    await useIngredient('ing-butter', 3);
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it');

    expect(catalog.ingredients.filter((i) => i.name === 'Butter')).toHaveLength(1);
  });

  it('orders ingredients by how often they are actually used', async () => {
    await seedLibrary();
    await useIngredient('ing-tahini', 3);
    await useIngredient('ing-flour', 1);
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it');

    // Tahini (3 uses), Flour (1), then unused Butter.
    expect(catalog.ingredients.map((i) => i.name)).toEqual(['Tahini', 'Flour', 'Butter']);
  });

  // The cap has to drop the ingredients this library barely uses, not
  // everything alphabetically past the cut — which is what a plain
  // ORDER BY name LIMIT would do.
  it('keeps the most-used ingredients when the cap bites', async () => {
    await seedLibrary();
    await useIngredient('ing-tahini', 5);
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it', 1);

    expect(catalog.ingredients).toEqual([{ name: 'Tahini', translatedName: null }]);
  });

  it('never caps tools or techniques', async () => {
    await seedLibrary();
    const { loadImportCatalog } = await import('./importCatalog.local');
    const catalog = await loadImportCatalog('it', 1);

    expect(catalog.tools).toHaveLength(1);
    expect(catalog.techniques).toHaveLength(1);
  });

  it('sorts tools and techniques by name', async () => {
    await seedLibrary();
    const { query } = await import('../db/local');
    await query(`INSERT INTO tools (id, name) VALUES ($1, $2)`, ['tool-blender', 'Blender']);
    const { loadImportCatalog } = await import('./importCatalog.local');

    expect((await loadImportCatalog('it')).tools.map((t) => t.name)).toEqual(['Blender', 'Stand Mixer']);
  });

  // Three lists, three queries. If this number climbs, something started
  // fanning out per row — see the header.
  it('costs exactly three queries however big the library is', async () => {
    await seedLibrary();
    await useIngredient('ing-butter', 4);
    const { loadImportCatalog } = await import('./importCatalog.local');

    queryCount = 0;
    await loadImportCatalog('it');
    expect(queryCount).toBe(3);
  });
});
