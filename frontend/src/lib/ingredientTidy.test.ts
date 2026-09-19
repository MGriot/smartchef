import { describe, it, expect } from 'vitest';
import { buildTidyProposals, type TidyIngredient, type TidySuggestion } from './ingredientTidy';

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
