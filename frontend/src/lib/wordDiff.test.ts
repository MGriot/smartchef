import { describe, it, expect } from 'vitest';
import { diffWords, editDistance } from './wordDiff';

describe('diffWords', () => {
  it('marks only the changed words and rebuilds both sides', () => {
    const parts = diffWords('mix the zuchero well', 'mix the zucchero well');
    expect(parts.filter((p) => p.type === 'del').map((p) => p.text)).toEqual(['zuchero']);
    expect(parts.filter((p) => p.type === 'add').map((p) => p.text)).toEqual(['zucchero']);
    expect(parts.filter((p) => p.type !== 'add').map((p) => p.text).join('')).toBe('mix the zuchero well');
    expect(parts.filter((p) => p.type !== 'del').map((p) => p.text).join('')).toBe('mix the zucchero well');
  });

  it('shows a pure addition as add only', () => {
    expect(diffWords('', '200 g').map((p) => p.type)).toEqual(['add']);
  });
});

describe('editDistance', () => {
  it('counts single-letter edits', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'abc')).toBe(0);
  });
});
