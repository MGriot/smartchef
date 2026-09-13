import { describe, it, expect } from 'vitest';
import {
  parseRefParams, formatRefParams, buildRef,
  syncIngredientRefAmount, reindexIngredientRefs,
  stepIngredientConsumption, remainingBeforeStep,
} from './stepRefs';

describe('parseRefParams', () => {
  it('reads nothing out of an absent parameter string', () => {
    expect(parseRefParams(undefined)).toEqual({});
    expect(parseRefParams('')).toEqual({});
  });

  it('reads the alias and amount directives', () => {
    expect(parseRefParams('as=la farina;q=500 g')).toEqual({ alias: 'la farina', amount: '500 g' });
  });

  it('keeps an empty amount distinct from an absent one', () => {
    expect(parseRefParams('q=')).toEqual({ amount: '' });
    expect(parseRefParams('as=la farina').amount).toBeUndefined();
  });

  it('treats anything that is not a directive as free technique params', () => {
    expect(parseRefParams('10 min/180°C')).toEqual({ free: '10 min/180°C' });
    expect(parseRefParams('as=setaccia;10 min')).toEqual({ alias: 'setaccia', free: '10 min' });
  });
});

describe('formatRefParams / buildRef', () => {
  it('round-trips', () => {
    const params = { alias: 'la farina', amount: '500 g' };
    expect(parseRefParams(formatRefParams(params))).toEqual(params);
  });

  it('emits a bare token when there is nothing to say', () => {
    expect(buildRef('ing', 3)).toBe('{{ing:3}}');
  });

  it('keeps an explicit no-amount directive', () => {
    expect(buildRef('ing', 3, { alias: 'la farina', amount: '' })).toBe('{{ing:3|as=la farina;q=}}');
  });
});

describe('syncIngredientRefAmount', () => {
  it('adds the amount to a bare reference', () => {
    expect(syncIngredientRefAmount('setaccia {{ing:10}} bene', 10, '500 g'))
      .toBe('setaccia {{ing:10|q=500 g}} bene');
  });

  it('replaces a stale amount and leaves the alias alone', () => {
    expect(syncIngredientRefAmount('{{ing:10|as=la farina;q=500 g}}', 10, '620 g'))
      .toBe('{{ing:10|as=la farina;q=620 g}}');
  });

  it('strips the amount when the step no longer pins one', () => {
    expect(syncIngredientRefAmount('{{ing:10|as=la farina;q=500 g}}', 10, null))
      .toBe('{{ing:10|as=la farina}}');
  });

  it('leaves a deliberate name-only reference alone', () => {
    const text = '{{ing:10|as=la farina;q=}}';
    expect(syncIngredientRefAmount(text, 10, '620 g')).toBe(text);
  });

  it('touches only the ingredient it was asked about', () => {
    expect(syncIngredientRefAmount('{{ing:1}} {{ing:10}} {{tool:10}}', 10, '2 tbsp'))
      .toBe('{{ing:1}} {{ing:10|q=2 tbsp}} {{tool:10}}');
  });
});

describe('reindexIngredientRefs', () => {
  it('shifts references past the removed row down by one', () => {
    expect(reindexIngredientRefs('{{ing:0}} {{ing:2|as=lo zucchero}} {{ing:3}}', 1))
      .toBe('{{ing:0}} {{ing:1|as=lo zucchero}} {{ing:2}}');
  });

  it('leaves the removed row dangling rather than editing the sentence', () => {
    expect(reindexIngredientRefs('{{ing:1}}', 1)).toBe('{{ing:1}}');
  });
});

describe('stepIngredientConsumption', () => {
  const flour = { sortOrder: 0, quantity: 620, unitSymbol: 'g' };

  it('takes a fraction of the total', () => {
    expect(stepIngredientConsumption({ ingredientSortOrder: 0, amountMode: 'fraction', portion: 0.5 }, flour)).toBe(310);
  });

  it('takes an exact amount at face value', () => {
    expect(stepIngredientConsumption({ ingredientSortOrder: 0, amountMode: 'absolute', portion: 1, quantity: 500, unitSymbol: 'g' }, flour)).toBe(500);
  });

  it('refuses to compare an exact amount in another unit', () => {
    expect(stepIngredientConsumption({ ingredientSortOrder: 0, amountMode: 'absolute', portion: 1, quantity: 150, unitSymbol: 'ml' }, flour)).toBeNull();
  });

  it('has nothing to say about an ingredient with no numeric total', () => {
    expect(stepIngredientConsumption({ ingredientSortOrder: 0, amountMode: 'fraction', portion: 0.5 }, { sortOrder: 0, quantity: null })).toBeNull();
  });
});

describe('remainingBeforeStep', () => {
  const flour = { sortOrder: 0, quantity: 620, unitSymbol: 'g' };
  const steps = [
    { stepIngredients: [{ ingredientSortOrder: 0, amountMode: 'absolute' as const, portion: 1, quantity: 500, unitSymbol: 'g' }] },
    { stepIngredients: [{ ingredientSortOrder: 0, amountMode: 'absolute' as const, portion: 1, quantity: 100, unitSymbol: 'g' }] },
    { stepIngredients: [] },
  ];

  it('is the whole total before anything has used it', () => {
    expect(remainingBeforeStep(steps, 0, flour)).toBe(620);
  });

  it('subtracts what earlier steps took', () => {
    expect(remainingBeforeStep(steps, 1, flour)).toBe(120);
    expect(remainingBeforeStep(steps, 2, flour)).toBe(20);
  });

  it('floors at zero rather than going negative', () => {
    expect(remainingBeforeStep(
      [{ stepIngredients: [{ ingredientSortOrder: 0, amountMode: 'absolute' as const, portion: 1, quantity: 900, unitSymbol: 'g' }] }],
      1, flour,
    )).toBe(0);
  });
});
