// ════════════════════════════════════════════════════════════════════════
// The four catalog list functions that survived the first N+1 sweep:
// listTags(), listTechniques(), listCategories() and listUnits(). Each one
// resolved translations with one query per row, and each sits on a hot path
// — the gallery fetches tags and categories on mount, RecipeDetail fetches
// techniques on every recipe open in every mode, and units are read by the
// editor, Pantry and the shopping list.
//
// In standalone mode every one of those queries is a Capacitor bridge
// round-trip (JSON-stringified in Java, re-parsed in the WebView), and
// db/local.ts serializes them all through one queue — so the cost is
// strictly additive and lands in front of whatever the user was waiting for.
//
// So this file asserts both halves, the same way
// recipes.local.getrecipe.integration.test.ts does for the recipe page: that
// the batched lookups return exactly what the per-row ones did, and that the
// number of reads no longer grows with the size of the catalog.
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
          return { values: db.prepare(sql).all(...(params as never[])) };
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

const LANGS = ['it', 'fr', 'es'];

/** These list functions spread the raw DB row into their result, so the
 *  table's own columns are present at runtime but not in the inferred type.
 *  Reaching for one in a test goes through here rather than casting inline. */
function field(row: object, name: string): unknown {
  return (row as Record<string, unknown>)[name];
}

async function seedTags(count: number) {
  const { query } = await import('../db/local');
  for (let i = 0; i < count; i++) {
    await query(
      `INSERT INTO tags (id, name, group_name, color, sort_order) VALUES ($1,$2,'cuisine','#123456',$3)`,
      [`tag-${i}`, `Tag ${i}`, i]
    );
    for (const lang of LANGS) {
      await query(
        `INSERT INTO tag_translations (id, tag_id, language_code, name) VALUES ($1,$2,$3,$4)`,
        [`tagtr-${i}-${lang}`, `tag-${i}`, lang, `Tag ${i} (${lang})`]
      );
    }
  }
}

async function seedTechniques(count: number) {
  const { query } = await import('../db/local');
  for (let i = 0; i < count; i++) {
    await query(`INSERT INTO techniques (id, name, icon) VALUES ($1,$2,'TbFlame')`, [`tec-${i}`, `Technique ${i}`]);
    for (const lang of LANGS) {
      await query(
        `INSERT INTO technique_translations (id, technique_id, language_code, name, description) VALUES ($1,$2,$3,$4,$5)`,
        [`tectr-${i}-${lang}`, `tec-${i}`, lang, `Technique ${i} (${lang})`, `desc ${lang}`]
      );
    }
  }
}

async function seedCategories(count: number) {
  const { query } = await import('../db/local');
  for (let i = 0; i < count; i++) {
    await query(
      `INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,'#abc','TbCarrot')`,
      [`cat-${i}`, `Category ${i}`, i]
    );
    for (const lang of LANGS) {
      await query(
        `INSERT INTO ingredient_category_translations (id, category_id, language_code, name, description) VALUES ($1,$2,$3,$4,$5)`,
        [`cattr-${i}-${lang}`, `cat-${i}`, lang, `Category ${i} (${lang})`, `desc ${lang}`]
      );
    }
  }
}

async function seedUnitTranslations() {
  const { query } = await import('../db/local');
  const units = await query<{ id: string; symbol: string }>('SELECT id, symbol FROM units');
  for (const u of units) {
    for (const lang of LANGS) {
      await query(
        `INSERT INTO unit_translations (id, unit_id, language_code, name) VALUES ($1,$2,$3,$4)`,
        [`untr-${u.id}-${lang}`, u.id, lang, `${u.symbol} (${lang})`]
      );
    }
  }
  return units.length;
}

describe('listTags', () => {
  it('returns the requested language plus the full per-language array', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTags(3);

    const { listTags } = await import('./tags.local');
    const tags = await listTags({ lang: 'fr' });

    expect(tags).toHaveLength(3);
    expect(field(tags[0], 'name')).toBe('Tag 0');
    expect(tags[0].translated_name).toBe('Tag 0 (fr)');
    // The editor round-trips every language, so all three must survive.
    expect(tags[0].translations).toEqual([
      { lang: 'it', name: 'Tag 0 (it)' },
      { lang: 'fr', name: 'Tag 0 (fr)' },
      { lang: 'es', name: 'Tag 0 (es)' },
    ]);
  });

  it('leaves translated_name null when no language was asked for', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTags(2);

    const { listTags } = await import('./tags.local');
    const tags = await listTags({});

    expect(tags[0].translated_name).toBeNull();
    expect(tags[0].translations).toHaveLength(3);
  });

  it('still parses the JSON-encoded array columns', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    await query(
      `INSERT INTO tags (id, name, group_name, exclude_tag_ids, synonyms) VALUES ('t1','Vegan','diet',$1,$2)`,
      [JSON.stringify(['t2']), JSON.stringify(['plant-based'])]
    );

    const { listTags } = await import('./tags.local');
    const [tag] = await listTags({ lang: 'it' });

    expect(tag.exclude_tag_ids).toEqual(['t2']);
    expect(tag.synonyms).toEqual(['plant-based']);
  });

  it('does not issue more queries for a bigger catalog', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTags(40);
    const { listTags } = await import('./tags.local');

    queryCount = 0;
    await listTags({ lang: 'it' });
    const forForty = queryCount;

    // One read for the tags, one for every tag's translations.
    expect(forForty).toBe(2);
  });
});

describe('listTechniques', () => {
  it('returns the requested language plus every language', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTechniques(3);

    const { listTechniques } = await import('./techniques.local');
    const techniques = await listTechniques({ lang: 'es' });

    expect(techniques).toHaveLength(3);
    expect(techniques[0].translated_name).toBe('Technique 0 (es)');
    expect(techniques[0].translations).toHaveLength(3);
    expect(techniques[0].image_urls).toEqual([]);
  });

  it('keeps the search filter working alongside the batched translations', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTechniques(5);

    const { listTechniques } = await import('./techniques.local');
    const found = await listTechniques({ lang: 'it', q: 'Technique 3' });

    expect(found).toHaveLength(1);
    expect(found[0].translated_name).toBe('Technique 3 (it)');
  });

  it('costs a fixed number of queries regardless of catalog size', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedTechniques(30);
    const { listTechniques } = await import('./techniques.local');

    queryCount = 0;
    await listTechniques({ lang: 'it' });

    expect(queryCount).toBe(2);
  });
});

describe('listCategories', () => {
  it('returns translations for the requested language', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedCategories(3);

    const { listCategories } = await import('./ingredients.local');
    const cats = await listCategories({ lang: 'fr' });

    // initLocalSchema() seeds its own starter categories too — find ours.
    const mine = cats.filter(c => String(field(c, 'name')).startsWith('Category '));
    expect(mine).toHaveLength(3);
    expect(mine[0].translated_name).toBe('Category 0 (fr)');
    expect(mine[0].translations).toHaveLength(3);
  });

  it('costs a fixed number of queries regardless of catalog size', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedCategories(25);
    const { listCategories } = await import('./ingredients.local');

    queryCount = 0;
    await listCategories({ lang: 'it' });

    expect(queryCount).toBe(2);
  });
});

describe('listUnits', () => {
  it('returns translations for the requested language', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    await seedUnitTranslations();

    const { listUnits } = await import('./ingredients.local');
    const units = await listUnits({ lang: 'it' });

    expect(units.length).toBeGreaterThan(0);
    expect(units[0].translated_name).toBe(`${field(units[0], 'symbol')} (it)`);
    expect(units[0].translations).toHaveLength(3);
  });

  it('costs a fixed number of queries regardless of how many units exist', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const unitCount = await seedUnitTranslations();
    expect(unitCount).toBeGreaterThan(1); // otherwise the assertion below proves nothing
    const { listUnits } = await import('./ingredients.local');

    queryCount = 0;
    await listUnits({ lang: 'it' });

    expect(queryCount).toBe(2);
  });
});
