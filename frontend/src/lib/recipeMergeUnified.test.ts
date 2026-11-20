import { describe, expect, it } from 'vitest';
import {
  buildUnifiedRequest, buildUnifiedTurns, draftToRows, interpretUnifiedResponse, originsOf,
  type UnifiedSaveDeps, type UnifiedSourceRecipe,
} from './recipeMergeUnified';

const ing = (id: string, label: string, quantity: number | null, unit: string | null, extra: Partial<UnifiedSourceRecipe['ingredients'][number]> = {}) => ({
  id, label, quantity, quantityText: null, unit, unitId: unit ? `u-${unit}` : null, notes: null, groupName: null, isOptional: false,
  ingredientId: `lib-${label.toLowerCase()}`, subRecipeId: null, subtypeId: null, ...extra,
});
const step = (id: string, text: string, durationMin: number | null = null, extra: Partial<UnifiedSourceRecipe['steps'][number]> = {}) => ({
  id, title: null, text, durationMin, notes: null, toolIds: [], techniqueIds: [], imageUrl: null, ...extra,
});

const recipes: UnifiedSourceRecipe[] = [
  {
    id: 'keep', title: 'Zuppa di cipolle', description: null, tips: null, storage: null, servings: 4,
    prepTimeMin: null, cookTimeMin: null, restTimeMin: null, difficulty: 'easy',
    ingredients: [ing('k0', 'Cipolle', 1, 'kg'), ing('k1', 'Emmentaler', 150, 'g')],
    steps: [step('ks0', 'Affettate le cipolle.'), step('ks1', 'Stufate le cipolle nel burro.', 40, { toolIds: ['t-pot'] })],
    tools: [{ id: 't-pot', names: ['Pentola'] }], techniques: [],
  },
  {
    id: 'dup', title: 'Soupe à l\'oignon', description: null, tips: null, storage: null, servings: 4,
    prepTimeMin: 15, cookTimeMin: null, restTimeMin: null, difficulty: 'medium',
    ingredients: [ing('d0', 'Cipolle', 800, 'g'), ing('d1', 'Burro', 50, 'g'), ing('d2', 'Brodo', 1, 'l')],
    steps: [step('ds0', 'Gratinate in forno.', 10, { imageUrl: 'https://img/x.jpg', techniqueIds: ['q-grat'] })],
    tools: [], techniques: [{ id: 'q-grat', names: ['Gratinare'] }],
  },
];

const answer = (recipe: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  reply: 'Ecco la ricetta unita.', reasoning: ['Le cipolle: 1 kg nella versione tenuta, 800 g nella copia.'], recipe, doubts: [], warnings: [], ...extra,
});

const unified = {
  title: 'Zuppa di cipolle gratinata',
  servings: 4,
  prepTimeMin: 15,
  difficulty: 'medium',
  ingredients: [
    { from: '0.0', name: 'Onions', quantity: 1, unit: 'kg' },
    { from: '1.1', name: 'Burro', quantity: 50, unit: 'g' },
    { from: '0.1', name: 'Emmentaler', quantity: 150, unit: 'g', notes: 'grattugiato' },
    { from: '1.2', name: 'Brodo', quantity: '1,5', unit: 'l' },
  ],
  steps: [
    { text: 'Affettate le cipolle.', from: ['0.0'] },
    { text: 'Stufate le cipolle nel burro per 40 minuti.', durationMin: 40, timeKind: 'cook', from: ['0.1'] },
    { text: 'Gratinate in forno con l\'Emmentaler.', durationMin: '10 min', from: ['1.0'] },
  ],
};

describe('buildUnifiedRequest', () => {
  it('marks the kept version and gives every row a ref', () => {
    const req = buildUnifiedRequest(recipes, [{ url: 'https://a.it/z', title: 'Zuppa', text: 'Servings: 4' }], 'it');
    expect(req.language).toBe('it');
    expect(req.recipes.map((r) => r.kept)).toEqual([true, false]);
    expect(req.recipes[1].ingredients.map((i) => i.ref)).toEqual(['1.0', '1.1', '1.2']);
    expect(req.recipes[0].steps[1]).toMatchObject({ ref: '0.1', durationMin: 40 });
    expect(req.sourcePages).toHaveLength(1);
  });
});

describe('interpretUnifiedResponse', () => {
  it('reads the unified recipe, keeping each row\'s own name', () => {
    const out = interpretUnifiedResponse(answer(unified), recipes);
    expect(out.reply).toBe('Ecco la ricetta unita.');
    expect(out.reasoning).toHaveLength(1);
    // The model's "Onions" does not rename a library ingredient.
    expect(out.draft!.ingredients.map((i) => [i.from, i.label, i.quantity, i.unit])).toEqual([
      ['0.0', 'Cipolle', 1, 'kg'], ['1.1', 'Burro', 50, 'g'], ['0.1', 'Emmentaler', 150, 'g'], ['1.2', 'Brodo', 1.5, 'l'],
    ]);
    expect(out.draft!.steps.map((s) => [s.durationMin, s.timeKind, s.from])).toEqual([
      [null, null, ['0.0']], [40, 'cook', ['0.1']], [10, 'cook', ['1.0']],
    ]);
  });

  it('adds up the overall times from the steps when none is stated', () => {
    const out = interpretUnifiedResponse(answer(unified), recipes);
    expect(out.draft).toMatchObject({ prepTimeMin: 15, cookTimeMin: 50, restTimeMin: null, difficulty: 'medium', servings: 4 });
  });

  it('uses a row of a version once only', () => {
    const out = interpretUnifiedResponse(answer({ ...unified, ingredients: [{ from: '0.0' }, { from: '0.0', quantity: 2 }, { from: '9.9', name: '' }] }), recipes);
    expect(out.draft!.ingredients.map((i) => i.from)).toEqual(['0.0']);
  });

  it('keeps an ingredient only a page names, to be looked up in the library', () => {
    const out = interpretUnifiedResponse(answer({ ...unified, ingredients: [...unified.ingredients, { from: null, name: 'Vino bianco', quantity: 100, unit: 'ml' }] }), recipes);
    expect(out.draft!.ingredients[4]).toMatchObject({ from: null, label: 'Vino bianco', quantity: 100 });
  });

  it('drops refs to steps that do not exist and inline reference markup', () => {
    const out = interpretUnifiedResponse(answer({ ...unified, steps: [{ text: 'Unite {{ing:3}} il brodo.', from: ['1.0', '5.5', 'x'] }] }), recipes);
    expect(out.draft!.steps[0]).toMatchObject({ text: 'Unite il brodo.', from: ['1.0'] });
  });

  it('treats a recipe with no ingredients or no steps as no recipe', () => {
    expect(interpretUnifiedResponse(answer({ ...unified, steps: [] }), recipes).draft).toBeNull();
    expect(interpretUnifiedResponse(answer({ ...unified, ingredients: [] }), recipes).draft).toBeNull();
    expect(interpretUnifiedResponse(answer(null), recipes).draft).toBeNull();
  });

  it('reads the doubts with their tappable answers', () => {
    const out = interpretUnifiedResponse(answer(unified, {
      doubts: [
        { question: 'Emmentaler o Gruyère?', options: ['Emmentaler', 'Gruyère', 'Emmentaler', '', 5] },
        { question: '', options: ['x'] },
      ],
    }), recipes);
    expect(out.doubts).toEqual([{ question: 'Emmentaler o Gruyère?', options: ['Emmentaler', 'Gruyère'] }]);
  });

  it('survives an answer that is not the shape asked for', () => {
    const out = interpretUnifiedResponse({ reasoning: 'Ho unito le due.', recipe: 'nope', doubts: 'none' }, recipes);
    expect(out).toMatchObject({ reply: '', reasoning: ['Ho unito le due.'], draft: null, doubts: [], warnings: [] });
  });
});

describe('buildUnifiedTurns', () => {
  const draft = interpretUnifiedResponse(answer(unified), recipes).draft!;
  const exchange = (user: string | null, reply: string) => ({ user, answer: { reply, reasoning: [], draft, doubts: [], warnings: [] } });

  it('sends the versions, the conversation and the recipe as it stands', () => {
    const turns = buildUnifiedTurns('CTX', [exchange(null, 'Prima versione.'), exchange('Usa il Gruyère', 'Fatto.')], draft, 'Dividi il passaggio 2');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(turns[0].content).toBe('CTX');
    // Earlier answers travel as their reply only.
    expect(JSON.parse(turns[1].content)).toEqual({ reply: 'Prima versione.' });
    // The latest carries the whole recipe the app holds.
    expect(JSON.parse(turns[3].content).recipe.ingredients).toHaveLength(4);
    expect(turns[4].content).toBe('Dividi il passaggio 2');
  });

  it('keeps the opening and only the recent exchanges of a long chat', () => {
    const many = [exchange(null, 'apertura'), ...Array.from({ length: 20 }, (_, i) => exchange(`m${i}`, `r${i}`))];
    const turns = buildUnifiedTurns('CTX', many, draft, 'ultimo');
    expect(turns).toHaveLength(1 + 1 + 8 * 2 + 1);
    expect(turns[2].content).toBe('m12');
    expect(turns[turns.length - 1].content).toBe('ultimo');
  });
});

describe('draftToRows', () => {
  const deps = (over: Partial<UnifiedSaveDeps> = {}): UnifiedSaveDeps => ({
    unitIdFor: (unit) => (unit === 'ml' ? 'u-ml' : null),
    ingredientIdFor: (name) => (name === 'Vino bianco' ? 'lib-vino' : null),
    linkStep: (text, names) => ({ description: text, ingredientPositions: names.flatMap((n, i) => (text.toLowerCase().includes(n.toLowerCase()) ? [i] : [])) }),
    mergedIds: new Set(['keep', 'dup']),
    ...over,
  });

  it('keeps each row\'s library ingredient and unit', () => {
    const draft = interpretUnifiedResponse(answer(unified), recipes).draft!;
    const { ingredients, leftOut } = draftToRows(draft, recipes, deps());
    expect(leftOut).toEqual([]);
    expect(ingredients.map((i) => [i.sortOrder, i.ingredientId, i.quantity, i.unitId])).toEqual([
      [0, 'lib-cipolle', 1, 'u-kg'], [1, 'lib-burro', 50, 'u-g'], [2, 'lib-emmentaler', 150, 'u-g'], [3, 'lib-brodo', 1.5, 'u-l'],
    ]);
    expect(ingredients[2].notes).toBe('grattugiato');
  });

  it('looks a changed unit up in the library, and keeps an unknown one as words', () => {
    const draft = interpretUnifiedResponse(answer({
      ...unified,
      ingredients: [{ from: '1.2', quantity: 1500, unit: 'ml' }, { from: '0.1', quantity: 2, unit: 'manciate' }],
    }), recipes).draft!;
    const { ingredients } = draftToRows(draft, recipes, deps());
    expect(ingredients[0]).toMatchObject({ quantity: 1500, unitId: 'u-ml' });
    expect(ingredients[1]).toMatchObject({ quantity: null, quantityText: '2 manciate', unitId: null });
  });

  it('saves a page-only ingredient found in the library and reports one that is not', () => {
    const draft = interpretUnifiedResponse(answer({
      ...unified,
      ingredients: [{ from: '0.0' }, { from: null, name: 'Vino bianco', quantity: 100, unit: 'ml' }, { from: null, name: 'Cognac' }],
    }), recipes).draft!;
    const { ingredients, leftOut, names } = draftToRows(draft, recipes, deps());
    expect(ingredients.map((i) => i.ingredientId)).toEqual(['lib-cipolle', 'lib-vino']);
    expect(names).toEqual(['Cipolle', 'Vino bianco']);
    expect(leftOut).toEqual(['Cognac']);
  });

  it('carries tools, techniques and the picture of the steps a step draws on', () => {
    const draft = interpretUnifiedResponse(answer({
      ...unified,
      steps: [{ text: 'Stufate le cipolle, poi gratinate.', durationMin: 50, from: ['0.1', '1.0'] }],
    }), recipes).draft!;
    const { steps } = draftToRows(draft, recipes, deps());
    expect(steps[0]).toMatchObject({
      stepNumber: 1, durationMin: 50, toolIds: ['t-pot'], techniqueIds: ['q-grat'], imageUrl: 'https://img/x.jpg',
      stepIngredients: [{ ingredientSortOrder: 0, amountMode: 'fraction', portion: 1 }],
    });
  });

  it('does not keep a row that uses one of the merged recipes as a sub-recipe', () => {
    const withSub: UnifiedSourceRecipe[] = [
      { ...recipes[0], ingredients: [ing('k0', 'Zuppa base', 1, null, { ingredientId: null, subRecipeId: 'dup' }), ing('k1', 'Crostini', 4, null, { ingredientId: null, subRecipeId: 'other' })] },
      recipes[1],
    ];
    const draft = interpretUnifiedResponse(answer({ ...unified, ingredients: [{ from: '0.0' }, { from: '0.1' }] }), withSub).draft!;
    const { ingredients, leftOut } = draftToRows(draft, withSub, deps());
    expect(ingredients.map((i) => i.subRecipeId)).toEqual(['other']);
    expect(leftOut).toEqual(['Zuppa base']);
  });
});

describe('originsOf', () => {
  it('names the versions a row came from', () => {
    expect(originsOf('0.3')).toEqual(['A']);
    expect(originsOf(['1.0', '0.2', '1.4'])).toEqual(['A', 'B']);
    expect(originsOf(null)).toEqual([]);
  });
});
