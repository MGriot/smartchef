import { describe, it, expect } from 'vitest';
import { parseAmount, repairIngredientAmount } from './ingredientAmount';

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
