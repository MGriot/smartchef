import { describe, expect, it } from 'vitest';
import { deriveRecipeTimes, sumStepTimes, timeKindOf, totalStepMinutes } from './recipeTimes';

describe('timeKindOf', () => {
  it('takes the model\'s kind when it is a valid one', () => {
    expect(timeKindOf({ timeKind: 'cook', description: 'Lasciate riposare' })).toBe('cook');
    expect(timeKindOf({ timeKind: ' REST ' })).toBe('rest');
  });

  it('reads the wording when the model gave none', () => {
    expect(timeKindOf({ description: 'Cuocete in forno per 40 minuti.' })).toBe('cook');
    expect(timeKindOf({ description: 'Fate lievitare 2 ore.' })).toBe('rest');
    expect(timeKindOf({ description: 'Lasciate raffreddare la torta cotta.' })).toBe('rest');
    expect(timeKindOf({ description: 'Affettate le cipolle.' })).toBe('prep');
    expect(timeKindOf({ timeKind: 'whatever', description: 'Simmer for 20 minutes' })).toBe('cook');
  });
});

describe('deriveRecipeTimes', () => {
  const steps = [
    { durationMin: 10, timeKind: 'prep' },
    { durationMin: 25, timeKind: 'cook' },
    { durationMin: 15, timeKind: 'cook' },
    { durationMin: 60, timeKind: 'rest' },
    { durationMin: null, timeKind: 'cook' },
  ];

  it('adds up the steps of each kind when the recipe states no time', () => {
    expect(deriveRecipeTimes({}, steps)).toEqual({ prepTimeMin: 10, cookTimeMin: 40, restTimeMin: 60 });
  });

  it('never replaces a time the recipe states', () => {
    expect(deriveRecipeTimes({ cookTimeMin: 90 }, steps)).toEqual({ prepTimeMin: 10, cookTimeMin: 90, restTimeMin: 60 });
  });

  it('leaves a kind empty when no step has a duration of it', () => {
    expect(deriveRecipeTimes({}, [{ durationMin: 20, timeKind: 'cook' }])).toEqual({
      prepTimeMin: undefined, cookTimeMin: 20, restTimeMin: undefined,
    });
    expect(deriveRecipeTimes({}, [{ description: 'Mescolate.' }])).toEqual({
      prepTimeMin: undefined, cookTimeMin: undefined, restTimeMin: undefined,
    });
  });

  it('ignores zero, negative and non-numeric durations', () => {
    expect(sumStepTimes([{ durationMin: 0 }, { durationMin: -5 }, { durationMin: NaN }])).toEqual({
      prepTimeMin: 0, cookTimeMin: 0, restTimeMin: 0,
    });
  });
});

describe('totalStepMinutes', () => {
  it('sums durations in either spelling', () => {
    expect(totalStepMinutes([{ durationMin: 10 }, { duration_min: 20 }, { duration_min: null }])).toBe(30);
    expect(totalStepMinutes([])).toBe(0);
  });
});
