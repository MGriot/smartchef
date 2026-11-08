import { describe, it, expect } from 'vitest';
import { assembleFields, diffEntity, flattenEntity, pathInfo } from './fieldPaths';

/** What the log would hold after recording `entity` from scratch. */
const recordedFrom = (entity: Record<string, unknown>) => {
  const m = new Map<string, unknown>();
  for (const [p, v] of flattenEntity(entity)) m.set(p, pathInfo(p).kind === 'member' ? true : v);
  return m;
};

describe('diffEntity', () => {
  it('records every non-empty field of a new entity, skipping bookkeeping', () => {
    const changes = diffEntity(new Map(), { id: 'r1', title: 'Pane', description: '', updated_at: 'x', tags: '["Dolce"]' });
    expect(changes).toEqual([{ path: 'title', value: 'Pane' }, { path: 'tags[]"Dolce"', value: true }]);
  });

  it('sees no change in a re-save that only spells things differently', () => {
    const before = { title: 'Pane ', tags: '["A","B"]', description: null };
    expect(diffEntity(recordedFrom(before), { title: 'Pane', tags: ['B', 'A', 'A'], description: '' })).toEqual([]);
  });

  it('tracks set members one by one', () => {
    const changes = diffEntity(recordedFrom({ tags: '["A","B"]' }), { tags: '["B","C"]' });
    expect(changes).toEqual(expect.arrayContaining([{ path: 'tags[]"C"', value: true }, { path: 'tags[]"A"', value: false }]));
    expect(changes).toHaveLength(2);
  });

  it('records a cleared field as null, and leaves a missing field alone', () => {
    const recorded = recordedFrom({ title: 'Pane', tips: 'Caldo', tags: '["A"]' });
    expect(diffEntity(recorded, { title: 'Pane', tips: '' })).toEqual([{ path: 'tips', value: null }]);
  });

  it('tracks translations per language', () => {
    const recorded = recordedFrom({ translations: [{ lang: 'en', title: 'Bread' }, { lang: 'fr', title: 'Pain' }] });
    const changes = diffEntity(recorded, { translations: [{ lang: 'en', title: 'Loaf' }] });
    expect(changes).toEqual([{ path: 'translations{}en', value: { lang: 'en', title: 'Loaf' } }, { path: 'translations{}fr', value: null }]);
  });
});

describe('assembleFields', () => {
  it('rebuilds sets in their column representation, and keyed lists', () => {
    const paths = new Map<string, unknown>([
      ['title', 'Pane'],
      ['tags[]"A"', true], ['tags[]"B"', false], ['tags[]"C"', true],
      ['toolIds[]"tool-forno"', true],
      ['translations{}en', { lang: 'en', title: 'Bread' }], ['translations{}fr', null],
    ]);
    expect(assembleFields(paths)).toEqual({
      title: 'Pane', tags: '["A","C"]', toolIds: ['tool-forno'], translations: [{ lang: 'en', title: 'Bread' }],
    });
    expect(assembleFields(paths, new Set(['title']))).toEqual({ title: 'Pane' });
  });
});
