import { describe, it, expect } from 'vitest';
import { diffLines } from './lineDiff';

describe('diffLines', () => {
  it('marks everything "same" for identical arrays', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('marks a pure addition as "added"', () => {
    expect(diffLines(['a'], ['a', 'b'])).toEqual([
      { type: 'same', text: 'a' },
      { type: 'added', text: 'b' },
    ]);
  });

  it('marks a pure removal as "removed"', () => {
    expect(diffLines(['a', 'b'], ['a'])).toEqual([
      { type: 'same', text: 'a' },
      { type: 'removed', text: 'b' },
    ]);
  });

  it('represents an edited line as remove-then-add, keeping unrelated lines "same"', () => {
    const result = diffLines(
      ['Preheat oven', 'Brown the beef', 'Bake'],
      ['Preheat oven', 'Brown the beef with garlic', 'Bake']
    );
    expect(result).toEqual([
      { type: 'same', text: 'Preheat oven' },
      { type: 'removed', text: 'Brown the beef' },
      { type: 'added', text: 'Brown the beef with garlic' },
      { type: 'same', text: 'Bake' },
    ]);
  });

  it('handles two empty arrays', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('handles completely disjoint arrays', () => {
    expect(diffLines(['x', 'y'], ['p', 'q'])).toEqual([
      { type: 'removed', text: 'x' },
      { type: 'removed', text: 'y' },
      { type: 'added', text: 'p' },
      { type: 'added', text: 'q' },
    ]);
  });
});
