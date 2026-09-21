import { describe, it, expect } from 'vitest';
import { durationParts, formatDurationWith } from './duration';

// A fake `t` that renders the key and count, so these assertions are about
// which UNITS get picked rather than about any particular wording.
const t = (key: string, options?: Record<string, unknown>) => `${options?.count}${key.replace('duration.', '')}`;

describe('durationParts', () => {
  it('leaves an ordinary recipe in minutes', () => {
    expect(durationParts(15)).toEqual([{ unit: 'minute', count: 15 }]);
    expect(durationParts(59)).toEqual([{ unit: 'minute', count: 59 }]);
  });

  it('rolls up to hours, dropping a zero remainder', () => {
    expect(durationParts(90)).toEqual([{ unit: 'hour', count: 1 }, { unit: 'minute', count: 30 }]);
    expect(durationParts(120)).toEqual([{ unit: 'hour', count: 2 }]);
  });

  it('rolls up to days once past 24 hours', () => {
    // The actual complaint: a 15-day maceration read as "360h".
    expect(durationParts(21600)).toEqual([{ unit: 'week', count: 2 }, { unit: 'day', count: 1 }]);
    expect(durationParts(60 * 24)).toEqual([{ unit: 'day', count: 1 }]);
    expect(durationParts(60 * 30)).toEqual([{ unit: 'day', count: 1 }, { unit: 'hour', count: 6 }]);
  });

  it('rolls up to weeks, and never invents a month', () => {
    // Months are ambiguous (28? 30? 31?) in a way the other units are not,
    // so a long ferment stays in weeks rather than guessing.
    expect(durationParts(60 * 24 * 7)).toEqual([{ unit: 'week', count: 1 }]);
    expect(durationParts(60 * 24 * 45)).toEqual([{ unit: 'week', count: 6 }, { unit: 'day', count: 3 }]);
    expect(durationParts(60 * 24 * 90).every((p) => p.unit !== 'month' as never)).toBe(true);
  });

  it('shows at most two units', () => {
    // 15 days, 4 hours, 22 minutes — a cook does not need the tail.
    expect(durationParts(60 * 24 * 15 + 60 * 4 + 22)).toHaveLength(2);
  });

  it('treats zero and nonsense as nothing', () => {
    expect(durationParts(0)).toEqual([]);
    expect(durationParts(-5)).toEqual([]);
  });

  it('rounds a fractional minute rather than rendering it', () => {
    expect(durationParts(90.4)).toEqual([{ unit: 'hour', count: 1 }, { unit: 'minute', count: 30 }]);
  });
});

describe('formatDurationWith', () => {
  it('joins the parts', () => {
    expect(formatDurationWith(t, 90)).toBe('1hour 30minute');
  });

  it('uses the compact forms for the stats cards', () => {
    expect(formatDurationWith(t, 90, { short: true })).toBe('1hourShort 30minuteShort');
  });

  it('renders an em dash for nothing, which is what the cards showed before', () => {
    expect(formatDurationWith(t, null)).toBe('—');
    expect(formatDurationWith(t, undefined)).toBe('—');
    expect(formatDurationWith(t, 0)).toBe('—');
  });

  it('takes a caller-chosen empty string', () => {
    expect(formatDurationWith(t, null, { empty: '' })).toBe('');
  });
});
