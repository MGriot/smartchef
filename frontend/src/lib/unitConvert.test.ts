import { describe, it, expect } from 'vitest';
import {
  convert,
  toSystem,
  normaliseMagnitude,
  roundForDisplay,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  celsiusToGasMark,
  gasMarkToCelsius,
  roundOvenTemperature,
  tinAreaCm2,
  tinScaleFactor,
} from './unitConvert';

describe('convert', () => {
  it('converts within a dimension', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(500, 'g', 'kg')).toBe(0.5);
    expect(convert(1, 'l', 'ml')).toBe(1000);
    expect(convert(1, 'lb', 'oz')).toBeCloseTo(16, 5);
  });

  it('crosses systems', () => {
    expect(convert(100, 'g', 'oz')).toBeCloseTo(3.5274, 3);
    expect(convert(1, 'cup', 'ml')).toBeCloseTo(236.588, 2);
  });

  it('accepts the catalogue’s own spellings', () => {
    // The seeded units are Italian-named; "grammi" and "g" are one unit.
    expect(convert(1, 'kilogrammi', 'grammi')).toBe(1000);
    expect(convert(1, 'litri', 'millilitri')).toBe(1000);
  });

  it('refuses to convert across dimensions', () => {
    // Grams to millilitres needs a density, which a recipe does not carry.
    expect(convert(100, 'g', 'ml')).toBeNull();
  });

  it('refuses anything countable or vague', () => {
    // "2 pz" and "q.b." must survive a conversion pass untouched.
    expect(convert(2, 'pz', 'g')).toBeNull();
    expect(convert(1, 'q.b.', 'g')).toBeNull();
    expect(convert(1, '', 'g')).toBeNull();
  });
});

describe('roundForDisplay', () => {
  it('rounds for a kitchen, not a laboratory', () => {
    expect(roundForDisplay(236.588)).toBe(237);
    expect(roundForDisplay(35.274)).toBe(35.3);
    expect(roundForDisplay(3.5274)).toBe(3.53);
    expect(roundForDisplay(0.5)).toBe(0.5);
    expect(roundForDisplay(0)).toBe(0);
  });
});

describe('toSystem', () => {
  it('picks a unit a cook would say', () => {
    expect(toSystem(1200, 'g', 'imperial')).toMatchObject({ symbol: 'lb' });
    expect(toSystem(100, 'g', 'imperial')).toMatchObject({ symbol: 'oz', value: 3.53 });
    expect(toSystem(2, 'cup', 'metric')).toMatchObject({ symbol: 'ml', value: 473 });
    expect(toSystem(8, 'cup', 'metric')).toMatchObject({ symbol: 'l' });
  });

  it('falls to the smallest unit rather than printing a fraction of a big one', () => {
    // 3 ml in imperial is 0.1 fl oz — the smallest rung, not "0.003 quart".
    expect(toSystem(3, 'ml', 'imperial')?.symbol).toBe('fl oz');
  });

  it('leaves a quantity alone when it is already in that system', () => {
    expect(toSystem(500, 'g', 'metric')).toBeNull();
    expect(toSystem(2, 'cup', 'imperial')).toBeNull();
  });

  it('leaves spoons alone in both directions', () => {
    // "1 tbsp" restated as "0.5 fl oz" helps nobody; spoons are shared
    // vocabulary, not one system's.
    expect(toSystem(1, 'tbsp', 'imperial')).toBeNull();
    expect(toSystem(1, 'tsp', 'imperial')).toBeNull();
  });

  it('leaves unknown and countable units alone', () => {
    expect(toSystem(2, 'pz', 'imperial')).toBeNull();
    expect(toSystem(1, 'q.b.', 'metric')).toBeNull();
  });
});

describe('normaliseMagnitude', () => {
  it('promotes to the readable unit', () => {
    expect(normaliseMagnitude(1200, 'g')).toMatchObject({ value: 1.2, symbol: 'kg' });
    expect(normaliseMagnitude(1500, 'ml')).toMatchObject({ value: 1.5, symbol: 'l' });
  });
  it('returns null when the unit is already right', () => {
    expect(normaliseMagnitude(400, 'g')).toBeNull();
    expect(normaliseMagnitude(0.4, 'kg')).toMatchObject({ value: 400, symbol: 'g' });
  });
});

describe('temperature', () => {
  it('is affine, not a factor', () => {
    // The classic conversion bug: 180 °C is 356 °F, not 324.
    expect(celsiusToFahrenheit(180)).toBe(356);
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(fahrenheitToCelsius(356)).toBeCloseTo(180, 6);
    expect(fahrenheitToCelsius(32)).toBe(0);
  });

  it('rounds to a setting an oven actually has', () => {
    expect(roundOvenTemperature(356)).toBe(355);
    expect(roundOvenTemperature(392.0000001)).toBe(390);
  });

  it('maps to the nearest gas mark', () => {
    expect(celsiusToGasMark(180)).toBe('4');
    expect(celsiusToGasMark(200)).toBe('6');
    expect(celsiusToGasMark(220)).toBe('7');
  });

  it('refuses to invent a gas mark outside the range', () => {
    expect(celsiusToGasMark(50)).toBeNull();
    expect(celsiusToGasMark(300)).toBeNull();
  });

  it('round-trips a gas mark', () => {
    expect(gasMarkToCelsius('4')).toBe(177);
    expect(celsiusToGasMark(gasMarkToCelsius('6')!)).toBe('6');
    expect(gasMarkToCelsius('11')).toBeNull();
  });
});

describe('tins', () => {
  it('scales by area, not by diameter', () => {
    // 20 → 23 cm is a 32% bigger cake, not 15%. Scaling by the linear
    // dimension is the mistake this exists to prevent.
    const factor = tinScaleFactor({ shape: 'round', diameterCm: 20 }, { shape: 'round', diameterCm: 23 })!;
    expect(factor).toBeCloseTo(1.32, 2);
  });

  it('compares round against rectangular', () => {
    expect(tinAreaCm2({ shape: 'round', diameterCm: 20 })).toBeCloseTo(314.16, 1);
    expect(tinAreaCm2({ shape: 'rect', widthCm: 20, lengthCm: 20 })).toBe(400);
    // A 20 cm square holds about 27% more than a 20 cm round.
    expect(tinScaleFactor({ shape: 'round', diameterCm: 20 }, { shape: 'rect', widthCm: 20, lengthCm: 20 })).toBeCloseTo(1.27, 2);
  });

  it('is symmetric', () => {
    const a = { shape: 'round', diameterCm: 20 } as const;
    const b = { shape: 'round', diameterCm: 23 } as const;
    expect(tinScaleFactor(a, b)! * tinScaleFactor(b, a)!).toBeCloseTo(1, 1);
  });

  it('never returns 0 or Infinity', () => {
    expect(tinScaleFactor({ shape: 'round', diameterCm: 0 }, { shape: 'round', diameterCm: 20 })).toBeNull();
    expect(tinScaleFactor({ shape: 'round', diameterCm: 20 }, { shape: 'rect', widthCm: 0, lengthCm: 10 })).toBeNull();
  });
});
