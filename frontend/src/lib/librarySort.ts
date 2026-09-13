// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shared sorting for the Library sections
//
// Every Library screen (ingredients, tools, units, techniques, tags) shows a
// catalog of rows that differ in shape but sort the same handful of ways:
// by display name, by whatever groups them, and by age. This module owns
// that so the five screens can't drift into five slightly different
// orderings.
//
// Sorting happens here, in JS, rather than as an `ORDER BY` the list
// endpoints take as a parameter. That is deliberate: these catalogs are
// small (this library's largest is 238 ingredients), and in standalone mode
// every refetch is a Capacitor bridge round-trip whose result is
// JSON-stringified in Java and re-parsed in the WebView — see
// docs/plans/2026-09-12-android-performance-plan.md. Re-querying on every
// sort change would reintroduce exactly the cost that plan removed, to
// reorder a list already sitting in memory.
// ════════════════════════════════════════════════════════════════════════

export type LibrarySortKey =
  | 'name-asc'
  | 'name-desc'
  | 'group-asc'
  | 'newest'
  | 'oldest';

/** The orderings every section offers. A section that has nothing
 *  meaningful to group by (techniques) simply omits 'group-asc' from the
 *  options it passes to the picker — the sort itself still handles it by
 *  falling back to name order, so a stale persisted preference can never
 *  leave a screen unsorted. */
export const DEFAULT_SORT: LibrarySortKey = 'name-asc';

const ALL_KEYS: LibrarySortKey[] = ['name-asc', 'name-desc', 'group-asc', 'newest', 'oldest'];

export function isLibrarySortKey(value: unknown): value is LibrarySortKey {
  return typeof value === 'string' && (ALL_KEYS as string[]).includes(value);
}

export interface LibrarySortAccessors<T> {
  /** What the row is called on screen — the translated name where there is
   *  one, so that sorting matches the order the reader actually sees rather
   *  than the underlying English. */
  label: (item: T) => string;
  /** The row's group/category/type, for 'group-asc'. Omit on sections that
   *  have none. */
  group?: (item: T) => string | null | undefined;
  /** ISO timestamp string, as stored in the `created_at` columns. */
  createdAt?: (item: T) => string | null | undefined;
}

/** Locale-aware comparison, so "Ãˆ" sorts next to "E" in Italian rather than
 *  after "Z" as a naive codepoint compare would put it. `sensitivity: base`
 *  keeps "elote" and "Ãˆlote" adjacent instead of letting case decide. */
function compareLabels(a: string, b: string, lang?: string): number {
  return a.localeCompare(b, lang || undefined, { sensitivity: 'base', numeric: true });
}

/** Returns a new sorted array — never mutates its input, since callers pass
 *  React state straight in. Rows are always given a total order: every
 *  comparison falls back to the label, so two rows created in the same
 *  second (which the seed catalogs routinely are) keep a stable, meaningful
 *  order rather than whatever the source array happened to hold. */
export function sortLibraryItems<T>(
  items: readonly T[],
  key: LibrarySortKey,
  accessors: LibrarySortAccessors<T>,
  lang?: string
): T[] {
  const { label, group, createdAt } = accessors;
  const byLabel = (a: T, b: T) => compareLabels(label(a), label(b), lang);

  const sorted = [...items];

  switch (key) {
    case 'name-desc':
      return sorted.sort((a, b) => byLabel(b, a));

    case 'group-asc':
      if (!group) return sorted.sort(byLabel);
      return sorted.sort((a, b) => {
        // Ungrouped rows sort last rather than first: an empty string would
        // otherwise win every comparison and push the unlabelled rows to the
        // top of the screen, which reads as a bug.
        const ga = group(a) || '';
        const gb = group(b) || '';
        if (!ga && gb) return 1;
        if (ga && !gb) return -1;
        const byGroup = compareLabels(ga, gb, lang);
        return byGroup !== 0 ? byGroup : byLabel(a, b);
      });

    case 'newest':
    case 'oldest': {
      if (!createdAt) return sorted.sort(byLabel);
      const direction = key === 'newest' ? -1 : 1;
      return sorted.sort((a, b) => {
        const ta = createdAt(a) || '';
        const tb = createdAt(b) || '';
        // Rows with no timestamp fall to the end in both directions — they
        // carry no age information, so putting them at either extreme would
        // be inventing one.
        if (!ta && !tb) return byLabel(a, b);
        if (!ta) return 1;
        if (!tb) return -1;
        // The columns hold ISO-ish strings ("YYYY-MM-DD HH:MM:SS"), which
        // compare correctly as text without parsing a Date per comparison.
        const byTime = ta < tb ? -1 : ta > tb ? 1 : 0;
        return byTime !== 0 ? byTime * direction : byLabel(a, b);
      });
    }

    case 'name-asc':
    default:
      return sorted.sort(byLabel);
  }
}
