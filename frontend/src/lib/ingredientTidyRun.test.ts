import { describe, it, expect } from 'vitest';
import type { TidyIngredient } from './ingredientTidy';
import {
  isRetryableTidyStatus, isTidyAspectComplete, planTidyRun, tidyBatchSize, tidyBatches, tidyContentHashes,
} from './ingredientTidyRun';

const LANGS = ['it', 'de'];
const ALL = { naming: true, classification: true, nutrition: true, synonyms: true };
const NAMING = { naming: true, classification: false, nutrition: false, synonyms: false };

const full: TidyIngredient = {
  id: 'full', name: 'Sugar', category_id: 'c1',
  translations: [{ lang: 'it', text: 'Zucchero' }, { lang: 'de', text: 'Zucker' }],
  tags: [{ id: 't1' }],
  calories_kcal: 387, protein_g: 0, carbs_g: 100, fat_g: 0, fiber_g: 0, sugar_g: 100, sodium_mg: 1,
  synonyms: ['Table Sugar'],
};
const bare: TidyIngredient = { id: 'bare', name: 'Flour', category_id: 'c1' };

describe('tidy run planning', () => {
  it('sizes batches by how much is asked of each row', () => {
    expect(tidyBatchSize(NAMING)).toBe(40);
    expect(tidyBatchSize(ALL)).toBe(20);
    const ids = Array.from({ length: 45 }, (_, i) => `i${i}`);
    expect(tidyBatches(ids, ALL).map((b) => b.length)).toEqual([20, 20, 5]);
    expect(tidyBatches(ids, NAMING).map((b) => b.length)).toEqual([40, 5]);
  });

  it('retries a busy provider, never a refusal', () => {
    expect([429, 500, 503, 504].every(isRetryableTidyStatus)).toBe(true);
    expect([400, 401, 502].some(isRetryableTidyStatus)).toBe(false);
  });

  it('judges completeness per aspect', () => {
    for (const aspect of ['naming', 'classification', 'nutrition', 'synonyms'] as const) {
      expect(isTidyAspectComplete(full, aspect, LANGS)).toBe(true);
      expect(isTidyAspectComplete(bare, aspect, LANGS)).toBe(false);
    }
    // A category this device does not have is "uncategorized".
    expect(isTidyAspectComplete(full, 'classification', LANGS, new Set(['other']))).toBe(false);
    // A language added to the library makes the naming incomplete again.
    expect(isTidyAspectComplete(full, 'naming', [...LANGS, 'pt'])).toBe(false);
  });

  it('skips complete rows and rows unchanged since their review', () => {
    const reviewed = new Map([['bare', { naming: tidyContentHashes(bare, LANGS).naming }]]);
    const plan = planTidyRun([full, bare], reviewed, NAMING, LANGS);
    expect(plan).toEqual({ pendingIds: [], complete: 1, unchanged: 1 });

    // Renamed since: its naming review no longer counts.
    const renamed = { ...bare, name: 'Wheat Flour' };
    expect(planTidyRun([renamed], reviewed, NAMING, LANGS).pendingIds).toEqual(['bare']);
    // Reviewed for naming only: still pending when nutrition is asked too.
    expect(planTidyRun([bare], reviewed, { ...NAMING, nutrition: true }, LANGS).pendingIds).toEqual(['bare']);
  });

  it('sends everything when forced, and nothing when no aspect is asked', () => {
    expect(planTidyRun([full, bare], new Map(), ALL, LANGS, { force: true }).pendingIds).toEqual(['full', 'bare']);
    expect(planTidyRun([bare], new Map(), {}, LANGS).pendingIds).toEqual([]);
  });

  it('hashes only what an aspect looks at', () => {
    const before = tidyContentHashes(full, LANGS);
    const after = tidyContentHashes({ ...full, calories_kcal: 400 }, LANGS);
    expect(after.nutrition).not.toBe(before.nutrition);
    expect(after.naming).toBe(before.naming);
    expect(after.classification).toBe(before.classification);
    // Order of tags and translations does not matter.
    const shuffled = { ...full, translations: [...full.translations!].reverse() };
    expect(tidyContentHashes(shuffled, LANGS).naming).toBe(before.naming);
  });
});
