import { describe, it, expect } from 'vitest';
import { parseAmount, repairIngredientAmount, parseQuantityStrict, formatQuantity, formatQuantityWithUnit } from './ingredientAmount';

describe('parseAmount', () => {
  it('parses plain numbers with either decimal separator', () => {
    expect(parseAmount('200')).toBe(200);
    expect(parseAmount('1.5')).toBe(1.5);
    expect(parseAmount('1,5')).toBe(1.5);
  });

  it('parses bare fractions instead of taking the numerator', () => {
    // The old parseFirstNumber() returned 1 here — a doubled amount.
    expect(parseAmount('1/2')).toBe(0.5);
    expect(parseAmount('3/4')).toBe(0.75);
    expect(parseAmount('1 / 4')).toBe(0.25);
  });

  it('parses mixed numbers', () => {
    expect(parseAmount('1 1/2')).toBe(1.5);
    expect(parseAmount('2-1/4')).toBe(2.25);
    expect(parseAmount('1½')).toBe(1.5);
  });

  it('parses unicode vulgar fractions, which used to yield no amount at all', () => {
    expect(parseAmount('½')).toBe(0.5);
    expect(parseAmount('¼')).toBe(0.25);
    expect(parseAmount('¾')).toBe(0.75);
    expect(parseAmount('⅓')).toBe(0.3333);
  });

  it('takes the first value of a range', () => {
    expect(parseAmount('3-4')).toBe(3);
  });

  it('returns undefined when there is no number', () => {
    expect(parseAmount('q.b.')).toBeUndefined();
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
    expect(parseAmount(undefined)).toBeUndefined();
  });

  it('never divides by zero', () => {
    expect(parseAmount('1/0')).toBe(1); // falls through to the decimal match
  });
});

describe('repairIngredientAmount', () => {
  it('reunites a quantity with the denominator stranded in its notes', () => {
    // Exactly the rows in the user's library: "½ carota" imported as
    // quantity 1 + notes "/2".
    expect(repairIngredientAmount({ quantity: 1, notes: '/2' }))
      .toEqual({ quantity: 0.5, quantityText: undefined, notes: null });
  });

  it('repairs a stranded denominator embedded in a longer note', () => {
    const out = repairIngredientAmount({
      quantity: 1,
      notes: 'Per la salsa agrodolce coreana · /4 tazza',
    });
    expect(out.quantity).toBe(0.25);
    expect(out.notes).toBe('Per la salsa agrodolce coreana · tazza');
  });

  it('leaves a note that merely mentions a fraction alone', () => {
    // "1/2" here is a complete fraction inside prose, not a torn-off
    // denominator — the numerator is present, so nothing is stranded.
    const input = { quantity: 2, notes: 'cook 1/2 hour' };
    expect(repairIngredientAmount(input).quantity).toBe(2);
    expect(repairIngredientAmount(input).notes).toBe('cook 1/2 hour');
  });

  it('does not fire on a non-integer quantity', () => {
    const out = repairIngredientAmount({ quantity: 1.5, notes: '/2' });
    expect(out.quantity).toBe(1.5);
    expect(out.notes).toBe('/2');
  });

  it('does not fire when there is no quantity to pair the denominator with', () => {
    const out = repairIngredientAmount({ quantity: null, notes: '/2' });
    expect(out.quantity).toBeNull();
    expect(out.notes).toBe('/2');
  });

  it('derives a missing quantity from its free text', () => {
    expect(repairIngredientAmount({ quantity: null, quantityText: '½' }).quantity).toBe(0.5);
    expect(repairIngredientAmount({ quantity: undefined, quantityText: '1 1/2' }).quantity).toBe(1.5);
  });

  it('leaves an unparseable free-text amount as no quantity', () => {
    const out = repairIngredientAmount({ quantity: null, quantityText: 'q.b.' });
    expect(out.quantity).toBeNull();
    expect(out.quantityText).toBe('q.b.');
  });

  it('never overwrites a quantity the importer got right', () => {
    const out = repairIngredientAmount({ quantity: 200, quantityText: '200', notes: 'tritato' });
    expect(out).toEqual({ quantity: 200, quantityText: '200', notes: 'tritato' });
  });

  it('passes a clean row through untouched', () => {
    const input = { quantity: 3, quantityText: '3', notes: null };
    expect(repairIngredientAmount(input)).toEqual(input);
  });
});

describe('parseQuantityStrict', () => {
  it('accepts integers, decimals, fractions and mixed numbers', () => {
    expect(parseQuantityStrict('3')).toBe(3);
    expect(parseQuantityStrict('1,5')).toBe(1.5);
    expect(parseQuantityStrict('1.25')).toBe(1.25);
    expect(parseQuantityStrict(',5')).toBe(0.5);
    expect(parseQuantityStrict('3/4')).toBe(0.75);
    expect(parseQuantityStrict('1 1/2')).toBe(1.5);
    expect(parseQuantityStrict('½')).toBe(0.5);
    expect(parseQuantityStrict('2½')).toBe(2.5);
    expect(parseQuantityStrict(' 2 ¼ ')).toBe(2.25);
  });

  it('returns null for an empty field', () => {
    expect(parseQuantityStrict('')).toBeNull();
    expect(parseQuantityStrict('   ')).toBeNull();
    expect(parseQuantityStrict(null)).toBeNull();
  });

  it('rejects leftovers, ranges and division by zero', () => {
    expect(parseQuantityStrict('abc 5')).toBeUndefined();
    expect(parseQuantityStrict('3-4')).toBeUndefined();
    expect(parseQuantityStrict('2 eggs')).toBeUndefined();
    expect(parseQuantityStrict('1/0')).toBeUndefined();
  });
});

describe('formatQuantity', () => {
  it('writes kitchen fractions for spoons, cups and pieces', () => {
    expect(formatQuantity(0.5, 'cup')).toBe('½');
    expect(formatQuantity(1.5, 'tbsp')).toBe('1 ½');
    expect(formatQuantity(0.3333, 'tsp')).toBe('⅓');
    expect(formatQuantity(2.6667)).toBe('2 ⅔');
    expect(formatQuantity(0.75, 'pz')).toBe('¾');
  });

  it('falls back to decimals when no kitchen fraction is close', () => {
    expect(formatQuantity(2.4, 'cup')).toBe('2.4');
    expect(formatQuantity(0.1)).toBe('0.1');
  });

  it('keeps whole numbers whole, absorbing float noise', () => {
    expect(formatQuantity(3)).toBe('3');
    expect(formatQuantity(1.9999)).toBe('2');
  });

  it('writes decimals for metric weights and volumes', () => {
    expect(formatQuantity(1.5, 'kg')).toBe('1.5');
    expect(formatQuantity(250, 'g')).toBe('250');
    expect(formatQuantity(0.3333, 'l')).toBe('0.33');
    expect(formatQuantity(123.456, 'ml')).toBe('123');
  });

  it('re-chooses the form after scaling', () => {
    // 1 cup for 4 servings, read for 6: 1.5 cups.
    expect(formatQuantity(1 * 6 / 4, 'cup')).toBe('1 ½');
    expect(formatQuantityWithUnit(1 * 6 / 4, 'cup')).toBe('1 ½ cup');
    expect(formatQuantityWithUnit(2)).toBe('2');
  });
});
