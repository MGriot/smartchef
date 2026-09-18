// ════════════════════════════════════════════════════════════════════════
// The claim this whole feature rests on, end to end against real SQLite:
// a name the model copied out of the catalog comes back through the Review
// Matches step already resolved to the row it came from.
//
// Each piece of that is tested on its own elsewhere. This is the seam —
// the catalog renders a name, the model echoes it, the matcher scores it,
// mergeSuggestions ranks it, defaultResolution pre-selects it. Any one of
// those five quietly changing its idea of what a "name" is would leave
// every unit test passing and the feature doing nothing at all.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mergeSuggestions, defaultResolution } from '../lib/importMatching';

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

async function seedLibrary() {
  const { initLocalSchema, query } = await import('../db/local');
  await initLocalSchema();

  await query(`INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)`, ['cat-1', 'Pantry']);
  await query(
    `INSERT INTO ingredients (id, name, category_id, sync_status) VALUES ($1, $2, $3, 'synced')`,
    ['ing-butter', 'Butter', 'cat-1']
  );
  await query(
    `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
     VALUES ($1, $2, $3, $4)`,
    ['itr-butter', 'ing-butter', 'it', 'Burro']
  );
  // Deliberately close to nothing in the recipe's wording: "planetaria" and
  // "Stand Mixer" share almost no letters, which is the case fuzzy matching
  // cannot solve and catalog grounding can.
  await query(`INSERT INTO tools (id, name) VALUES ($1, $2)`, ['tool-mixer', 'Stand Mixer']);
}

/** What the prompt actually shows the model for each catalog row. */
async function renderedCatalog(lang: string) {
  const { loadImportCatalog } = await import('./importCatalog.local');
  const { catalogSection } = await import('./llmParser.local');
  return { catalog: await loadImportCatalog(lang), section: catalogSection(await loadImportCatalog(lang), 'openai') };
}

describe('a catalog name echoed by the model resolves to the row it came from', () => {
  it('shows the base name outside the parentheses, which is the half to echo', async () => {
    await seedLibrary();
    const { section } = await renderedCatalog('it');

    expect(section).toContain('Butter (Burro)');
    expect(section).toContain('Stand Mixer');
  });

  it('scores the echoed base name at 1.0 and labels it in the app language', async () => {
    await seedLibrary();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    // "Butter" is what the model copied out of the catalog.
    const out = await proposeIngredientMatchesLocal(['Butter'], 'it');
    expect(out['Butter'][0]).toMatchObject({ id: 'ing-butter', name: 'Burro', score: 1 });
  });

  // The end of the chain: a claim about an ingredient the recipe words
  // differently ends up pre-selected, badged, without the user clicking.
  it('pre-selects the claimed row for an ingredient the recipe words differently', async () => {
    await seedLibrary();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    const recipeWording = 'burro morbido a temperatura ambiente';
    const claim = 'Butter';
    const scored = await proposeIngredientMatchesLocal([recipeWording, claim], 'it');

    const merged = mergeSuggestions(scored[recipeWording] ?? [], scored[claim] ?? []);
    const resolution = defaultResolution(merged);

    expect(resolution).toEqual({ choice: 'existing', id: 'ing-butter', name: 'Burro' });
    expect(merged[0].score).toBe(1);
  });

  // The case that has no fuzzy answer at all: the review step would
  // otherwise default to creating a duplicate "Planetaria" tool.
  it('resolves a tool whose recipe wording shares nothing with the library name', async () => {
    await seedLibrary();
    const { proposeToolMatchesLocal } = await import('./localMatcher');

    const byWording = await proposeToolMatchesLocal(['planetaria'], 'it');
    expect(defaultResolution(byWording['planetaria'] ?? [])).toEqual({ choice: 'new' });

    // With the catalog in the prompt the model writes the catalog name
    // straight into `tools`, and the same matcher then finds it outright.
    const byCatalogName = await proposeToolMatchesLocal(['Stand Mixer'], 'it');
    expect(defaultResolution(byCatalogName['Stand Mixer'] ?? [])).toEqual({
      choice: 'existing',
      id: 'tool-mixer',
      name: 'Stand Mixer',
    });
  });

  // Grounding must not turn "create new" into a thing that never happens.
  it('still defaults to creating a genuinely unknown ingredient', async () => {
    await seedLibrary();
    const { proposeIngredientMatchesLocal } = await import('./localMatcher');

    const out = await proposeIngredientMatchesLocal(['guanciale'], 'it');
    expect(defaultResolution(mergeSuggestions(out['guanciale'] ?? [], []))).toEqual({ choice: 'new' });
  });
});
