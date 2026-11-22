// ════════════════════════════════════════════════════════════════════════
// "Tidy with AI" runs against a real SQLite: which ingredients a run still
// sends, answers kept batch by batch as they arrive, a busy provider
// answered with a status the Library waits on, and a stopped run resumed
// with what is left. The provider is stubbed; everything from the router
// down is the real code.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
const providerCalls: Array<{ content: string; systemPrompt: string }> = [];
let providerAnswer: (content: string) => string = () => '{}';

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) { db.exec(sql); return; }
          db.exec('BEGIN');
          try { db.exec(sql); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => { throw new Error('one connection only'); },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));
vi.mock('../lib/sync/gitSync', () => ({ writeEntityFile: async () => {}, logIfSlow: () => {} }));
vi.mock('./llmParser.local', () => ({
  callConfiguredProvider: async (content: string, systemPrompt: string) => {
    providerCalls.push({ content, systemPrompt });
    return providerAnswer(content);
  },
  parseJsonObject: (raw: string) => JSON.parse(raw.match(/\{[\s\S]*\}/)![0]),
}));

/** What llmParser.local.ts throws when the model is rate-limited. */
function busy(statusCode: number): Error {
  return Object.assign(new Error(`Gemini is busy (HTTP ${statusCode})`), { name: 'ProviderUnavailableError', statusCode });
}

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  providerCalls.length = 0;
  providerAnswer = () => '{}';
  vi.resetModules();
  await (await import('../db/local')).initLocalSchema();
});

async function route(path: string, method: string, body?: unknown) {
  const { dispatchLocal } = await import('./localRouter');
  return dispatchLocal(path, { method, body: body === undefined ? undefined : JSON.stringify(body) } as RequestInit) as Promise<any>;
}

const NUTRITION = { naming: false, classification: false, nutrition: true, synonyms: false };
const IDS = ['flour', 'rice', 'sugar'];

async function seed() {
  const { query } = await import('../db/local');
  await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Pantry', 0)");
  await query("INSERT INTO ingredients (id, category_id, name) VALUES ('flour', 'c', 'Flour'), ('rice', 'c', 'Rice')");
  // Every nutrient on file already: nothing for the model to fill.
  await query(`INSERT INTO ingredients (id, category_id, name, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg)
               VALUES ('sugar', 'c', 'Sugar', 387, 0, 100, 0, 0, 100, 1)`);
}

/** The model answers with nutrition for every item it is sent. */
const answerNutrition = (content: string) => JSON.stringify({
  items: JSON.parse(content).items.map((i: { key: string }) => ({ key: i.key, nutrition: { kcal: 350, protein: 10, carbs: 75, fat: 1, fiber: 3, sugar: 1, sodium: 2 } })),
});

const tidyBatch = (keys: string[]) => route('/api/ingredients/ai-tidy', 'POST', {
  aspects: NUTRITION, record: true, items: keys.map((key) => ({ key, text: key })),
});

const plan = async (force = false) => (await route('/api/ingredients/ai-tidy/plan', 'POST', { ids: IDS, aspects: NUTRITION, force })).data;

describe('tidy runs: planning, keeping and resuming', () => {
  it('sends only the ingredients that are not complete yet', async () => {
    await seed();
    expect(await plan()).toEqual({ pendingIds: ['flour', 'rice'], complete: 1, unchanged: 0, saved: [] });
  });

  it('keeps the batches that came back when a later one is refused, and resumes with the rest', async () => {
    await seed();
    providerAnswer = answerNutrition;
    const first = await tidyBatch(['flour']);
    expect(first.status).toBe(200);

    // Rate-limited even after its own retries: a status the Library waits
    // on and re-sends, and nothing kept for that batch.
    providerAnswer = () => { throw busy(429); };
    expect((await tidyBatch(['rice'])).status).toBe(429);
    providerAnswer = () => { throw busy(503); };
    expect((await tidyBatch(['rice'])).status).toBe(503);

    // The next run sends only what is left, and hands back what was kept.
    const next = await plan();
    expect(next.pendingIds).toEqual(['rice']);
    expect(next.unchanged).toBe(1);
    expect(next.saved).toHaveLength(1);
    expect(next.saved[0]).toMatchObject({ key: 'flour', nutrition: { caloriesKcal: 350 } });
  });

  it('answers a refusal that would fail again with 502, so the run stops', async () => {
    await seed();
    providerAnswer = () => { throw new Error('No API key saved for Google Gemini'); };
    expect((await tidyBatch(['flour'])).status).toBe(502);
    // A retired model is not worth waiting for either.
    providerAnswer = () => { throw busy(404); };
    expect((await tidyBatch(['flour'])).status).toBe(502);
  });

  it('drops a kept answer once the ingredient changes, and sends it again', async () => {
    await seed();
    providerAnswer = answerNutrition;
    await tidyBatch(['flour']);
    db.prepare("UPDATE ingredients SET fat_g = 1.2 WHERE id = 'flour'").run();

    const next = await plan();
    expect(next.saved).toEqual([]);
    expect(next.pendingIds).toEqual(['flour', 'rice']);
    expect(db.prepare("SELECT suggestion FROM ingredient_ai_reviews WHERE ingredient_id = 'flour'").get()).toEqual({ suggestion: null });
  });

  it('counts a reviewed ingredient as done, applied or not', async () => {
    await seed();
    providerAnswer = answerNutrition;
    await tidyBatch(['flour', 'rice']);

    // The user applies flour's values and leaves rice's unticked.
    expect((await route('/api/ingredients/flour/naming', 'POST', { nutrition: { caloriesKcal: 350, proteinG: 10, carbsG: 75, fatG: 1, fiberG: 3, sugarG: 1, sodiumMg: 2 } })).status).toBe(200);
    expect((await route('/api/ingredients/ai-tidy/done', 'POST', { ids: ['flour', 'rice'] })).status).toBe(200);

    // Both were reviewed and have not changed since (flour's applied values
    // were re-hashed), and sugar was complete all along.
    expect(await plan()).toEqual({ pendingIds: [], complete: 1, unchanged: 2, saved: [] });
  });

  it('reviews everything again when forced, dropping the kept answers', async () => {
    await seed();
    providerAnswer = answerNutrition;
    await tidyBatch(['flour']);

    const forced = await plan(true);
    expect(forced.pendingIds).toEqual(IDS);
    expect(forced.saved).toEqual([]);
    expect((await plan()).pendingIds).toEqual(['flour', 'rice']);
  });

  it('merges a second aspect into an answer still waiting for review', async () => {
    await seed();
    providerAnswer = answerNutrition;
    await tidyBatch(['flour']);
    providerAnswer = () => JSON.stringify({ items: [{ key: 'flour', synonyms: ['Wheat Flour'] }] });
    await route('/api/ingredients/ai-tidy', 'POST', {
      aspects: { ...NUTRITION, nutrition: false, synonyms: true }, record: true, items: [{ key: 'flour', text: 'Flour' }],
    });
    const row = db.prepare("SELECT hashes, suggestion FROM ingredient_ai_reviews WHERE ingredient_id = 'flour'").get() as { hashes: string; suggestion: string };
    expect(Object.keys(JSON.parse(row.hashes)).sort()).toEqual(['nutrition', 'synonyms']);
    expect(JSON.parse(row.suggestion)).toMatchObject({ key: 'flour', nutrition: { caloriesKcal: 350 }, synonyms: ['Wheat Flour'] });
  });

  it('sends one of the Library\'s batches as one request', async () => {
    await seed();
    providerAnswer = () => JSON.stringify({ items: [] });
    const items = Array.from({ length: 41 }, (_, i) => ({ key: `k${i}`, text: `Item ${i}` }));
    await route('/api/ingredients/ai-tidy', 'POST', { aspects: NUTRITION, items });
    expect(providerCalls.map((c) => JSON.parse(c.content).items.length)).toEqual([40, 1]);
  });
});
