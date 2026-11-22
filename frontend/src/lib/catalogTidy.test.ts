import { describe, it, expect } from 'vitest';
import {
  type CatalogTidyItem,
  buildCatalogProposals, catalogChangeFor, catalogProposalKinds, cleanMonths, defaultCatalogSelection, catalogSelectionKey,
} from './catalogTidy';

describe('buildCatalogProposals', () => {
  const items: CatalogTidyItem[] = [
    { id: 't1', name: 'frusta', translations: [{ lang: 'it', name: 'Frusta' }, { lang: 'fr', name: 'Couteau' }], description: null, category: null, synonyms: [] },
    { id: 't2', name: 'Whisk', translations: [] },
    { id: 't3', name: 'Chef Knife', description: 'A big knife.', category: 'Knives', synonyms: ['Cook Knife'] },
  ];

  it('renames, fills and corrects names, fills a description and a group', () => {
    const [p] = buildCatalogProposals(items.slice(0, 1).concat([{ id: 't4', name: 'Pan' }]), [{
      key: 't1', name: 'Balloon Whisk',
      translations: [{ lang: 'it', text: 'Frusta' }, { lang: 'fr', text: 'Fouet' }, { lang: 'es', text: 'Batidor' }],
      wrongTranslations: ['fr'],
      description: 'Beats cream and eggs.', descriptionWrong: false,
      category: 'Utensils',
      synonyms: ['Whip', 'frusta'],
    }]);
    expect(p.newName).toBe('Balloon Whisk');
    expect(p.addTranslations).toEqual([{ lang: 'es', text: 'Batidor' }]);
    expect(p.fixTranslations).toEqual([{ lang: 'fr', from: 'Couteau', to: 'Fouet' }]);
    expect(p.description).toEqual({ from: null, to: 'Beats cream and eggs.' });
    expect(p.category).toEqual({ from: null, to: 'Utensils' });
    expect(p.addSynonyms).toEqual(['Whip']);
  });

  it('does not rename onto another row, and keeps that rename\'s translations out', () => {
    const [p] = buildCatalogProposals(items, [{ key: 't1', name: 'Whisk', translations: [{ lang: 'es', text: 'Batidor' }] }]);
    expect(p.duplicateOf).toEqual({ id: 't2', name: 'Whisk' });
    expect(p.newName).toBeUndefined();
    expect(p.addTranslations).toEqual([]);
  });

  it('replaces a description only when the model called it wrong, and never pre-ticks that', () => {
    const kept = buildCatalogProposals(items, [{ key: 't3', description: 'A large knife.', descriptionWrong: false }]);
    expect(kept).toEqual([]);
    const [p] = buildCatalogProposals(items, [{ key: 't3', description: 'A large knife.', descriptionWrong: true }]);
    expect(p.description).toEqual({ from: 'A big knife.', to: 'A large knife.' });
    expect(defaultCatalogSelection([p]).has(catalogSelectionKey('t3', 'description'))).toBe(false);
  });

  it('keeps the group when the model agrees, case-insensitively', () => {
    expect(buildCatalogProposals(items, [{ key: 't3', category: 'knives' }])).toEqual([]);
  });

  it('proposes seasons: fills ticked, clearing not', () => {
    const rows = [{ id: 'a', name: 'Asparagus', seasonal_months: [] }, { id: 'b', name: 'Flour', seasonal_months: [3, 4] }, { id: 'c', name: 'Pear', seasonal_months: [9, 10] }];
    const proposals = buildCatalogProposals(rows, [
      { key: 'a', months: [5, 4, 4, 13] }, { key: 'b', months: [] }, { key: 'c', months: [10, 9] },
    ]);
    expect(proposals.map((p) => p.id)).toEqual(['a', 'b']);
    expect(proposals[0].months).toEqual({ from: [], to: [4, 5] });
    const selected = defaultCatalogSelection(proposals);
    expect(selected.has('a:months')).toBe(true);
    expect(selected.has('b:months')).toBe(false);
    expect(catalogChangeFor(proposals[1], new Set(['b:months']))).toEqual({ seasonalMonths: [] });
  });
});

describe('catalogChangeFor', () => {
  it('sends only the ticked kinds', () => {
    const [p] = buildCatalogProposals([{ id: 'x', name: 'pan', translations: [{ lang: 'it', name: 'Pentola' }] }], [{
      key: 'x', name: 'Frying Pan', translations: [{ lang: 'it', text: 'Padella' }, { lang: 'fr', text: 'Poêle' }], wrongTranslations: ['it'],
      synonyms: ['Skillet'],
    }]);
    expect(catalogProposalKinds(p)).toEqual(['name', 'addTranslations', 'fixTranslations', 'synonyms']);
    expect(catalogChangeFor(p, new Set(['x:name', 'x:fixTranslations']))).toEqual({ name: 'Frying Pan', translations: [{ lang: 'it', text: 'Padella' }] });
    expect(catalogChangeFor(p, new Set())).toBeNull();
  });
});

describe('cleanMonths', () => {
  it('keeps 1-12, unique and sorted', () => {
    expect(cleanMonths([12, '3', 3, 0, 1.5, 'x', 1])).toEqual([1, 3, 12]);
    expect(cleanMonths(null)).toEqual([]);
  });
});
