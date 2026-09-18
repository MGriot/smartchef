import { describe, it, expect } from 'vitest';
import { mergeSuggestions, defaultResolution } from './importMatching';
import type { MatchSuggestion } from './fuzzyMatch';

const s = (id: string, name: string, score: number): MatchSuggestion => ({ id, name, score });

describe('mergeSuggestions', () => {
  // The regression guard that matters most. Every non-AI import path (the
  // text template, the structured-data extractor, the migration adapters)
  // and every AI import where the model claimed nothing must come out of
  // this exactly as it went in.
  it('returns the name matches untouched when there is no catalog claim', () => {
    const byName = [s('a', 'Butter', 0.9), s('b', 'Buttermilk', 0.55)];
    expect(mergeSuggestions(byName, [])).toEqual(byName);
  });

  it('still caps at the limit with no catalog claim', () => {
    const byName = [s('a', 'A', 0.9), s('b', 'B', 0.8), s('c', 'C', 0.7), s('d', 'D', 0.6)];
    expect(mergeSuggestions(byName, []).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was given', () => {
    const byName = [s('a', 'Butter', 0.5)];
    mergeSuggestions(byName, [s('b', 'Stand Mixer', 1)]);
    expect(byName).toEqual([s('a', 'Butter', 0.5)]);
  });

  // The whole point of the feature: "planetaria" scores near-nothing
  // against "Stand Mixer" by string similarity, and the AI's claim puts it
  // at the top where defaultResolution will pre-select it.
  it('lets a catalog-claimed match outrank a weak name match, and badges it', () => {
    const merged = mergeSuggestions([s('a', 'Pan', 0.55)], [s('b', 'Stand Mixer', 1)]);
    expect(merged.map((x) => x.id)).toEqual(['b', 'a']);
    expect(merged[0].viaCatalog).toBe(true);
    expect(merged[1].viaCatalog).toBeUndefined();
  });

  it('dedupes a row both probes found, keeping the better score', () => {
    const merged = mergeSuggestions([s('a', 'Butter', 0.62)], [s('a', 'Butter', 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(1);
  });

  // Not badged: the name match found it on its own, so there is nothing
  // the user would be surprised to see selected.
  it('does not badge a row the name match had already found', () => {
    expect(mergeSuggestions([s('a', 'Butter', 0.9)], [s('a', 'Butter', 1)])[0].viaCatalog).toBeUndefined();
  });

  it('keeps the higher score when the name match is the better of the two', () => {
    const merged = mergeSuggestions([s('a', 'Butter', 0.95)], [s('a', 'Butter', 0.8)]);
    expect(merged[0].score).toBe(0.95);
  });

  it('caps the merged list at the limit', () => {
    const byName = [s('a', 'A', 0.9), s('b', 'B', 0.8), s('c', 'C', 0.7)];
    const merged = mergeSuggestions(byName, [s('d', 'D', 1)]);
    expect(merged.map((x) => x.id)).toEqual(['d', 'a', 'b']);
  });
});

describe('defaultResolution', () => {
  it('creates new when there is nothing to match', () => {
    expect(defaultResolution([])).toEqual({ choice: 'new' });
  });

  it('pre-selects a confident match', () => {
    expect(defaultResolution([s('a', 'Butter', 0.95)])).toEqual({ choice: 'existing', id: 'a', name: 'Butter' });
  });

  // The 0.7 floor is exclusive and must stay that way — it is the same
  // threshold the server-side write matcher uses.
  it('treats exactly 0.7 as not confident enough', () => {
    expect(defaultResolution([s('a', 'Sage', 0.7)])).toEqual({ choice: 'new' });
    expect(defaultResolution([s('a', 'Sage', 0.71)]).choice).toBe('existing');
  });

  it('pre-selects a catalog-claimed match, since it scores 1.0', () => {
    const merged = mergeSuggestions([], [s('b', 'Stand Mixer', 1)]);
    expect(defaultResolution(merged)).toEqual({ choice: 'existing', id: 'b', name: 'Stand Mixer' });
  });
});
