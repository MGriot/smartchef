// ════════════════════════════════════════════════════════════════════════
// Standalone-mode listRecipes(): the gallery's paged read.
//
// The gallery used to load every recipe, every column and both correlated
// subqueries for the whole library on each open. It now asks for a page,
// and the tag / region / season filters still run in JS, so a page can only
// be cut after them. This pins that the pages, laid end to end, are exactly
// the unpaged list in the same order (filters included), that total and
// hasMore are right, that a caller without `limit` is unaffected, and that
// the indexes the reads rely on exist.
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

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  queryCount = 0;
  vi.resetModules();
});

/** createRecipe() syncs to the entity files without awaiting it (see
 *  syncRecipeInBackground in recipes.local.ts), so those queries land after
 *  seeding returns. Drain them before counting. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
}


const ids = Array.from({ length: 7 }, (_, i) => `aaaaaaaa-bbbb-4ccc-8ddd-00000000000${i}`);

/** Seven recipes edited one day apart (recipe 0 most recently), tagged so
 *  that the "veg" filter keeps the even ones. */
async function seedLibrary() {
  const { query } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');
  for (let i = 0; i < ids.length; i++) {
    await createRecipe({
      id: ids[i],
      title: `Recipe ${String.fromCharCode(71 - i)}`,
      servings: 2,
      tags: i % 2 === 0 ? ['Veg', 'Quick'] : ['Meat'],
      regions: i < 3 ? ['Italy'] : ['France'],
      ingredients: [],
      steps: [],
    } as never, 'Matteo');
  }
  await settle();
  for (let i = 0; i < ids.length; i++) {
    await query('UPDATE recipes SET updated_at = $1 WHERE id = $2', [`2026-11-${String(20 - i).padStart(2, '0')}T10:00:00Z`, ids[i]]);
  }
}

type Page = { data: Array<{ id: string; title: string; tags: string[] }>; total: number; hasMore?: boolean };

async function allPages(params: Record<string, string>, size: number) {
  const { listRecipes } = await import('./recipes.local');
  const seen: string[] = [];
  const flags: boolean[] = [];
  let total = -1;
  for (let offset = 0; offset < 50; offset += size) {
    const page = (await listRecipes({ ...params, limit: String(size), offset: String(offset) })) as unknown as Page;
    total = page.total;
    seen.push(...page.data.map((r) => r.id));
    flags.push(!!page.hasMore);
    if (!page.hasMore) break;
  }
  return { seen, flags, total };
}

describe('standalone listRecipes — paging', () => {
  it('returns the whole list, as before, without a limit', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedLibrary();
    const { listRecipes } = await import('./recipes.local');

    const all = (await listRecipes({ sort: 'recently-edited' })) as unknown as Page;
    expect(all.data.map((r) => r.id)).toEqual(ids);
    expect(all.total).toBe(7);
    // Cards still get their display tags.
    expect(all.data[0].tags).toEqual(['Veg', 'Quick']);
  });

  it('cuts pages that, end to end, are the unpaged list', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedLibrary();
    const { listRecipes } = await import('./recipes.local');

    for (const sort of ['recently-edited', 'alphabetical', 'newest', 'oldest']) {
      const full = ((await listRecipes({ sort })) as unknown as Page).data.map((r) => r.id);
      const { seen, flags, total } = await allPages({ sort }, 3);
      expect(seen).toEqual(full);
      expect(total).toBe(7);
      expect(flags).toEqual([true, true, false]);
    }
  });

  it('applies the JS-side filters before cutting the page', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedLibrary();

    const veg = await allPages({ sort: 'recently-edited', tags: 'veg' }, 2);
    expect(veg.seen).toEqual([ids[0], ids[2], ids[4], ids[6]]);
    expect(veg.total).toBe(4);

    const italianVeg = await allPages({ sort: 'recently-edited', tags: 'veg', regions: 'Italy' }, 1);
    expect(italianVeg.seen).toEqual([ids[0], ids[2]]);
    expect(italianVeg.flags).toEqual([true, false]);
  });

  it('answers a page past the end with nothing more to load', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedLibrary();
    const { listRecipes } = await import('./recipes.local');

    const page = (await listRecipes({ sort: 'recently-edited', limit: '5', offset: '10' })) as unknown as Page;
    expect(page.data).toEqual([]);
    expect(page.total).toBe(7);
    expect(page.hasMore).toBe(false);
  });

  it('reads a page in a fixed handful of queries, however big the library', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedLibrary();
    const { listRecipes } = await import('./recipes.local');

    queryCount = 0;
    await listRecipes({ sort: 'recently-edited', limit: '2', offset: '0' });
    // Ids in order, the page's rows, the page's tags (and their translations
    // when a language is asked for).
    expect(queryCount).toBeLessThanOrEqual(4);
  });
});

describe('local schema — read indexes', () => {
  it('creates the indexes the gallery and recipe page rely on', async () => {
    await (await import('../db/local')).initLocalSchema();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const idx of [
      'idx_recipes_updated_at',
      'idx_recipes_created_at',
      'idx_recipes_cookbook',
      'idx_collection_recipes_recipe',
      'idx_menu_items_recipe',
      'idx_recipe_ingredients_ingredient',
      'idx_cook_log_cooked_at',
      'idx_profiles_name',
      'idx_tags_lower_name',
    ]) expect(names).toContain(idx);
  });

  it('uses the lower(name) index for the tag lookup', async () => {
    await (await import('../db/local')).initLocalSchema();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM tags WHERE deleted_at IS NULL AND lower(name) IN ('veg', 'quick')").all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_tags_lower_name');
  });
});
