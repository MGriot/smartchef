// ════════════════════════════════════════════════════════════════════════
// Match suggestions must follow the app's content language.
//
// Reported symptom: with the app set to Italian, the Import review step
// offered "Butter" as the match for a parsed "burro" and "Lemon" for
// "scorza di lime" — always English, whatever language was selected.
//
// Two distinct bugs sat behind that, and this file pins both:
//
//   1. localMatcher.ts called listIngredients({}) with no `lang`, so every
//      candidate carried its BASE (English) name. That is not only a
//      labelling problem: scoring an Italian name against an English
//      catalog is close to noise — the reported screenshot had "cocco
//      rapè" suggested as "Arborio Rice" at 42%.
//   2. listIngredients()'s `q` filter only ever matched the base name and
//      the JSON synonyms, so the review step's "search existing" box could
//      not find "burro" at all, no matter the language.
//
// Runs against real SQLite via node:sqlite (same mock as
// ingredients.local.list.integration.test.ts) because both fixes are in
// the SQL — a mocked query layer would assert nothing.
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

/** An English-named catalog with Italian translations on file — exactly the
 *  shape a library built from the seeded catalog has. */
async function seedCatalog() {
  const { initLocalSchema, query } = await import('../db/local');
  await initLocalSchema();

  const ingredients: Array<[string, string, string | null, string | null]> = [
    // id, base name, plural, italian translation
    ['ing-butter', 'Butter', null, 'Burro'],
    ['ing-lemon', 'Lemon', 'Lemons', 'Limone'],
    ['ing-lemon-zest', 'Lemon Zest', null, 'Scorza di limone'],
    ['ing-rice', 'Arborio Rice', null, 'Riso Arborio'],
    // Deliberately untranslated: an ingredient that genuinely only has an
    // English name must still be offered, labelled in English.
    ['ing-tahini', 'Tahini', null, null],
  ];

  // ingredients.category_id is NOT NULL, so the catalog needs a category
  // to hang off even though categories are not what is under test here.
  await query(`INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)`, ['cat-1', 'Pantry']);

  for (const [id, name, plural] of ingredients) {
    await query(
      `INSERT INTO ingredients (id, name, plural_name, category_id, sync_status) VALUES ($1, $2, $3, $4, 'synced')`,
      [id, name, plural, 'cat-1']
    );
  }
  for (const [id, , , italian] of ingredients) {
    if (!italian) continue;
    await query(
      `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
       VALUES ($1, $2, $3, $4)`,
      [`tr-${id}`, id, 'it', italian]
    );
  }

  await query(`INSERT INTO tools (id, name) VALUES ($1, $2)`, ['tool-whisk', 'Whisk']);
  await query(
    `INSERT INTO tool_translations (id, tool_id, language_code, name) VALUES ($1, $2, $3, $4)`,
    ['ttr-whisk', 'tool-whisk', 'it', 'Frusta']
  );
}

describe('proposeIngredientMatchesLocal() with a content language', () => {
  it('matches an Italian name and labels the suggestion in Italian', async () => {
    await seedCatalog();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    const out = await proposeIngredientMatchesLocal(['burro'], 'it');
    const top = out['burro'][0];

    expect(top.id).toBe('ing-butter');
    expect(top.name).toBe('Burro');
    // A near-exact hit on the translation, not the ~40% noise an
    // English-only catalog produced.
    expect(top.score).toBeGreaterThan(0.9);
  });

  it('labels even a weak suggestion in the app language, and keeps it weak', async () => {
    await seedCatalog();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    // The reported screenshot showed "cocco rapè" suggested as "Arborio
    // Rice" at 42%. There is no coconut in this catalog, so no suggestion
    // is really right — and to be clear about what this fix does and does
    // not do: the spurious match SURVIVES, because topMatches() keeps
    // anything above 0.4 and two unrelated Italian words still share
    // enough letters to clear that. What changes is that it is no longer
    // labelled in the wrong language, and it stays far below the score a
    // real hit gets (see the 'burro' case above, >0.9), so the review step
    // presents it as the guess it is next to "create new".
    //
    // Raising that 0.4 floor is a separate judgement call about the matcher
    // itself, deliberately not made here.
    const out = await proposeIngredientMatchesLocal(['cocco rapè'], 'it');

    expect(out['cocco rapè'].map((s) => s.name)).not.toContain('Arborio Rice');
    for (const s of out['cocco rapè']) {
      expect(s.score).toBeLessThan(0.6);
    }
  });

  it('still matches an English name while the app is in Italian', async () => {
    await seedCatalog();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    // The parsed recipe's language and the UI language are independent —
    // importing an English reel with the app in Italian must still match.
    // The base name stays in the running as a second probe for exactly this.
    const out = await proposeIngredientMatchesLocal(['butter'], 'it');

    expect(out['butter'][0].id).toBe('ing-butter');
    // Labelled in the app's language even though the query was English.
    expect(out['butter'][0].name).toBe('Burro');
  });

  it('falls back to the base name for an ingredient with no translation', async () => {
    await seedCatalog();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    const out = await proposeIngredientMatchesLocal(['tahini'], 'it');

    expect(out['tahini'][0].id).toBe('ing-tahini');
    expect(out['tahini'][0].name).toBe('Tahini');
  });

  it('keeps the previous English behaviour when no language is given', async () => {
    await seedCatalog();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    // bulkImport.ts calls it this way; it must not change.
    const out = await proposeIngredientMatchesLocal(['butter']);

    expect(out['butter'][0].name).toBe('Butter');
  });

  it('localizes tool suggestions the same way', async () => {
    await seedCatalog();
    const { proposeToolMatchesLocal } = await import('./localMatcher');

    const out = await proposeToolMatchesLocal(['frusta'], 'it');

    expect(out['frusta'][0].id).toBe('tool-whisk');
    expect(out['frusta'][0].name).toBe('Frusta');
  });
});

describe('catalog search follows the content language', () => {
  it('finds an ingredient by its translated name', async () => {
    await seedCatalog();
    const { listIngredients } = await import('./ingredients.local');

    // The review step's "search existing" box. Before the fix `q` only hit
    // the base name, so this returned nothing.
    const found = await listIngredients({ q: 'burro', lang: 'it' });

    expect(found.map((i: any) => i.id)).toContain('ing-butter');
    expect(found.find((i: any) => i.id === 'ing-butter')!.translated_name).toBe('Burro');
  });

  it('still finds it by its English name', async () => {
    await seedCatalog();
    const { listIngredients } = await import('./ingredients.local');

    const found = await listIngredients({ q: 'butter', lang: 'it' });
    expect(found.map((i: any) => i.id)).toContain('ing-butter');
  });

  it('does not leak rows whose translation is in another language', async () => {
    await seedCatalog();
    const { query } = await import('../db/local');
    await query(
      `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
       VALUES ($1, $2, $3, $4)`,
      ['tr-fr-tahini', 'ing-tahini', 'fr', 'Purée de sésame']
    );

    const { listIngredients } = await import('./ingredients.local');

    // Searching the French name with the app in Italian must not match.
    const found = await listIngredients({ q: 'sésame', lang: 'it' });
    expect(found.map((i: any) => i.id)).not.toContain('ing-tahini');

    const inFrench = await listIngredients({ q: 'sésame', lang: 'fr' });
    expect(inFrench.map((i: any) => i.id)).toContain('ing-tahini');
  });

  it('finds a tool and a technique by translated name too', async () => {
    await seedCatalog();
    const { listTools } = await import('./ingredients.local');
    const { query } = await import('../db/local');

    expect((await listTools({ q: 'frusta', lang: 'it' })).map((t: any) => t.id)).toContain('tool-whisk');

    await query(`INSERT INTO techniques (id, name) VALUES ($1, $2)`, ['tec-braise', 'Braising']);
    await query(
      `INSERT INTO technique_translations (id, technique_id, language_code, name) VALUES ($1, $2, $3, $4)`,
      ['tectr-1', 'tec-braise', 'it', 'Brasare']
    );

    const { listTechniques } = await import('./techniques.local');
    expect((await listTechniques({ q: 'brasare', lang: 'it' })).map((t: any) => t.id)).toContain('tec-braise');
  });
});
