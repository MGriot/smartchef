// ════════════════════════════════════════════════════════════════════════
// Standalone-mode AI tasks against a real SQLite: recipe translation
// (POST /api/recipes/:id/translate/:lang used to answer 501 offline) and
// ingredient naming (English base name, "variety of" parent, a name per
// language). The provider is stubbed; everything from the router down is
// the real code.
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
  repairTruncatedJson: (s: string) => s,
}));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  providerCalls.length = 0;
  vi.resetModules();
  await (await import('../db/local')).initLocalSchema();
});

async function route(path: string, method: string, body?: unknown) {
  const { dispatchLocal } = await import('./localRouter');
  return dispatchLocal(path, { method, body: body === undefined ? undefined : JSON.stringify(body) } as RequestInit) as Promise<any>;
}

describe('standalone recipe translation', () => {
  it('translates title, steps and ingredient notes and stores them for that language', async () => {
    const { query } = await import('../db/local');
    const { createRecipe, getRecipe } = await import('./recipes.local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Veg', 0)");
    await query("INSERT INTO ingredients (id, category_id, name) VALUES ('ing', 'c', 'Onion')");
    const { id } = await createRecipe({
      title: 'Zuppa', description: 'Buona', servings: 2,
      ingredients: [{ sortOrder: 0, ingredientId: 'ing', notes: 'tritata' }],
      steps: [{ stepNumber: 1, description: 'Taglia la cipolla' }],
    } as never, 'Matteo');

    const stepId = db.prepare('SELECT id FROM recipe_steps').get() as { id: string };
    const riId = db.prepare('SELECT id FROM recipe_ingredients').get() as { id: string };
    providerAnswer = () => JSON.stringify({
      title: 'Soup', description: 'Good',
      steps: [{ id: stepId.id, title: null, description: 'Chop the onion', notes: null }],
      ingredientNotes: [{ id: riId.id, notes: 'chopped' }],
    });

    const res = await route(`/api/recipes/${id}/translate/en`, 'POST');
    expect(res.status).toBe(200);
    expect(providerCalls[0].systemPrompt).toContain('English');

    const recipe: any = await getRecipe(id, 'en');
    expect(recipe.translated_title).toBe('Soup');
    expect(JSON.stringify(recipe)).toContain('Chop the onion');
    expect(JSON.stringify(recipe)).toContain('chopped');

    // Translating again overwrites instead of failing on the unique key.
    providerAnswer = () => JSON.stringify({ title: 'Onion Soup', description: null, steps: [], ingredientNotes: [] });
    expect((await route(`/api/recipes/${id}/translate/en`, 'POST')).status).toBe(200);
    expect(((await getRecipe(id, 'en')) as any).translated_title).toBe('Onion Soup');
  });
});

describe('standalone ingredient naming', () => {
  it('suggests an English name with a parent from the catalog and a name per language', async () => {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Fruit', 0)");
    await query("INSERT INTO ingredients (id, category_id, name) VALUES ('apple', 'c', 'Apple')");
    providerAnswer = () => JSON.stringify({ items: [{
      key: '0', name: 'Renetta Apple', parent: 'Apple',
      translations: { en: 'x', it: 'Mela renetta', fr: 'Pomme reinette', es: 'Manzana reineta' },
    }] });

    const res = await route('/api/ingredients/ai-name', 'POST', { items: [{ key: '0', text: 'mele renette' }] });
    expect(res.status).toBe(200);
    expect(res.data[0]).toMatchObject({ name: 'Renetta Apple', parent: 'Apple', parentId: 'apple' });
    // "en" is always the base name, whatever the model wrote there.
    expect(res.data[0].translations).toContainEqual({ lang: 'en', text: 'Renetta Apple' });
    expect(res.data[0].translations).toContainEqual({ lang: 'it', text: 'Mela renetta' });
    expect(providerCalls[0].systemPrompt).toContain('Apple');
  });

  it('auto-translates a new ingredient on create, keeping the typed name', async () => {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Drinks', 0)");
    providerAnswer = () => JSON.stringify({ items: [{ key: 'new', name: 'Something Else', parent: null, translations: { it: 'Acqua tonica', fr: 'Eau tonique' } }] });

    const res = await route('/api/ingredients', 'POST', { name: 'Tonic Water', categoryId: 'c', autoTranslate: true, translations: [{ lang: 'fr', text: 'Tonic' }] });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT name FROM ingredients WHERE id=?').get(res.data.id) as { name: string };
    expect(row.name).toBe('Tonic Water');
    const trs = db.prepare('SELECT language_code, translated_name FROM ingredient_translations WHERE ingredient_id=? ORDER BY language_code').all(res.data.id);
    // The typed French name wins over the AI's.
    expect(trs).toEqual([
      { language_code: 'en', translated_name: 'Tonic Water' },
      { language_code: 'fr', translated_name: 'Tonic' },
      { language_code: 'it', translated_name: 'Acqua tonica' },
    ]);
  });

  it('still creates the ingredient when the AI is unreachable', async () => {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Drinks', 0)");
    providerAnswer = () => { throw new Error('connection refused'); };
    const res = await route('/api/ingredients', 'POST', { name: 'Ice', categoryId: 'c', autoTranslate: true });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT name FROM ingredients WHERE id=?').get(res.data.id)).toEqual({ name: 'Ice' });
  });

  it('applies a naming change without touching the rest of the row', async () => {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Fruit', 0)");
    await query("INSERT INTO ingredients (id, category_id, name, description) VALUES ('apple', 'c', 'Apple', 'keep me')");
    await query("INSERT INTO ingredients (id, category_id, name, parent_ingredient_id) VALUES ('ann', 'c', 'annurca apples', NULL)");
    await query("INSERT INTO ingredient_translations (id, ingredient_id, language_code, translated_name) VALUES ('t1', 'ann', 'it', 'Mele annurca')");

    const res = await route('/api/ingredients/ann/naming', 'POST', {
      name: 'Annurca Apple', parentIngredientId: 'apple',
      translations: [{ lang: 'en', text: 'Annurca Apple' }, { lang: 'fr', text: 'Pomme annurca' }],
    });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT name, parent_ingredient_id FROM ingredients WHERE id=?').get('ann'))
      .toEqual({ name: 'Annurca Apple', parent_ingredient_id: 'apple' });
    expect(db.prepare("SELECT translated_name FROM ingredient_translations WHERE ingredient_id='ann' AND language_code='it'").get())
      .toEqual({ translated_name: 'Mele annurca' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ingredient_translations WHERE ingredient_id='ann'").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT description FROM ingredients WHERE id='apple'").get()).toEqual({ description: 'keep me' });

    // A parent that would make a cycle is refused.
    await route('/api/ingredients/apple/naming', 'POST', { parentIngredientId: 'ann' });
    expect(db.prepare("SELECT parent_ingredient_id FROM ingredients WHERE id='apple'").get()).toEqual({ parent_ingredient_id: null });
  });
});
