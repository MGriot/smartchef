import { describe, it, expect } from 'vitest';
import { sortLibraryItems, isLibrarySortKey, DEFAULT_SORT, type LibrarySortKey } from './librarySort';

interface Row {
  name: string;
  category?: string | null;
  created_at?: string | null;
}

const accessors = {
  label: (r: Row) => r.name,
  group: (r: Row) => r.category,
  createdAt: (r: Row) => r.created_at,
};

const names = (rows: Row[]) => rows.map((r) => r.name);

describe('sortLibraryItems', () => {
  const rows: Row[] = [
    { name: 'Whisk', category: 'Prep', created_at: '2026-03-01 10:00:00' },
    { name: 'Blender', category: 'Appliance', created_at: '2026-01-15 09:00:00' },
    { name: 'Sieve', category: 'Prep', created_at: '2026-02-20 12:00:00' },
  ];

  it('sorts by name ascending', () => {
    expect(names(sortLibraryItems(rows, 'name-asc', accessors))).toEqual(['Blender', 'Sieve', 'Whisk']);
  });

  it('sorts by name descending', () => {
    expect(names(sortLibraryItems(rows, 'name-desc', accessors))).toEqual(['Whisk', 'Sieve', 'Blender']);
  });

  it('sorts by group, then by name inside each group', () => {
    expect(names(sortLibraryItems(rows, 'group-asc', accessors))).toEqual(['Blender', 'Sieve', 'Whisk']);
  });

  it('sorts newest and oldest first by created_at', () => {
    expect(names(sortLibraryItems(rows, 'newest', accessors))).toEqual(['Whisk', 'Sieve', 'Blender']);
    expect(names(sortLibraryItems(rows, 'oldest', accessors))).toEqual(['Blender', 'Sieve', 'Whisk']);
  });

  it('never mutates the array it was given', () => {
    const original = [...rows];
    sortLibraryItems(rows, 'name-desc', accessors);
    expect(rows).toEqual(original);
  });

  it('puts ungrouped rows last rather than first', () => {
    // An empty group would win every string comparison and float the
    // unlabelled rows to the top, which reads as a bug on screen.
    const mixed: Row[] = [
      { name: 'Alpha', category: null },
      { name: 'Beta', category: 'Zzz' },
    ];
    expect(names(sortLibraryItems(mixed, 'group-asc', accessors))).toEqual(['Beta', 'Alpha']);
  });

  it('puts rows with no timestamp last in both directions', () => {
    const mixed: Row[] = [
      { name: 'NoDate', created_at: null },
      { name: 'Dated', created_at: '2026-01-01 00:00:00' },
    ];
    expect(names(sortLibraryItems(mixed, 'newest', accessors))).toEqual(['Dated', 'NoDate']);
    expect(names(sortLibraryItems(mixed, 'oldest', accessors))).toEqual(['Dated', 'NoDate']);
  });

  it('breaks ties by name so equal timestamps still have a stable order', () => {
    // The seeded catalogs are inserted in one statement, so identical
    // created_at values are the common case, not an edge case.
    const sameSecond: Row[] = [
      { name: 'Carrot', created_at: '2026-01-01 00:00:00' },
      { name: 'Apple', created_at: '2026-01-01 00:00:00' },
      { name: 'Banana', created_at: '2026-01-01 00:00:00' },
    ];
    expect(names(sortLibraryItems(sameSecond, 'newest', accessors))).toEqual(['Apple', 'Banana', 'Carrot']);
  });

  it('falls back to name order when the section supplies no accessor for the key', () => {
    // Techniques have no category; a sort preference persisted from another
    // section must still produce a sensibly ordered list, not a random one.
    const noGroup = [{ name: 'Sear' }, { name: 'Braise' }];
    const labelOnly = { label: (r: { name: string }) => r.name };
    expect(names(sortLibraryItems(noGroup, 'group-asc', labelOnly))).toEqual(['Braise', 'Sear']);
    expect(names(sortLibraryItems(noGroup, 'newest', labelOnly))).toEqual(['Braise', 'Sear']);
  });

  it('compares accented names by base letter rather than codepoint', () => {
    // A naive compare puts "Èlote" after "Zucchini"; Italian and French
    // catalogs are full of these.
    const accented: Row[] = [{ name: 'Zucchini' }, { name: 'Èlote' }, { name: 'Apple' }];
    expect(names(sortLibraryItems(accented, 'name-asc', accessors, 'it'))).toEqual(['Apple', 'Èlote', 'Zucchini']);
  });

  it('orders embedded numbers naturally', () => {
    const numbered: Row[] = [{ name: 'Pan 10' }, { name: 'Pan 2' }];
    expect(names(sortLibraryItems(numbered, 'name-asc', accessors))).toEqual(['Pan 2', 'Pan 10']);
  });

  it('handles an empty list', () => {
    expect(sortLibraryItems([], 'name-asc', accessors)).toEqual([]);
  });
});

describe('isLibrarySortKey', () => {
  it('accepts every key the picker can produce', () => {
    const keys: LibrarySortKey[] = ['name-asc', 'name-desc', 'group-asc', 'newest', 'oldest'];
    for (const key of keys) expect(isLibrarySortKey(key)).toBe(true);
  });

  it('rejects anything else, so a stale persisted preference falls back', () => {
    // This is the whole point: useLibraryView validates what it reads out of
    // localStorage, which an older build may have written.
    expect(isLibrarySortKey('by-vibes')).toBe(false);
    expect(isLibrarySortKey(null)).toBe(false);
    expect(isLibrarySortKey(undefined)).toBe(false);
    expect(isLibrarySortKey(3)).toBe(false);
  });

  it('has a default that is itself a valid key', () => {
    expect(isLibrarySortKey(DEFAULT_SORT)).toBe(true);
  });
});
