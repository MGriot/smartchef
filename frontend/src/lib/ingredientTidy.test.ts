import { describe, it, expect } from 'vitest';
import {
  buildTidyProposals, changeFor, defaultSelection, isNutritionCorrection, proposalKinds, selectionKey,
  type TidyIngredient, type TidySuggestion,
} from './ingredientTidy';

const s = (key: string, name: string, extra: Partial<TidySuggestion> = {}): TidySuggestion => ({
  key, name, parent: null, parentId: null, translations: [], ...extra,
});

describe('buildTidyProposals', () => {
  const catalog: TidyIngredient[] = [
    { id: 'apple', name: 'Apple', translations: [{ lang: 'en', text: 'Apple' }, { lang: 'it', text: 'Mela' }] },
    { id: 'annurca', name: 'Annurca apples', translations: [{ lang: 'it', text: 'Mele annurca' }] },
    { id: 'pasta', name: 'pasta', translations: [] },
    { id: 'pap1', name: 'Paprika', translations: [{ lang: 'it', text: 'Paprika' }] },
    { id: 'pap2', name: 'paprica dolce', translations: [] },
  ];

  it('renames, links the parent and fills only missing languages', () => {
    const [p] = buildTidyProposals(catalog, [
      s('annurca', 'Annurca Apple', { parent: 'Apple', parentId: 'apple', translations: [
        { lang: 'en', text: 'Annurca Apple' }, { lang: 'it', text: 'Mela annurca' }, { lang: 'fr', text: 'Pomme annurca' },
      ] }),
    ]);
    expect(p.newName).toBe('Annurca Apple');
    expect(p.parentId).toBe('apple');
    // Existing "it" is kept, not overwritten.
    expect(p.addTranslations).toEqual([{ lang: 'en', text: 'Annurca Apple' }, { lang: 'fr', text: 'Pomme annurca' }]);
  });

  it('does not rename onto another ingredient’s name', () => {
    const [p] = buildTidyProposals(catalog, [s('pap2', 'Paprika', { translations: [{ lang: 'it', text: 'Paprika dolce' }] })]);
    expect(p.newName).toBeUndefined();
    expect(p.duplicateOf).toEqual({ id: 'pap1', name: 'Paprika' });
    expect(p.addTranslations).toEqual([]);
  });

  it('resolves a parent by the name another row is about to get', () => {
    const rows: TidyIngredient[] = [
      { id: 'a', name: 'apple' },
      { id: 'b', name: 'renetta' },
    ];
    const out = buildTidyProposals(rows, [s('a', 'Apple'), s('b', 'Renetta Apple', { parent: 'Apple' })]);
    expect(out.find((p) => p.id === 'b')?.parentId).toBe('a');
  });

  it('never replaces an existing parent or links a row to itself', () => {
    const rows: TidyIngredient[] = [{ id: 'x', name: 'Lemon Zest', parent_ingredient_id: 'lemon' }, { id: 'y', name: 'Lemon' }];
    const out = buildTidyProposals(rows, [s('x', 'Lemon Zest', { parent: 'Lemon', parentId: 'y' }), s('y', 'Lemon', { parent: 'Lemon', parentId: 'y' })]);
    expect(out).toEqual([]);
  });

  it('skips rows with nothing to change', () => {
    expect(buildTidyProposals(catalog, [s('apple', 'Apple', { translations: [{ lang: 'it', text: 'Mela' }] })])).toEqual([]);
  });
});

describe('buildTidyProposals — corrections and the other aspects', () => {
  const sugar: TidyIngredient = {
    id: 'sugar', name: 'Sugar', category_id: 'cat-bakery',
    // "Farina" is flour: a wrong translation the naming pass used to keep.
    translations: [{ lang: 'it', text: 'Farina' }, { lang: 'fr', text: 'Sucre' }],
    tags: [{ id: 'tag-gluten' }, { id: 'tag-sweet' }],
    calories_kcal: 387, protein_g: null, carbs_g: 10, fat_g: 0,
    synonyms: ['Granulated Sugar'],
  };

  const suggestion: TidySuggestion = {
    key: 'sugar', name: 'Sugar', parent: null, parentId: null,
    translations: [{ lang: 'it', text: 'Zucchero' }, { lang: 'fr', text: 'Sucre en poudre' }, { lang: 'es', text: 'Azúcar' }],
    // fr differs but was not flagged wrong: a wording choice, not an error.
    wrongTranslations: ['it'],
    categoryId: 'cat-pantry',
    tagIds: ['tag-sweet', 'tag-vegan'],
    wrongTagIds: ['tag-gluten'],
    nutrition: { caloriesKcal: 400, proteinG: 0, carbsG: 100, fatG: 0, sodiumMg: null },
    synonyms: ['granulated sugar', 'Table Sugar', 'Sugar'],
  };

  const [p] = buildTidyProposals([sugar], [suggestion]);

  it('replaces only the translations flagged wrong, and fills the missing ones', () => {
    expect(p.fixTranslations).toEqual([{ lang: 'it', from: 'Farina', to: 'Zucchero' }]);
    expect(p.addTranslations).toEqual([{ lang: 'es', text: 'Azúcar' }]);
  });

  it('moves the category and adds and removes tags', () => {
    expect(p.category).toEqual({ id: 'cat-pantry', fromId: 'cat-bakery' });
    expect(p.addTagIds).toEqual(['tag-vegan']);
    expect(p.removeTagIds).toEqual(['tag-gluten']);
  });

  it('fills missing nutrition and corrects only values that are clearly off', () => {
    // 387 → 400 kcal is rounding, not an error; 10 → 100 g carbs is.
    expect(p.nutrition).toEqual([
      { key: 'proteinG', from: null, to: 0 },
      { key: 'carbsG', from: 10, to: 100 },
    ]);
  });

  it('adds only synonyms that are new, case-insensitively, and never the name itself', () => {
    expect(p.addSynonyms).toEqual(['Table Sugar']);
  });

  it('leaves everything out that was not asked for', () => {
    const [onlyNames] = buildTidyProposals([sugar], [{ key: 'sugar', name: 'Caster Sugar' }]);
    expect(proposalKinds(onlyNames)).toEqual(['name']);
  });

  it('pre-selects everything except removing tags, and builds the write from what is ticked', () => {
    const selected = defaultSelection([p]);
    expect(selected.has(selectionKey('sugar', 'removeTags'))).toBe(false);
    expect(changeFor(p, selected)).toEqual({
      translations: [{ lang: 'es', text: 'Azúcar' }, { lang: 'it', text: 'Zucchero' }],
      categoryId: 'cat-pantry',
      addTagIds: ['tag-vegan'],
      nutrition: { proteinG: 0, carbsG: 100 },
      addSynonyms: ['Table Sugar'],
    });

    selected.delete(selectionKey('sugar', 'nutrition'));
    selected.add(selectionKey('sugar', 'removeTags'));
    const body = changeFor(p, selected)!;
    expect(body.nutrition).toBeUndefined();
    expect(body.removeTagIds).toEqual(['tag-gluten']);

    expect(changeFor(p, new Set())).toBeNull();
  });
});

describe('isNutritionCorrection', () => {
  it('ignores near-zero noise and small relative differences', () => {
    expect(isNutritionCorrection('fatG', 0.2, 1)).toBe(false);
    expect(isNutritionCorrection('caloriesKcal', 360, 384)).toBe(false);
    expect(isNutritionCorrection('caloriesKcal', 50, 380)).toBe(true);
    expect(isNutritionCorrection('sodiumMg', 5, 40)).toBe(false);
  });
});
