import { describe, it, expect } from 'vitest';
import { durationsIn, sumStepDurations } from './aiTiming';

describe('durationsIn', () => {
  it('reads hours and minutes written together', () => {
    expect(durationsIn('cuoci per 1 ora e 30 minuti')).toEqual([90]);
    expect(durationsIn('bake 1h30 then serve')).toEqual([90]);
    expect(durationsIn('1 h 30 min')).toEqual([90]);
    expect(durationsIn('1 hour and 15 minutes')).toEqual([75]);
    expect(durationsIn('2 heures et 10 minutes')).toEqual([130]);
  });

  it('reads plain hours and minutes', () => {
    expect(durationsIn('lascia riposare 2 ore')).toEqual([120]);
    expect(durationsIn('1,5 ore')).toEqual([90]);
    expect(durationsIn('45 min in forno, poi 10 minuti fuori')).toEqual([45, 10]);
  });

  it('does not take the next number after a joining word for minutes', () => {
    expect(durationsIn('1 ora e 2 uova')).toEqual([60]);
  });

  it('leaves words and unrelated numbers alone', () => {
    expect(durationsIn('about fifteen minutes')).toEqual([]);
    expect(durationsIn('200 g di farina')).toEqual([]);
    expect(durationsIn('3 mele')).toEqual([]);
  });
});

describe('sumStepDurations', () => {
  const durations = [10, null, 30, 5];
  it('adds the named steps', () => {
    expect(sumStepDurations(durations, [0, 2])).toBe(40);
  });
  it('refuses a step with no duration, a repeat, an unknown index or an empty list', () => {
    expect(sumStepDurations(durations, [0, 1])).toBeNull();
    expect(sumStepDurations(durations, [0, 0])).toBeNull();
    expect(sumStepDurations(durations, [9])).toBeNull();
    expect(sumStepDurations(durations, [])).toBeNull();
    expect(sumStepDurations(durations, 'all')).toBeNull();
  });
});
