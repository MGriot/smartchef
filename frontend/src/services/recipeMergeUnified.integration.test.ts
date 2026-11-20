// ════════════════════════════════════════════════════════════════════════
// "Merge with AI", end to end against real SQLite (node:sqlite): the model
// is the only thing faked. Two saved versions of one dish, each citing a
// page; the model's unified recipe is saved over the kept one, the copy is
// folded in, and every reference of both survives.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
const asked: Array<{ turns: Array<{ role: string; content: string }>; system: string }> = [];
let replies: unknown[] = [];

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string) => { db.exec(sql); },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => { throw new Error('not expected in this test'); },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

// The pages the two versions cite.
vi.mock('./pageFetcher', async (original) => ({
  ...(await original<typeof import('./pageFetcher')>()),
  fetchPageHtml: async (url: string) => {
    if (url.includes('b.fr')) throw new Error('HTTP 403');
    return `<html><head><title>Zuppa di cipolle</title></head><body><p>${'Zuppa di cipolle per 4 persone. Stufate le cipolle nel burro per 40 minuti, poi gratinate. '.repeat(3)}</p></body></html>`;
  },
}));

vi.mock('./llmParser.local', async (original) => ({
  ...(await original<typeof import('./llmParser.local')>()),
  callConfiguredProviderChat: async (turns: Array<{ role: string; content: string }>, system: string) => {
    asked.push({ turns, system });
    return JSON.stringify(replies.shift());
  },
}));

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  asked.length = 0;
  replies = [];
  vi.resetModules();
});

const KEEP = '11111111-1111-4111-8111-111111111111';
const DUP = '22222222-2222-4222-8222-222222222222';

async function seed() {
  const { query, initLocalSchema } = await import('../db/local');
  await initLocalSchema();
  await query(`INSERT INTO ingredient_categories (id, name, sort_order, color, icon) VALUES ('cat', 'Cat', 0, '#000', 'x')`);
  for (const [id, name] of [['i-cipolle', 'Cipolle'], ['i-burro', 'Burro'], ['i-emmentaler', 'Emmentaler'], ['i-vino', 'Vino bianco']]) {
    await query(`INSERT INTO ingredients (id, category_id, name, image_urls, sync_status) VALUES ($1, 'cat', $2, '[]', 'local')`, [id, name]);
  }
  await query(
    `INSERT INTO recipes (id, title, servings, difficulty, tags, source_url, sources, times_cooked, updated_at) VALUES
       ($1, 'Zuppa di cipolle', 4, 'easy', '["Zuppa"]', 'https://a.it/zuppa', $3, 2, '2026-01-01 00:00:00'),
       ($2, 'Soupe à l''oignon', 4, 'medium', '["Francia"]', 'https://b.fr/soupe', $4, 3, '2026-02-01 00:00:00')`,
    [KEEP, DUP,
      JSON.stringify([{ type: 'url', label: 'Ricetta originale', url: 'https://a.it/zuppa' }]),
      JSON.stringify([{ type: 'book', label: 'Larousse' }])],
  );
  await query(`INSERT INTO recipe_ingredients (id, recipe_id, sort_order, ingredient_id, quantity) VALUES
    ('k0', $1, 0, 'i-cipolle', 1000), ('k1', $1, 1, 'i-emmentaler', 150),
    ('d0', $2, 0, 'i-cipolle', 800), ('d1', $2, 1, 'i-burro', 50)`, [KEEP, DUP]);
  await query(
    `INSERT INTO recipe_steps (id, recipe_id, step_number, description, duration_min, step_ingredients) VALUES
       ('ks1', $1, 1, 'Affettate {{ing:0}}.', NULL, '[]'),
       ('ds1', $2, 1, 'Stufate le cipolle nel burro.', 40, '[]')`,
    [KEEP, DUP],
  );
  await query(`INSERT INTO collections (id, name) VALUES ('col', 'Inverno')`).catch(() => {});
  await query(`INSERT INTO collection_recipes (collection_id, recipe_id) VALUES ('col', $1)`, [DUP]).catch(() => {});
  return query;
}

const firstAnswer = {
  reply: 'Ho unito le due versioni.',
  reasoning: ['La copia aggiunge il burro e la durata della stufatura.'],
  recipe: {
    title: 'Zuppa di cipolle gratinata',
    description: 'Con Emmentaler.',
    servings: 4,
    difficulty: 'medium',
    ingredients: [
      { from: '0.0', name: 'Cipolle', quantity: 1000 },
      { from: '1.1', name: 'Burro', quantity: 50 },
      { from: '0.1', name: 'Emmentaler', quantity: 150 },
    ],
    steps: [
      { text: 'Affettate le cipolle.', from: ['0.0'] },
      { text: 'Stufate le cipolle nel burro.', durationMin: 40, timeKind: 'cook', from: ['1.0'] },
    ],
  },
  doubts: [{ question: 'Aggiungo il vino bianco citato dalla pagina?', options: ['Sì', 'No'] }],
  warnings: [],
};

describe('Merge with AI', () => {
  it('reads the reference pages, proposes one recipe and reports what it read', async () => {
    await seed();
    replies = [firstAnswer];
    const { startUnifiedMerge } = await import('./recipeMergeUnified.local');
    const view = await startUnifiedMerge(KEEP, [DUP], 'it');

    const context = JSON.parse(asked[0].turns[0].content);
    expect(context.recipes.map((r: { kept: boolean; title: string }) => [r.kept, r.title])).toEqual([[true, 'Zuppa di cipolle'], [false, 'Soupe à l\'oignon']]);
    // The kept recipe's step is sent as the words it reads as.
    expect(context.recipes[0].steps[0].text).toBe('Affettate Cipolle.');
    expect(context.sourcePages.map((p: { url: string }) => p.url)).toEqual(['https://a.it/zuppa']);
    expect(context.sourcePages[0].text).toContain('40 minuti');

    expect(view.sourcesRead).toEqual([
      { url: 'https://a.it/zuppa', ok: true, title: 'Zuppa di cipolle' },
      { url: 'https://b.fr/soupe', ok: false, error: 'HTTP 403' },
    ]);
    expect(view.recipes.map((r) => r.letter)).toEqual(['A', 'B']);
    expect(view.draft.title).toBe('Zuppa di cipolle gratinata');
    expect(view.draft.cookTimeMin).toBe(40);
    expect(view.doubts).toHaveLength(1);
    expect(view.messages).toEqual([{ role: 'assistant', text: 'Ho unito le due versioni.' }]);
  });

  it('refines the draft in the chat and leaves it alone on a plain answer', async () => {
    await seed();
    replies = [
      firstAnswer,
      {
        reply: 'Aggiunto il vino bianco.',
        reasoning: [],
        recipe: { ...firstAnswer.recipe, ingredients: [...firstAnswer.recipe.ingredients, { from: null, name: 'Vino bianco', quantity: 100, unit: 'ml' }, { from: null, name: 'Cognac' }] },
        doubts: [],
        warnings: [],
      },
      { reply: 'La pagina parla di 40 minuti.', reasoning: [], recipe: null, doubts: [], warnings: [] },
    ];
    const { startUnifiedMerge, continueUnifiedMerge } = await import('./recipeMergeUnified.local');
    const opened = await startUnifiedMerge(KEEP, [DUP], 'it');

    const second = await continueUnifiedMerge(opened.sessionId, 'Sì');
    expect(second.draft.ingredients.map((i) => i.label)).toEqual(['Cipolle', 'Burro', 'Emmentaler', 'Vino bianco', 'Cognac']);
    expect(second.doubts).toEqual([]);
    // Only what the library has can be saved as a row.
    expect(second.notInLibrary).toEqual(['Cognac']);
    expect(asked[1].turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(asked[1].turns[2].content).toBe('Sì');

    const third = await continueUnifiedMerge(opened.sessionId, 'Quanto dura la stufatura secondo la pagina?');
    expect(third.draft.ingredients).toHaveLength(5);
    expect(third.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    // The reasoning of the opening stays when a later turn gives none.
    expect(third.reasoning).toEqual(firstAnswer.reasoning);
  });

  it('saves the unified recipe over the kept one and folds the copy in', async () => {
    const query = await seed();
    replies = [firstAnswer];
    const { startUnifiedMerge, applyUnifiedMerge, continueUnifiedMerge } = await import('./recipeMergeUnified.local');
    const opened = await startUnifiedMerge(KEEP, [DUP], 'it');
    const result = await applyUnifiedMerge(opened.sessionId);
    expect(result?.recipesUpdated).toBe(1);

    const [recipe] = await query<Record<string, any>>(`SELECT * FROM recipes WHERE id = $1`, [KEEP]);
    expect(recipe).toMatchObject({ title: 'Zuppa di cipolle gratinata', description: 'Con Emmentaler.', difficulty: 'medium', cook_time_min: 40, times_cooked: 5, source_url: 'https://a.it/zuppa' });
    expect(JSON.parse(recipe.tags)).toEqual(expect.arrayContaining(['Zuppa', 'Francia']));
    // Every reference of both versions, and the page each came from.
    expect(JSON.parse(recipe.sources).map((s: { url?: string; label?: string }) => s.url ?? s.label)).toEqual(['https://a.it/zuppa', 'Larousse', 'https://b.fr/soupe']);

    const ingredients = await query<{ ingredient_id: string; sort_order: number; quantity: number }>(
      `SELECT ingredient_id, sort_order, quantity FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY sort_order`, [KEEP]);
    expect(ingredients).toEqual([
      { ingredient_id: 'i-cipolle', sort_order: 0, quantity: 1000 },
      { ingredient_id: 'i-burro', sort_order: 1, quantity: 50 },
      { ingredient_id: 'i-emmentaler', sort_order: 2, quantity: 150 },
    ]);

    const steps = await query<{ description: string; duration_min: number | null; step_ingredients: string }>(
      `SELECT description, duration_min, step_ingredients FROM recipe_steps WHERE recipe_id = $1 ORDER BY step_number`, [KEEP]);
    expect(steps.map((s) => s.duration_min)).toEqual([null, 40]);
    // The prose is linked back to the ingredient rows it names.
    expect(steps[0].description).toContain('{{ing:0');
    expect(JSON.parse(steps[1].step_ingredients).map((r: { ingredientSortOrder: number }) => r.ingredientSortOrder)).toEqual([0, 1]);

    const [copy] = await query<{ sync_status: string | null }>(`SELECT sync_status FROM recipes WHERE id = $1`, [DUP]);
    expect(copy === undefined || copy.sync_status === 'deleted').toBe(true);

    // The merge is over: its session is gone.
    await expect(continueUnifiedMerge(opened.sessionId, 'ancora')).rejects.toThrow();
  });

  it('fails, touching nothing, when the model returns no recipe', async () => {
    const query = await seed();
    replies = [{ reply: 'Non riesco.', recipe: null }];
    const { startUnifiedMerge } = await import('./recipeMergeUnified.local');
    await expect(startUnifiedMerge(KEEP, [DUP], 'it')).rejects.toThrow();
    expect(await query(`SELECT id FROM recipes WHERE COALESCE(sync_status,'') != 'deleted'`)).toHaveLength(2);
  });
});
