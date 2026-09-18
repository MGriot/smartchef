import { describe, it, expect } from 'vitest';
import { fieldValuesEqual, isEmptyValue, mergeKeyedList, mergeSetField, parseTimestamp } from './mergeNormalize';

describe('fieldValuesEqual', () => {
  it('treats every spelling of empty as the same value', () => {
    for (const a of [null, undefined, '', '   ', '[]', []]) {
      for (const b of [null, undefined, '', '[]', []]) {
        expect(fieldValuesEqual('description', a, b)).toBe(true);
      }
    }
  });

  it('ignores surrounding whitespace and line-ending style in text', () => {
    expect(fieldValuesEqual('tips', 'line one\r\nline two ', 'line one\nline two')).toBe(true);
  });

  it('compares set fields by members, whether stored as a JSON string or an array', () => {
    expect(fieldValuesEqual('tags', '["Vegano","Salsa"]', ['Salsa', 'Vegano'])).toBe(true);
    expect(fieldValuesEqual('tags', '["Vegano","Salsa","Salsa"]', '["Salsa", "Vegano"]')).toBe(true);
    expect(fieldValuesEqual('tags', '["Vegano"]', '["Salsa"]')).toBe(false);
  });

  it('sees two devices serializing the same steps as equal despite ids, created_at and row order', () => {
    const deviceA = [
      { id: 'a2', recipe_id: 'r', step_number: 2, description: 'Bake', tool_ids: '["oven"]', created_at: '2026-09-01 10:00:00' },
      { id: 'a1', recipe_id: 'r', step_number: 1, description: 'Mix', tool_ids: '[]', created_at: '2026-09-01 10:00:00' },
    ];
    const deviceB = [
      { id: 'b1', recipe_id: 'r', step_number: 1, description: 'Mix', tool_ids: '[]', notes: null, created_at: '2026-09-17 22:00:00' },
      { id: 'b2', recipe_id: 'r', step_number: 2, description: 'Bake ', tool_ids: ['oven'], notes: '', created_at: '2026-09-17 22:00:00' },
    ];
    expect(fieldValuesEqual('steps', deviceA, deviceB)).toBe(true);
  });

  it('still sees a real step edit', () => {
    const before = [{ id: 'x', step_number: 1, description: 'Mix' }];
    const after = [{ id: 'y', step_number: 1, description: 'Mix well' }];
    expect(fieldValuesEqual('steps', before, after)).toBe(false);
  });

  it('compares recipe ingredient units by symbol, not by the per-device unit id', () => {
    const a = [{ id: '1', sort_order: 0, ingredient_id: 'flour', quantity: 200, unit_id: 'unit-on-a', unit_symbol: 'g' }];
    const b = [{ id: '2', sort_order: 0, ingredient_id: 'flour', quantity: 200, unit_id: 'unit-on-b', unit_symbol: 'g' }];
    expect(fieldValuesEqual('ingredients', a, b)).toBe(true);
    const c = [{ id: '3', sort_order: 0, ingredient_id: 'flour', quantity: 200, unit_id: 'unit-on-b', unit_symbol: 'kg' }];
    expect(fieldValuesEqual('ingredients', a, c)).toBe(false);
  });

  it('treats a boolean and its 0/1 spelling alike', () => {
    expect(fieldValuesEqual('is_component', true, 1)).toBe(true);
  });
});

describe('isEmptyValue', () => {
  it('knows a JSON-string empty list is empty', () => {
    expect(isEmptyValue('[]')).toBe(true);
    expect(isEmptyValue('["x"]')).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
  });
});

describe('mergeSetField', () => {
  it('keeps additions from both sides and removals from either side', () => {
    const base = '["a","b","c"]';
    const local = '["a","b","c","local-add"]'; // added one
    const remote = '["a","c","remote-add"]'; // removed b, added one
    expect(JSON.parse(mergeSetField(base, local, remote, true) as string)).toEqual(['a', 'c', 'local-add', 'remote-add']);
  });

  it('is the union when there is no common ancestor', () => {
    expect(mergeSetField(null, ['x', 'y'], ['y', 'z'], false)).toEqual(['x', 'y', 'z']);
  });

  it('writes back in the local side’s representation', () => {
    expect(typeof mergeSetField(null, '["x"]', ['y'], false)).toBe('string');
    expect(Array.isArray(mergeSetField(null, ['x'], '["y"]', false))).toBe(true);
  });
});

describe('parseTimestamp', () => {
  it('reads SQLite CURRENT_TIMESTAMP as UTC', () => {
    expect(parseTimestamp('2026-09-18 10:00:00')).toBe(Date.UTC(2026, 8, 18, 10, 0, 0));
  });

  it('reads ISO strings with a zone as-is', () => {
    expect(parseTimestamp('2026-09-18T10:00:00+02:00')).toBe(Date.UTC(2026, 8, 18, 8, 0, 0));
  });

  it('is null for anything unusable', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('not a date')).toBeNull();
  });
});

describe('mergeKeyedList (translations)', () => {
  const it_ = { lang: 'it', title: 'Lasagna' };
  const en = { lang: 'en', title: 'Lasagne' };
  const fr = { lang: 'fr', title: 'Lasagnes' };

  it('keeps a language added on each side', () => {
    const r = mergeKeyedList('translations', [it_], [it_, en], [it_, fr], true);
    expect(r.conflicts).toEqual([]);
    expect(r.value).toEqual([en, fr, it_]);
  });

  it('takes the side that changed an entry, and honours a removal', () => {
    const r = mergeKeyedList('translations', [it_, en], [it_, { lang: 'en', title: 'Lasagna (EN)' }], [it_], true);
    // local edited "en", remote removed it: both changed "en" differently.
    expect(r.conflicts).toEqual(['en']);
    const removedOnly = mergeKeyedList('translations', [it_, en], [it_, en], [it_], true);
    expect(removedOnly.value).toEqual([it_]);
  });

  it('with a pick, settles only the disputed entries', () => {
    const r = mergeKeyedList('translations', [it_], [{ lang: 'it', title: 'A' }, en], [{ lang: 'it', title: 'B' }], true, 'remote');
    expect(r.conflicts).toEqual([]);
    expect(r.value).toEqual([en, { lang: 'it', title: 'B' }]);
  });

  it('compares translations by language regardless of order', () => {
    expect(fieldValuesEqual('translations', [it_, en], [en, it_])).toBe(true);
  });
});
