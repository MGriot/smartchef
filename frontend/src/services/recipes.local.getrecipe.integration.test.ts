// ════════════════════════════════════════════════════════════════════════
// Standalone-mode getRecipe(): the recipe page's one big read.
//
// It used to resolve translations row by row — three queries per
// ingredient, two per step, one per tool, two per technique — so opening a
// 15-ingredient recipe cost around seventy sequential reads, every one of
// them a Capacitor bridge round-trip on Android. That is the N+1 shape
// docs/plans/2026-08-22-android-performance-plan.md exists to stamp out,
// and listIngredients() had already been rewritten for it.
//
// So this file asserts both halves: that the batched lookups return exactly
// what the per-row ones did (translations for the requested language, the
// full per-language arrays the editor round-trips, and technique chips in
// the order the steps mention them), and that the number of reads no longer
// grows with the size of the recipe.
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

const RECIPE_ID = '11111111-2222-4333-8444-555555555555';

/** A recipe with `size` ingredients and `size` steps, each carrying an
 *  Italian translation, plus a tool and two techniques. */
async function seed(size: number) {
  const { query, queryOne } = await import('../db/local');
  const { createRecipe } = await import('./recipes.local');

  const gram = await queryOne<{ id: string }>("SELECT id FROM units WHERE symbol='g'");
  const unitId = gram!.id;

  await query('INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ($1,$2,$3,$4,$5)',
    ['cat-veg', 'Vegetables', 0, '#4a7', 'TbCarrot']);
  await query("INSERT INTO tools (id, name, icon) VALUES ('tool-pan', 'Pan', 'TbTool')");
  await query("INSERT INTO tool_translations (id, tool_id, language_code, name) VALUES ('tt-1','tool-pan','it','Padella')");
  await query("INSERT INTO techniques (id, name, icon) VALUES ('tec-saute', 'Sautéing', 'TbFlame')");
  await query("INSERT INTO techniques (id, name, icon) VALUES ('tec-boil', 'Boiling', 'TbDroplet')");
  await query("INSERT INTO technique_translations (id, technique_id, language_code, name) VALUES ('tct-1','tec-saute','it','Soffritto')");

  for (let i = 0; i < size; i++) {
    await query(
      `INSERT INTO ingredients (id, category_id, name, image_urls, sync_status)
       VALUES ($1, 'cat-veg', $2, '[]', 'local')`,
      [`ing-${i}`, `Ingredient ${i}`],
    );
    await query(
      `INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name)
       VALUES ($1, $2, 'it', $3)`,
      [`it-${i}`, `ing-${i}`, `Ingrediente ${i}`],
    );
  }

  await createRecipe({
    id: RECIPE_ID,
    title: 'Test recipe',
    servings: 4,
    toolIds: ['tool-pan'],
    ingredients: Array.from({ length: size }, (_, i) => ({
      sortOrder: i,
      ingredientId: `ing-${i}`,
      quantity: 10 + i,
      unitId,
      notes: `note ${i}`,
      translations: [{ lang: 'it', notes: `nota ${i}` }],
    })),
    steps: Array.from({ length: size }, (_, i) => ({
      stepNumber: i + 1,
      description: `Step ${i}`,
      toolIds: ['tool-pan'],
      // Boiling is mentioned first, on the last step, so a set built from
      // step order and a set built from the techniques table's own order
      // are distinguishable.
      techniqueIds: i === size - 1 ? ['tec-boil', 'tec-saute'] : [],
      translations: [{ lang: 'it', description: `Passo ${i}` }],
    })),
    translations: [{ lang: 'it', title: 'Ricetta di prova' }],
  } as never, 'Matteo');
}

describe('standalone getRecipe', () => {
  it('returns the requested language for ingredients, steps and tools', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed(3);
    const { getRecipe } = await import('./recipes.local');

    const recipe = (await getRecipe(RECIPE_ID, 'it')) as never as {
      translated_title: string;
      ingredients: Array<{ ingredientName: string; translatedNotes: string | null; translations: Array<{ lang: string; notes: string | null }> }>;
      steps: Array<{ translatedDescription: string | null; translations: Array<{ lang: string }> }>;
      tools: Array<{ name: string; translated_name: string | null }>;
      techniques: Array<{ name: string; translated_name: string | null }>;
    };

    expect(recipe.translated_title).toBe('Ricetta di prova');
    expect(recipe.ingredients.map((i) => i.ingredientName)).toEqual(['Ingrediente 0', 'Ingrediente 1', 'Ingrediente 2']);
    expect(recipe.ingredients.map((i) => i.translatedNotes)).toEqual(['nota 0', 'nota 1', 'nota 2']);
    expect(recipe.steps.map((s) => s.translatedDescription)).toEqual(['Passo 0', 'Passo 1', 'Passo 2']);
    expect(recipe.tools).toEqual([{ id: 'tool-pan', name: 'Pan', icon: 'TbTool', translated_name: 'Padella' }]);

    // Order follows the steps, and an untranslated technique keeps a null
    // rather than being dropped.
    expect(recipe.techniques.map((t) => [t.name, t.translated_name])).toEqual([
      ['Boiling', null],
      ['Sautéing', 'Soffritto'],
    ]);

    // The editor round-trips every language, not just the active one.
    expect(recipe.ingredients[0].translations).toEqual([{ lang: 'it', notes: 'nota 0' }]);
    expect(recipe.steps[0].translations).toHaveLength(1);
  });

  it('falls back to the base names when no language is requested', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed(2);
    const { getRecipe } = await import('./recipes.local');

    const recipe = (await getRecipe(RECIPE_ID)) as never as {
      ingredients: Array<{ ingredientName: string; translatedNotes: string | null }>;
      tools: Array<{ translated_name: string | null }>;
      techniques: Array<{ translated_name: string | null }>;
    };

    expect(recipe.ingredients.map((i) => i.ingredientName)).toEqual(['Ingredient 0', 'Ingredient 1']);
    expect(recipe.ingredients.every((i) => i.translatedNotes === null)).toBe(true);
    expect(recipe.tools[0].translated_name).toBeNull();
    expect(recipe.techniques.every((t) => t.translated_name === null)).toBe(true);
  });

  it('does not issue more queries as the recipe grows', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seed(3);
    const { getRecipe } = await import('./recipes.local');
    await settle();

    queryCount = 0;
    await getRecipe(RECIPE_ID, 'it');
    const small = queryCount;

    // Same recipe, twenty ingredients and twenty steps instead of three.
    db = new DatabaseSync(':memory:');
    vi.resetModules();
    await (await import('../db/local')).initLocalSchema();
    await seed(20);
    const big = await import('./recipes.local');
    await settle();

    queryCount = 0;
    await big.getRecipe(RECIPE_ID, 'it');
    const large = queryCount;

    // Eleven reads either way. Before batching, twenty ingredients and
    // twenty steps came to well over a hundred.
    expect(large).toBe(small);
    expect(small).toBeLessThanOrEqual(12);
  });
});
