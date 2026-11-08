import { describe, expect, it } from 'vitest';
import { parseMinutes } from './parseMinutes';

describe('parseMinutes', () => {
  it('keeps a number of minutes', () => {
    expect(parseMinutes(45)).toBe(45);
    expect(parseMinutes(0)).toBe(0);
  });

  it('reads numeric strings', () => {
    expect(parseMinutes('30')).toBe(30);
    expect(parseMinutes(' 25 ')).toBe(25);
  });

  it('reads hours and minutes in English and Italian', () => {
    expect(parseMinutes('1h 30')).toBe(90);
    expect(parseMinutes('1h30m')).toBe(90);
    expect(parseMinutes('2 hours')).toBe(120);
    expect(parseMinutes('1 ora e 30 minuti')).toBe(90);
    expect(parseMinutes('45 min')).toBe(45);
    expect(parseMinutes('3 ore')).toBe(180);
  });

  it('reads days and weeks', () => {
    expect(parseMinutes('2 days')).toBe(2880);
    expect(parseMinutes('1 settimana')).toBe(10080);
  });

  it('reads ISO 8601 durations', () => {
    expect(parseMinutes('PT1H30M')).toBe(90);
    expect(parseMinutes('PT45M')).toBe(45);
    expect(parseMinutes('P1DT2H')).toBe(1560);
  });

  it('gives up on what is not a duration', () => {
    expect(parseMinutes('q.b.')).toBeUndefined();
    expect(parseMinutes('about an hour or so')).toBeUndefined();
    expect(parseMinutes(null)).toBeUndefined();
    expect(parseMinutes(-5)).toBeUndefined();
    expect(parseMinutes('')).toBeUndefined();
  });
});
