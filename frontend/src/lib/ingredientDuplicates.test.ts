import { describe, it, expect } from 'vitest';
import { findDuplicateIngredients, type DuplicateCandidate } from './ingredientDuplicates';

const ing = (id: string, name: string, translations: Record<string, string> = {}, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id, name, translations: Object.entries(translations).map(([lang, text]) => ({ lang, text })), ...extra,
});

describe('findDuplicateIngredients', () => {
  it("folds an Italian-named ingredient into the English entry it translates", () => {
    const out = findDuplicateIngredients([ing('salt', 'Salt', { it: 'Sale', fr: 'Sel' }), ing('sale', 'Sale')], 'it');
    expect(out).toEqual([expect.objectContaining({ sourceId: 'sale', targetId: 'salt', reason: 'translation', lang: 'it', recommended: true })]);
  });

  it('keeps the better-translated copy of a same-name duplicate', () => {
    const out = findDuplicateIngredients([ing('w1', 'Water'), ing('w2', 'water', { it: 'Acqua' })], 'it');
    expect(out).toEqual([expect.objectContaining({ sourceId: 'w1', targetId: 'w2', reason: 'same-name', recommended: true })]);
  });

  it('proposes but does not pre-select a match only in another language', () => {
    const out = findDuplicateIngredients([ing('brandy', 'Brandy', { fr: 'Cognac' }), ing('cognac', 'Cognac')], 'it');
    expect(out).toEqual([expect.objectContaining({ sourceId: 'cognac', targetId: 'brandy', recommended: false })]);
  });

  it('leaves a name that translates two different ingredients alone', () => {
    const out = findDuplicateIngredients([ing('shallot', 'Shallot', { fr: 'Échalote' }), ing('leek', 'Leek', { fr: 'Échalote' }), ing('x', 'Échalote')], 'it');
    expect(out).toEqual([]);
  });

  it('never folds a variety into its general ingredient', () => {
    const out = findDuplicateIngredients([ing('apple', 'Apple', { it: 'Mela renetta' }), ing('renetta', 'Mela renetta', {}, { parent_ingredient_id: 'apple' })], 'it');
    expect(out).toEqual([]);
  });
});
