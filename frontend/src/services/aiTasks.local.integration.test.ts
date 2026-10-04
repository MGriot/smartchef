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
    // English is the base name itself: never offered as a translation, and
    // not asked of the model.
    expect(res.data[0].translations.some((tr: { lang: string }) => tr.lang === 'en')).toBe(false);
    expect(providerCalls[0].systemPrompt).not.toContain('"en" (');
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

describe('standalone ingredient tidy (category, tags, nutrition, synonyms)', () => {
  async function seedSugar() {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('bak', 'Bakery', 0), ('pan', 'Pantry', 1)");
    await query("INSERT INTO tags (id, name) VALUES ('t-vegan', 'Vegan'), ('t-gluten', 'Gluten')");
    await query("INSERT INTO ingredients (id, category_id, name, synonyms) VALUES ('sugar', 'bak', 'Sugar', '[\"Granulated Sugar\"]')");
    await query("INSERT INTO ingredient_tags (ingredient_id, tag_id) VALUES ('sugar', 't-gluten')");
  }

  it('asks only for the aspects requested and resolves categories and tags to ids', async () => {
    await seedSugar();
    providerAnswer = () => JSON.stringify({ items: [{
      key: 'sugar', category: 'pantry', tags: ['vegan', 'Invented Tag'], wrongTags: ['Gluten'],
      nutrition: { kcal: 387, protein: 0, carbs: 99.8, fat: 0, fiber: 0, sugar: 99.8, sodium: 1, bogus: 5 },
      synonyms: ['Table Sugar'],
      // Not asked for — must not come back.
      name: 'Something Else', translations: { it: 'Altro' },
    }] });

    const res = await route('/api/ingredients/ai-tidy', 'POST', {
      items: [{ key: 'sugar', text: 'Sugar', category: 'Bakery', tags: ['Gluten'], nutrition: {}, synonyms: ['Granulated Sugar'] }],
      aspects: { naming: false, classification: true, nutrition: true, synonyms: true },
    });
    expect(res.status).toBe(200);
    const [s] = res.data;
    expect(s.categoryId).toBe('pan');
    // Names are matched case-insensitively against the user's own lists;
    // a tag the model made up is dropped.
    expect(s.tagIds).toEqual(['t-vegan']);
    expect(s.wrongTagIds).toEqual(['t-gluten']);
    expect(s.nutrition).toMatchObject({ caloriesKcal: 387, carbsG: 99.8, sodiumMg: 1 });
    expect(s.synonyms).toEqual(['Table Sugar']);
    expect(s.name).toBeUndefined();
    expect(s.translations).toBeUndefined();

    const prompt = providerCalls[0].systemPrompt;
    expect(prompt).toContain('"Pantry"');
    expect(prompt).toContain('"Vegan"');
    expect(prompt).not.toContain('"wrongTranslations"');
    // Only what the asked-for aspects need is sent.
    expect(JSON.parse(providerCalls[0].content).items[0]).not.toHaveProperty('known');
  });

  it('flags a wrong translation on file when naming is asked for', async () => {
    const { query } = await import('../db/local');
    await query("INSERT INTO ingredient_categories (id, name, sort_order) VALUES ('c', 'Pantry', 0)");
    await query("INSERT INTO ingredients (id, category_id, name) VALUES ('sugar', 'c', 'Sugar')");
    providerAnswer = () => JSON.stringify({ items: [{
      key: 'sugar', name: 'Sugar', parent: null,
      translations: { it: 'Zucchero', fr: 'Sucre', es: 'Azúcar' },
      wrongTranslations: ['IT', 'de'],
    }] });

    const res = await route('/api/ingredients/ai-tidy', 'POST', {
      items: [{ key: 'sugar', text: 'Sugar', known: { it: 'Farina' } }],
      aspects: { naming: true, classification: false, nutrition: false, synonyms: false },
    });
    // Normalized to lower case and limited to the library's languages.
    expect(res.data[0].wrongTranslations).toEqual(['it']);
    expect(res.data[0].translations).toContainEqual({ lang: 'it', text: 'Zucchero' });
    expect(providerCalls[0].systemPrompt).toContain('"wrongTranslations"');
  });

  it('refuses a request that asks for nothing', async () => {
    const res = await route('/api/ingredients/ai-tidy', 'POST', { items: [{ key: 'a', text: 'A' }], aspects: {} });
    expect(res.status).toBe(400);
  });

  it('applies category, tags, nutrition and synonyms without touching the rest', async () => {
    await seedSugar();
    const { query } = await import('../db/local');
    await query("UPDATE ingredients SET description='keep me', fat_g=0.5 WHERE id='sugar'");

    const res = await route('/api/ingredients/sugar/naming', 'POST', {
      categoryId: 'pan',
      addTagIds: ['t-vegan'],
      removeTagIds: ['t-gluten'],
      nutrition: { caloriesKcal: 387, carbsG: 99.8 },
      addSynonyms: ['Table Sugar', 'granulated sugar'],
      translations: [{ lang: 'it', text: 'Zucchero' }],
    });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT category_id, calories_kcal, carbs_g, fat_g, description, synonyms FROM ingredients WHERE id='sugar'").get()).toEqual({
      category_id: 'pan', calories_kcal: 387, carbs_g: 99.8, fat_g: 0.5, description: 'keep me',
      synonyms: JSON.stringify(['Granulated Sugar', 'Table Sugar']),
    });
    expect(db.prepare("SELECT tag_id FROM ingredient_tags WHERE ingredient_id='sugar'").all()).toEqual([{ tag_id: 't-vegan' }]);

    // A category that does not exist is ignored rather than orphaning the row.
    await route('/api/ingredients/sugar/naming', 'POST', { categoryId: 'nope' });
    expect(db.prepare("SELECT category_id FROM ingredients WHERE id='sugar'").get()).toEqual({ category_id: 'pan' });
  });
});
