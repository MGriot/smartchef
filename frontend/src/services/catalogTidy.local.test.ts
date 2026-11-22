import { describe, it, expect } from 'vitest';
import { buildCatalogTidyPrompt, normalizeCatalogTidy, normalizeSeasonality, type CatalogTidyContext } from './catalogTidy.local';
import { drawingPrompt } from './catalogDrawings.local';

const ctx = (over: Partial<CatalogTidyContext> = {}): CatalogTidyContext => ({
  kind: 'tools',
  aspects: { naming: true, description: true, category: true, synonyms: true },
  langs: ['it'],
  catalogNames: ['Whisk'],
  categoryNames: ['Utensils'],
  ...over,
});

describe('normalizeCatalogTidy', () => {
  it('keeps known keys, asked aspects and the existing group spelling', () => {
    const out = normalizeCatalogTidy({
      items: [
        { key: 'a', name: ' Whisk ', translations: { it: 'Frusta', de: 'Schneebesen' }, wrongTranslations: ['IT', 'de'], description: 'Beats.', descriptionWrong: 'yes', category: 'utensils', synonyms: ['Whisk', 'Whip', 'Whip'] },
        { key: 'zzz', name: 'Ghost' },
      ],
    }, [{ key: 'a', text: 'frusta' }], ctx());
    expect(out).toEqual([{
      key: 'a', name: 'Whisk', translations: [{ lang: 'it', text: 'Frusta' }], wrongTranslations: ['it'],
      description: 'Beats.', descriptionWrong: false, category: 'Utensils', synonyms: ['Whip'],
    }]);
  });

  it('returns nothing for aspects that were not asked, and nothing but names for units', () => {
    const [r] = normalizeCatalogTidy({ items: [{ key: 'u', name: 'Gram', description: 'x', synonyms: ['g'], category: 'Mass' }] },
      [{ key: 'u', text: 'grammo', symbol: 'g' }],
      ctx({ kind: 'units' }));
    expect(r).toEqual({ key: 'u', name: 'Gram', translations: [], wrongTranslations: [] });
  });

  it('drops an essay of a description', () => {
    const [r] = normalizeCatalogTidy({ items: [{ key: 'a', description: 'x'.repeat(500) }] }, [{ key: 'a', text: 'A' }], ctx({ aspects: { naming: false, description: true, category: false, synonyms: false } }));
    expect(r.description).toBeNull();
  });
});

describe('prompts', () => {
  it('never asks a unit for a description or a tool group of a technique', () => {
    const units = buildCatalogTidyPrompt(ctx({ kind: 'units' }));
    expect(units).toContain('never change it');
    expect(units).not.toContain('"description"');
    expect(buildCatalogTidyPrompt(ctx({ kind: 'techniques' }))).not.toContain('"category"');
  });

  it('asks a drawing to match the reference style only when there is one', () => {
    expect(drawingPrompt('ingredients', 'Lemon')).toContain('attached reference');
    expect(drawingPrompt('tools', 'Whisk', null, false)).toContain('watercolor');
    expect(drawingPrompt('techniques', 'Julienne')).toContain('being done');
  });
});

describe('normalizeSeasonality', () => {
  it('keeps valid months per known key', () => {
    expect(normalizeSeasonality({ items: [{ key: 'a', months: [6, '7', 13, 6] }, { key: 'b' }, { key: 'x', months: [1] }] }, [{ key: 'a', text: 'Cherry' }, { key: 'b', text: 'Flour' }]))
      .toEqual([{ key: 'a', months: [6, 7] }]);
  });
});
