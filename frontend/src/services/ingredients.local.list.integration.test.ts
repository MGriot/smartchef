// ════════════════════════════════════════════════════════════════════════
// Real-SQLite reproduction of "a whole ingredient category shows (0) in
// Library > Ingredients even though the ingredients exist".
//
// Root cause was a shared `LIMIT 200` in listIngredients() (and in its
// server twin, backend/src/routes/ingredients.ts) combined with
// `ORDER BY category name, ingredient name`: past 200 rows the
// last-sorting category is the one that falls off the end, so it renders
// as an empty section — and moving an ingredient INTO that category makes
// it vanish from the page. Same truncation silently reached
// localMatcher.ts, so AI import couldn't match those rows and created
// duplicate ingredients instead.
//
// Uses the same node:sqlite mock as
// ingredients.local.sync.integration.test.ts — real SQLite running the
// exact SCHEMA_SQL and listIngredients() the app ships, which is the only
// way to catch an off-by-LIMIT in the actual SQL.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

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
          const stmt = db.prepare(sql);
          return { values: stmt.all(...(params as never[])) };
        },
        run: async (sql: string, params: unknown[] = []) => {
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
  vi.resetModules();
});

/** Mirrors the reported library: many categories, and one that sorts LAST
 *  by name whose members therefore land at the very end of
 *  `ORDER BY category name, ingredient name`. */
async function seedLibrary(perCategory: number) {
  const { query } = await import('../db/local');

  // Deliberately more than one category so the ordering (and therefore
  // which rows a LIMIT would drop) is category-driven, as in production.
  const categories = [
    { id: 'cat-fruit', name: 'Fruit' },
    { id: 'cat-dairy', name: 'Dairy & Eggs' },
    { id: 'cat-grain', name: 'Grains & Flour' },
    { id: 'cat-meat', name: 'Meat' },
    { id: 'cat-veg', name: 'Vegetables & Produce' }, // sorts last
  ];
  for (const c of categories) {
    await query('INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)', [c.id, c.name]);
  }

  for (const c of categories) {
    for (let i = 0; i < perCategory; i++) {
      // Zero-padded so name ordering inside a category is stable.
      const n = String(i).padStart(3, '0');
      await query(
        `INSERT INTO ingredients (id, category_id, name, sync_status) VALUES ($1, $2, $3, 'local')`,
        [`${c.id}-${n}`, c.id, `${c.name} item ${n}`]
      );
    }
  }
  return { categories, total: categories.length * perCategory };
}

describe('listIngredients() returns the whole library, not a capped page', () => {
  it('returns every ingredient when the library is well past the old 200-row cap', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();

    // 5 x 50 = 250 — comfortably past the old LIMIT 200.
    const { total } = await seedLibrary(50);

    const { listIngredients } = await import('./ingredients.local');
    const list = await listIngredients({});

    expect(list).toHaveLength(total);
  });

  it('does not drop the last-sorting category — the exact reported symptom', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedLibrary(50);

    const { listIngredients } = await import('./ingredients.local');
    const list = await listIngredients({});

    // "Vegetables & Produce (0)" while its ingredients demonstrably exist
    // was what the user actually saw. Every member must come back.
    const veg = list.filter((i: any) => i.category_id === 'cat-veg');
    expect(veg).toHaveLength(50);
  });

  it('still finds an ingredient that was just moved into the last-sorting category', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    await seedLibrary(50);

    // Named so it sorts last WITHIN the last-sorting category too — i.e.
    // dead last overall. A moved row that happens to sort early in its new
    // category can survive a 200-row cap by luck, which is precisely why
    // the bug looked intermittent from the outside.
    await query(
      `INSERT INTO ingredients (id, category_id, name, sync_status) VALUES ($1, $2, $3, 'local')`,
      ['ing-zucchini', 'cat-fruit', 'Zucchini']
    );

    // The reported reproduction: edit an existing ingredient's category to
    // the one that sorts last, then reload the library page.
    await query('UPDATE ingredients SET category_id=$1 WHERE id=$2', ['cat-veg', 'ing-zucchini']);

    const { listIngredients } = await import('./ingredients.local');
    const list = await listIngredients({});

    const moved = list.find((i: any) => i.id === 'ing-zucchini');
    expect(moved).toBeDefined();
    expect((moved as { category_id: string } | undefined)?.category_id).toBe('cat-veg');
  });

  it('still caps the ?q= search path, which wants a pick-list not the library', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedLibrary(50); // every name contains "item"

    const { listIngredients } = await import('./ingredients.local');
    const searched = await listIngredients({ q: 'item' });

    expect(searched).toHaveLength(200);
  });
});

describe('listIngredients() resolves translations and tags for the whole set', () => {
  it('attaches per-row translations, category translations and tags after the batching rewrite', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    await seedLibrary(50);

    await query(
      `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
       VALUES ($1, $2, $3, $4)`,
      ['tr-1', 'cat-veg-049', 'it', 'Zucchina']
    );
    await query(
      `INSERT INTO ingredient_category_translations (id, category_id, language_code, name)
       VALUES ($1, $2, $3, $4)`,
      ['ctr-1', 'cat-veg', 'it', 'Verdure & Ortaggi']
    );
    await query('INSERT INTO tags (id, name, color) VALUES ($1, $2, $3)', ['tag-1', 'vegan', '#0f0']);
    await query('INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ($1, $2)', ['cat-veg-049', 'tag-1']);
    await query(
      'INSERT INTO tag_translations (id, tag_id, language_code, name) VALUES ($1, $2, $3, $4)',
      ['ttr-1', 'tag-1', 'it', 'vegano']
    );

    const { listIngredients } = await import('./ingredients.local');
    const list = await listIngredients({ lang: 'it' });

    // The row is past the old cap — it only has translations/tags to assert
    // because it comes back at all now.
    const row = list.find((i: any) => i.id === 'cat-veg-049') as any;
    expect(row).toBeDefined();
    expect(row.translated_name).toBe('Zucchina');
    expect(row.translated_category_name).toBe('Verdure & Ortaggi');
    expect(row.translations).toEqual([{ lang: 'it', text: 'Zucchina' }]);
    expect(row.tags).toEqual([
      { id: 'tag-1', name: 'vegan', translated_name: 'vegano', color: '#0f0', icon: null },
    ]);

    // An untagged, untranslated row still gets the documented empty shapes
    // rather than undefined, and falls back to the untranslated category.
    const plain = list.find((i: any) => i.id === 'cat-fruit-000') as any;
    expect(plain.tags).toEqual([]);
    expect(plain.translations).toEqual([]);
    expect(plain.translated_name).toBeNull();
    expect(plain.translated_category_name).toBe('Fruit');
  });
});
