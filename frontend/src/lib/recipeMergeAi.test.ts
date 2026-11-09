import { describe, it, expect } from 'vitest';
import {
  buildMergeManyRequest, defaultTicked, interpretMergeManyResponse, itemKey, picksFor,
  type MergeAiRecipe,
} from './recipeMergeAi';

const ing = (id: string, label: string) => ({ id, label, quantity: null, unit: null, notes: null });
const step = (id: string, text: string) => ({ id, title: null, text, durationMin: null });

const recipes: MergeAiRecipe[] = [
  { id: 'keep', title: 'Torta', ingredients: [ing('k0', 'Farina'), ing('k1', 'Uova')], steps: [step('ks0', 'Mescolate.')] },
  { id: 'a', title: 'Torta (2)', ingredients: [ing('a0', 'Farina'), ing('a1', 'Limone')], steps: [step('as0', 'Mescolate bene.'), step('as1', 'Infornate.')] },
  { id: 'b', title: 'Torta (3)', ingredients: [ing('b0', 'Pubblicità')], steps: [] },
];

describe('interpretMergeManyResponse', () => {
  it('lists every row of the copies, and none of the kept recipe', () => {
    const { items } = interpretMergeManyResponse({}, recipes);
    expect(items).toHaveLength(2 + 2 + 1);
    expect(items.every((i) => i.recipeIndex >= 1)).toBe(true);
  });

  it('turns whatever the model leaves out into a keep, so nothing vanishes', () => {
    const { items } = interpretMergeManyResponse({ ingredients: [{ ref: '1.0', action: 'duplicate', of: '0.0', reason: 'Same flour' }] }, recipes);
    expect(items.find((i) => i.rowId === 'a0')?.action).toBe('duplicate');
    expect(items.filter((i) => i.rowId !== 'a0').every((i) => i.action === 'keep' && !i.judged)).toBe(true);
  });

  it('refuses a duplicate that points nowhere, at itself, or a drop without a reason', () => {
    const { items } = interpretMergeManyResponse({
      ingredients: [
        { ref: '1.0', action: 'duplicate', of: '9.9', reason: 'x' },
        { ref: '1.1', action: 'duplicate', of: '1.1', reason: 'x' },
        { ref: '2.0', action: 'drop', reason: '' },
      ],
    }, recipes);
    expect(items.filter((i) => i.group === 'ingredients').map((i) => i.action)).toEqual(['keep', 'keep', 'keep']);
  });

  it('accepts a drop that states why, and ignores unknown references', () => {
    const { items } = interpretMergeManyResponse({
      ingredients: [{ ref: '2.0', action: 'drop', reason: 'Not an ingredient' }, { ref: '7.1', action: 'drop', reason: 'x' }, { ref: 'junk', action: 'drop', reason: 'x' }],
    }, recipes);
    const dropped = items.find((i) => i.rowId === 'b0')!;
    expect(dropped.action).toBe('drop');
    expect(dropped.reason).toBe('Not an ingredient');
    expect(items.filter((i) => i.action === 'drop')).toHaveLength(1);
  });

  it('never lets the model judge the kept recipe', () => {
    const { items } = interpretMergeManyResponse({ ingredients: [{ ref: '0.0', action: 'drop', reason: 'x' }] }, recipes);
    expect(items.some((i) => i.rowId === 'k0')).toBe(false);
  });
});

describe('ticking', () => {
  it('opens with only the rows the model called keep ticked', () => {
    const { items } = interpretMergeManyResponse({
      ingredients: [{ ref: '1.0', action: 'duplicate', of: '0.0', reason: 'Same' }],
      steps: [{ ref: '1.0', action: 'duplicate', of: '0.0', reason: 'Same' }],
    }, recipes);
    const ticked = defaultTicked(items);
    expect(ticked.has('ingredients:1.0')).toBe(false);
    expect(ticked.has('ingredients:1.1')).toBe(true);
    expect(ticked.has('steps:1.1')).toBe(true);
  });

  it('turns ticked rows into the ids to carry over, per copy', () => {
    const { items } = interpretMergeManyResponse({}, recipes);
    const ticked = new Set(items.filter((i) => i.rowId !== 'a1').map(itemKey));
    expect(picksFor(recipes, items, ticked)).toEqual([
      { sourceId: 'a', ingredientIds: ['a0'], stepIds: ['as0', 'as1'] },
      { sourceId: 'b', ingredientIds: ['b0'], stepIds: [] },
    ]);
  });
});

describe('buildMergeManyRequest', () => {
  it('marks the first recipe as the kept one and numbers rows by recipe.row', () => {
    const req = buildMergeManyRequest(recipes);
    expect(req.recipes[0].kept).toBe(true);
    expect(req.recipes[1].ingredients[1].ref).toBe('1.1');
  });
});
