import { describe, it, expect } from 'vitest';
import { healEntitySides, healIngredientsValue, unitSymbolsFromSteps } from './referenceHeal';
import { fieldValuesEqual } from '../mergeNormalize';

// Shapes taken from a real library: Windows held portable units, the phone
// had republished the same rows with its old random ids and no symbol.
const windowsRows = [
  { id: 'r1', sort_order: 0, ingredient_id: 'egg', quantity: 4, unit_id: 'unit-pz', unit_symbol: 'pz' },
  { id: 'r2', sort_order: 1, ingredient_id: 'flour', quantity: 620, unit_id: 'unit-g', unit_symbol: 'g' },
  { id: 'r3', sort_order: 2, ingredient_id: 'salt', quantity: null, unit_id: null, unit_symbol: null },
];
const phoneRows = [
  { id: 'r1', sort_order: 0, ingredient_id: 'egg', quantity: 4, unit_id: 'c81f0baf77a35a1d2ae8f7d5740c72ab' },
  { id: 'r2', sort_order: 1, ingredient_id: 'flour', quantity: 620, unit_id: '2152e3cc861f7d77969a3d8f739f4e03' },
  { id: 'r3', sort_order: 2, ingredient_id: 'salt', quantity: null, unit_id: null },
];

describe('healEntitySides — recipes', () => {
  it('makes legacy-id rows equal to the portable rows they mirror', () => {
    expect(fieldValuesEqual('ingredients', windowsRows, phoneRows)).toBe(false);
    const healed = healEntitySides('recipe', {}, { ingredients: windowsRows }, { ingredients: phoneRows });
    expect(fieldValuesEqual('ingredients', healed.local.ingredients, healed.remote.ingredients)).toBe(true);
    expect(healed.localHealed).toEqual([]);
  });

  it('flags the local side when it is the one holding unresolvable ids', () => {
    const healed = healEntitySides('recipe', {}, { ingredients: phoneRows }, { ingredients: windowsRows });
    expect(healed.localHealed).toEqual(['ingredients']);
    const rows = healed.local.ingredients as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.unit_symbol)).toEqual(['pz', 'g', undefined]);
    expect(rows[1].unit_id).toBe('unit-g');
  });

  it('matches rows by ingredient and position when row ids differ', () => {
    const renumbered = phoneRows.map((r) => ({ ...r, id: `x-${r.id}` }));
    const healed = healEntitySides('recipe', {}, { ingredients: renumbered }, { ingredients: windowsRows });
    expect(fieldValuesEqual('ingredients', healed.local.ingredients, windowsRows)).toBe(true);
  });

  it('falls back to the symbols recorded on step amounts', () => {
    const steps = [{ step_ingredients: JSON.stringify([{ unitId: '2152e3cc861f7d77969a3d8f739f4e03', unitSymbol: 'g' }]) }];
    const healed = healEntitySides('recipe', {}, { ingredients: phoneRows, steps }, {});
    const rows = healed.local.ingredients as Array<Record<string, unknown>>;
    expect(rows[1]).toMatchObject({ unit_id: 'unit-g', unit_symbol: 'g' });
    expect(rows[0].unit_symbol).toBeUndefined(); // nothing knows c81f0baf…
  });

  it('never overrides a real, resolvable difference', () => {
    const edited = windowsRows.map((r) => (r.id === 'r2' ? { ...r, unit_id: 'unit-kg', unit_symbol: 'kg', quantity: 0.62 } : r));
    const healed = healEntitySides('recipe', {}, { ingredients: edited }, { ingredients: windowsRows });
    expect(fieldValuesEqual('ingredients', healed.local.ingredients, healed.remote.ingredients)).toBe(false);
  });

  it('keeps a JSON-string value a JSON string', () => {
    const out = healIngredientsValue(JSON.stringify(phoneRows), windowsRows);
    expect(typeof out).toBe('string');
    expect(fieldValuesEqual('ingredients', out, windowsRows)).toBe(true);
  });
});

describe('healEntitySides — ingredients', () => {
  it('fills a category name the local side could not resolve', () => {
    const healed = healEntitySides(
      'ingredient',
      {},
      { category_id: 'a25e3f52e12a501384d7a74f355c1a27' },
      { category_id: 'cat-other', category_name: 'Other' },
    );
    expect(healed.local.category_name).toBe('Other');
    expect(healed.localHealed).toEqual(['category_name']);
  });

  it('leaves a deliberately cleared category alone', () => {
    const healed = healEntitySides('ingredient', {}, { category_id: null }, { category_id: 'cat-other', category_name: 'Other' });
    expect(healed.local.category_name).toBeUndefined();
    expect(healed.localHealed).toEqual([]);
  });
});

describe('unitSymbolsFromSteps', () => {
  it('ignores malformed step data', () => {
    expect(unitSymbolsFromSteps('not json', [{ step_ingredients: '{' }], null).size).toBe(0);
  });
});
