import { describe, it, expect } from 'vitest';
import {
  buildRecipeReport, componentOrder, missingComponentIds,
  type ReportOptions, type ReportRecipeInput, type ReportFormatters,
} from './recipeReport';

// A fake `t` that shows the key and its interpolation values, so these
// assertions are about what the report decided to say rather than about
// any particular wording (the pattern duration.test.ts uses).
const t: ReportFormatters['t'] = (key, opts) =>
  opts && Object.keys(opts).length ? `${key}${JSON.stringify(opts)}` : key;

const fmt: ReportFormatters = {
  t,
  formatDate: iso => iso.slice(0, 10),
  formatRegion: r => `region:${r}`,
};

const options = (overrides: Partial<ReportOptions> = {}): ReportOptions => ({
  servings: 4,
  displaySystem: 'metric',
  includeCover: true,
  includeStepPhotos: true,
  includeComponents: true,
  includeNutrition: true,
  ...overrides,
});

const cream: ReportRecipeInput = {
  id: 'cream',
  title: 'Crema pasticcera',
  translated_title: 'Pastry cream',
  servings: 4,
  prep_time_min: 10,
  cook_time_min: 10,
  yield_amount: 500,
  yield_unit_symbol: 'g',
  ingredients: [
    { sortOrder: 1, ingredientName: 'milk', quantity: 500, unitSymbol: 'ml' },
    { sortOrder: 2, ingredientName: 'yolk', ingredientPluralName: 'yolks', quantity: 4, unitSymbol: 'pz' },
  ],
  steps: [{ id: 'c1', stepNumber: 1, description: 'Whisk {{ing:2}} into {{ing:1}}.' }],
};

const tart: ReportRecipeInput = {
  id: 'tart',
  title: 'Crostata',
  translated_title: 'Fruit tart',
  description: 'A summer tart.',
  servings: 8,
  difficulty: 'medium',
  prep_time_min: 30,
  rest_time_min: 0,
  cook_time_min: 45,
  rating: 4,
  times_cooked: 3,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-06-01T10:00:00Z',
  creator_name: 'Ada',
  tags_display: [{ name: 'dolci', translated_name: 'desserts', color: '#f00' }],
  regions: ['IT'],
  cover_image_url: 'images/cover.webp',
  source_url: 'https://example.com/tart',
  sources: [{ type: 'book', label: 'Il cucchiaio' }, { type: 'url', url: 'https://example.com/tart' }],
  storage_instructions: 'Fridge, two days.',
  tips: '  ',
  ingredients: [
    { sortOrder: 1, ingredientName: 'flour', quantity: 250, unitSymbol: 'g', groupName: 'Pastry' },
    { sortOrder: 2, ingredientName: 'butter', quantity: 125, unitSymbol: 'g', notes: ', cold,' },
    { sortOrder: 3, ingredientName: 'margarine', quantity: 125, unitSymbol: 'g', substituteFor: 2 },
    { sortOrder: 4, subRecipeId: 'cream', subRecipeTitle: 'Pastry cream', quantity: 300, unitSymbol: 'g', groupName: 'Filling' },
    { sortOrder: 5, ingredientName: 'berries', quantity: null, quantityText: 'to taste', isOptional: true, groupName: 'Filling' },
  ],
  tools: [{ id: 'oven', name: 'forno', translated_name: 'oven' }],
  techniques: [{ id: 'blind', name: 'cottura in bianco', translated_name: 'blind baking' }],
  steps: [
    {
      id: 't2', stepNumber: 2, title: null, description: 'Bake with {{tool:oven}}.',
      durationMin: 45, toolIds: ['oven'], techniqueIds: ['blind', 'unknown'],
      notes: 'Use beans.', imageUrl: 'images/step.webp',
    },
    {
      id: 't1', stepNumber: 1, title: 'Pastry', translatedTitle: 'Make the pastry',
      description: 'Rub {{ing:2}} into {{ing:1}}.',
      stepIngredients: [{ ingredientSortOrder: 1, portion: 1 }, { ingredientSortOrder: 2, portion: 0.5 }],
    },
  ],
};

const subs = new Map([[cream.id, cream]]);

describe('buildRecipeReport — header', () => {
  const model = buildRecipeReport(
    { recipe: tart, subRecipes: subs, nutrition: null },
    options({ servings: 4 }),
    fmt,
  );

  it('uses the translated title and description', () => {
    expect(model.title).toBe('Fruit tart');
    expect(model.description).toBe('A summer tart.');
  });

  it('states servings, times and difficulty, leaving zero times off', () => {
    const labels = model.facts.map(f => f.label);
    expect(model.facts[0]).toEqual({ label: 'recipeDetail.servings', value: '4' });
    expect(labels).toContain('recipeDetail.prepTime');
    expect(labels).toContain('recipeDetail.cookTime');
    expect(labels).toContain('recipeDetail.totalTime');
    expect(labels).not.toContain('recipeDetail.waitingTime');
    expect(model.facts.find(f => f.label === 'recipeDetail.complexity')?.value).toBe('gallery.difficultyIntermediate');
  });

  it('collects author, rating, cook count and dates into the meta line', () => {
    expect(model.meta).toEqual([
      'print.report.byAuthor{"name":"Ada"}',
      '★★★★☆',
      'recipeDetail.cookedTimes{"count":3}',
      'recipeDetail.created{"date":"2026-05-01"}',
      'recipeDetail.lastEdited{"date":"2026-06-01"}',
    ]);
  });

  it('prefers translated tag names and formats regions', () => {
    expect(model.tags).toEqual([{ name: 'desserts', color: '#f00' }]);
    expect(model.regions).toEqual(['region:IT']);
  });

  it('keeps the cover unless it is switched off', () => {
    expect(model.coverImage).toBe('images/cover.webp');
    const without = buildRecipeReport({ recipe: tart }, options({ includeCover: false }), fmt);
    expect(without.coverImage).toBeNull();
  });
});

describe('buildRecipeReport — ingredients', () => {
  const model = buildRecipeReport({ recipe: tart, subRecipes: subs }, options({ servings: 4 }), fmt);
  const groups = model.main.ingredientGroups;

  it('groups the way the page does: a header where a named group starts', () => {
    expect(groups.map(g => g.name)).toEqual(['Pastry', 'Filling']);
    // The unnamed butter row reads on under "Pastry", as on screen.
    expect(groups[0].items.map(i => i.name)).toEqual(['flour', 'butter']);
  });

  it('scales by the main recipe\'s servings ratio', () => {
    // 8 → 4 servings halves everything.
    expect(groups[0].items[0].amount).toBe('125 g');
  });

  it('nests substitutes under the ingredient they replace, not as rows', () => {
    const butter = groups[0].items[1];
    expect(butter.substitutes).toEqual([{ name: 'margarine', amount: '62.5 g', note: null }]);
    expect(groups.flatMap(g => g.items).some(i => i.name === 'margarine')).toBe(false);
  });

  it('tidies notes and keeps optional and text-only amounts', () => {
    expect(groups[0].items[1].note).toBe('cold');
    const berries = groups[1].items[1];
    expect(berries).toMatchObject({ name: 'berries', amount: 'to taste', optional: true });
  });

  it('links a sub-recipe row to its printed component', () => {
    expect(groups[1].items[0]).toMatchObject({ name: 'Pastry cream', componentAnchor: 'report-recipe-cream' });
    const noComponents = buildRecipeReport({ recipe: tart, subRecipes: subs }, options({ includeComponents: false }), fmt);
    expect(noComponents.main.ingredientGroups[1].items[0].componentAnchor).toBeNull();
    expect(noComponents.components).toEqual([]);
  });
});

describe('buildRecipeReport — method', () => {
  const model = buildRecipeReport({ recipe: tart, subRecipes: subs }, options({ servings: 4 }), fmt);
  const [first, second] = model.main.steps;

  it('orders steps by number and falls back to "Step N" for an untitled one', () => {
    expect(first.title).toBe('Make the pastry');
    expect(second.title).toBe('recipeDetail.stepNumber{"number":2}');
  });

  it('lists what a step takes out of the ingredients, scaled', () => {
    expect(first.uses).toEqual(['flour: 125 g', 'butter: 31.3 g (50%)']);
    expect(first.textContext.ingredients.find(i => i.sortOrder === 2)?.stepQuantity).toBe('31.3 g');
    expect(first.textContext.scale).toBe(0.5);
  });

  it('carries the step\'s own tools, techniques and chef\'s note', () => {
    expect(second.tools).toEqual(['oven']);
    // Recipe-level names win; an id resolved nowhere is dropped.
    expect(second.techniques).toEqual(['blind baking']);
    expect(second.note).toBe('Use beans.');
    expect(second.duration).toBeTruthy();
  });

  it('drops step photos when switched off', () => {
    expect(second.image).toBe('images/step.webp');
    const without = buildRecipeReport({ recipe: tart }, options({ includeStepPhotos: false }), fmt);
    expect(without.main.steps.every(s => s.image === null)).toBe(true);
  });

  it('resolves {{tech:id}} names from the library for step text', () => {
    const withLibrary = buildRecipeReport(
      { recipe: tart, techniques: [{ id: 'fold', name: 'piegare', translated_name: 'folding' }] },
      options(),
      fmt,
    );
    expect(withLibrary.main.steps[0].textContext.techniques).toEqual([{ id: 'fold', name: 'folding' }]);
  });
});

describe('buildRecipeReport — component recipes', () => {
  const model = buildRecipeReport({ recipe: tart, subRecipes: subs }, options({ servings: 4 }), fmt);

  it('prints each component in full, scaled by the main recipe\'s ratio', () => {
    expect(model.components).toHaveLength(1);
    const [section] = model.components;
    expect(section.title).toBe('Pastry cream');
    expect(section.anchor).toBe('report-recipe-cream');
    expect(section.ingredientGroups[0].items.map(i => `${i.amount} ${i.name}`)).toEqual(['250 ml milk', '2 pz yolks']);
    expect(section.steps).toHaveLength(1);
  });

  it('says where and how much of it the main recipe uses', () => {
    expect(model.components[0].usedIn).toEqual(['print.report.usedInAmount{"recipe":"Fruit tart","amount":"150 g"}']);
  });

  it('gives a component its yield and times, but not the servings', () => {
    const labels = model.components[0].facts.map(f => f.label);
    expect(labels).toContain('recipeDetail.yield');
    expect(labels).not.toContain('recipeDetail.servings');
    expect(model.components[0].facts.find(f => f.label === 'recipeDetail.yield')?.value).toBe('250 g');
  });

  it('leaves out a component that failed to load', () => {
    const missing = buildRecipeReport({ recipe: tart, subRecipes: new Map() }, options(), fmt);
    expect(missing.components).toEqual([]);
    expect(missing.main.ingredientGroups[1].items[0].componentAnchor).toBeNull();
  });
});

describe('componentOrder', () => {
  const r = (id: string, subIds: string[]): ReportRecipeInput => ({
    id, title: id, servings: 1,
    ingredients: subIds.map((sub, i) => ({ sortOrder: i, subRecipeId: sub, quantity: null })),
  });

  it('puts a recipe\'s own components before it, each once', () => {
    const map = new Map([
      ['a', r('a', ['c'])],
      ['b', r('b', ['c'])],
      ['c', r('c', [])],
    ]);
    expect(componentOrder(r('root', ['a', 'b']), map).map(x => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('survives a cycle and a self-reference', () => {
    const map = new Map([
      ['a', r('a', ['b', 'root'])],
      ['b', r('b', ['a'])],
    ]);
    expect(componentOrder(r('root', ['a', 'root']), map).map(x => x.id)).toEqual(['b', 'a']);
  });

  it('stops descending past the depth cap', () => {
    const map = new Map([
      ['a', r('a', ['b'])],
      ['b', r('b', ['c'])],
      ['c', r('c', [])],
    ]);
    expect(componentOrder(r('root', ['a']), map, 1).map(x => x.id)).toEqual(['a']);
  });
});

describe('missingComponentIds', () => {
  it('reports what still has to be fetched, walking what already was', () => {
    const root: ReportRecipeInput = { id: 'root', title: 'r', servings: 1, ingredients: [{ sortOrder: 1, subRecipeId: 'a', quantity: null }] };
    const a: ReportRecipeInput = { id: 'a', title: 'a', servings: 1, ingredients: [{ sortOrder: 1, subRecipeId: 'b', quantity: null }] };
    expect(missingComponentIds(root, new Map())).toEqual(['a']);
    expect(missingComponentIds(root, new Map([['a', a]]))).toEqual(['b']);
  });
});

describe('buildRecipeReport — closing sections', () => {
  it('scales nutrition from the base servings and drops it when switched off', () => {
    const nutrition = {
      totals: { caloriesKcal: 3200, proteinG: 40, carbsG: 400, fatG: 160, fiberG: 8, sugarG: 120, sodiumMg: 900 },
      unresolved: ['berries'],
    };
    const model = buildRecipeReport({ recipe: tart, nutrition }, options({ servings: 4 }), fmt);
    expect(model.nutrition?.rows[0]).toEqual({ label: 'recipeDetail.calories', value: '1600 kcal' });
    expect(model.nutrition?.perServing).toBe('recipeDetail.kcalPerServing{"count":400}');
    expect(model.nutrition?.unresolved).toBe('recipeDetail.nutritionUnavailableFor{"items":"berries"}');
    expect(buildRecipeReport({ recipe: tart, nutrition }, options({ includeNutrition: false }), fmt).nutrition).toBeNull();
  });

  it('prints nothing for an all-zero nutrition answer', () => {
    const zero = { totals: { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 } };
    expect(buildRecipeReport({ recipe: tart, nutrition: zero }, options(), fmt).nutrition).toBeNull();
  });

  it('lists references without repeating the import URL', () => {
    const model = buildRecipeReport({ recipe: tart }, options(), fmt);
    expect(model.references).toEqual([
      { type: 'book', label: 'Il cucchiaio', url: null },
      { type: 'url', label: 'https://example.com/tart', url: 'https://example.com/tart' },
    ]);
    const onlyImport = buildRecipeReport({ recipe: { ...tart, sources: [] } }, options(), fmt);
    expect(onlyImport.references).toEqual([{ type: 'url', label: 'print.source', url: 'https://example.com/tart' }]);
  });

  it('keeps storage and drops blank tips', () => {
    const model = buildRecipeReport({ recipe: tart }, options(), fmt);
    expect(model.main.storage).toBe('Fridge, two days.');
    expect(model.main.tips).toBeNull();
  });
});
