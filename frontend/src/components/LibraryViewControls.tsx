import { useTranslation } from 'react-i18next';
import type { LibrarySortKey } from '../lib/librarySort';
import type { LibraryViewMode } from '../hooks/useLibraryView';

// ════════════════════════════════════════════════════════════════════════
// The grid/list switch and sort picker shared by every Library section.
//
// Lifted out of LibraryIngredients.tsx, which had the only view switch in
// the app — the other four sections were table-only with no sort at all.
// Extracting it rather than pasting it four more times is what keeps the
// sections looking like one product: same pill, same icons, same active
// state, same place in the toolbar.
// ════════════════════════════════════════════════════════════════════════

const SORT_LABEL_KEYS: Record<LibrarySortKey, string> = {
  'name-asc': 'library.common.sortNameAsc',
  'name-desc': 'library.common.sortNameDesc',
  'group-asc': 'library.common.sortGroup',
  newest: 'library.common.sortNewest',
  oldest: 'library.common.sortOldest',
};

export interface ViewToggleProps {
  value: LibraryViewMode;
  onChange: (next: LibraryViewMode) => void;
}

/** Two-state segmented control. Rendered as real buttons with `aria-pressed`
 *  rather than styled divs, so the choice is reachable and announced by a
 *  screen reader — the icons alone carry the meaning visually, hence the
 *  title/aria-label on each. */
export function ViewToggle({ value, onChange }: ViewToggleProps) {
  const { t } = useTranslation();
  const base = 'w-9 h-9 rounded-full flex items-center justify-center transition-all';
  const on = 'bg-primary text-white';
  const off = 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400';

  return (
    <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 rounded-full border border-zinc-200 dark:border-zinc-700 p-1 shrink-0">
      <button
        type="button"
        onClick={() => onChange('grid')}
        title={t('library.common.gridView')}
        aria-label={t('library.common.gridView')}
        aria-pressed={value === 'grid'}
        className={`${base} ${value === 'grid' ? on : off}`}
      >
        <span className="material-symbols-outlined text-lg">grid_view</span>
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        title={t('library.common.listView')}
        aria-label={t('library.common.listView')}
        aria-pressed={value === 'list'}
        className={`${base} ${value === 'list' ? on : off}`}
      >
        <span className="material-symbols-outlined text-lg">view_list</span>
      </button>
    </div>
  );
}

export interface GroupToggleProps {
  value: boolean;
  onChange: (next: boolean) => void;
}

/** Grouped by category, or one flat list. Separate from the grid/list
 *  switch on purpose: they answer different questions — "how is each item
 *  drawn" and "is the list broken into sections" — and a catalog of 300
 *  ingredients is unusable if the only way to see it as one list is to
 *  collapse eleven headings by hand. */
export function GroupToggle({ value, onChange }: GroupToggleProps) {
  const { t } = useTranslation();
  const base = 'w-9 h-9 rounded-full flex items-center justify-center transition-all';
  const on = 'bg-primary text-white';
  const off = 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400';

  return (
    <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 rounded-full border border-zinc-200 dark:border-zinc-700 p-1 shrink-0">
      <button
        type="button"
        onClick={() => onChange(true)}
        title={t('library.common.grouped')}
        aria-label={t('library.common.grouped')}
        aria-pressed={value}
        className={`${base} ${value ? on : off}`}
      >
        <span className="material-symbols-outlined text-lg">category</span>
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        title={t('library.common.flat')}
        aria-label={t('library.common.flat')}
        aria-pressed={!value}
        className={`${base} ${!value ? on : off}`}
      >
        <span className="material-symbols-outlined text-lg">format_list_bulleted</span>
      </button>
    </div>
  );
}

export interface CollapseAllButtonProps {
  /** True when every section is already collapsed, so the button offers to
   *  expand instead. */
  allCollapsed: boolean;
  onToggle: () => void;
}

/** One button for all the headings at once. */
export function CollapseAllButton({ allCollapsed, onToggle }: CollapseAllButtonProps) {
  const { t } = useTranslation();
  const label = allCollapsed ? t('library.common.expandAll') : t('library.common.collapseAll');
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className="shrink-0 flex items-center gap-2 px-3 sm:px-4 py-3 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
    >
      <span className="material-symbols-outlined text-lg">{allCollapsed ? 'unfold_more' : 'unfold_less'}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export interface SortSelectProps {
  value: LibrarySortKey;
  onChange: (next: LibrarySortKey) => void;
  /** Which orderings this section offers, in menu order. A section with no
   *  grouping concept leaves 'group-asc' out. */
  options: LibrarySortKey[];
  /** Overrides the generic "Group" wording where the section has a better
   *  name for it — "Category" for tools, "Type" for units. */
  groupLabelKey?: string;
}

/** A native `<select>`, deliberately. A custom dropdown would need its own
 *  focus trap, keyboard handling and mobile behaviour to match what the
 *  platform already gives away for free — and this control sits on a phone
 *  screen as often as a desktop one, where the native picker is the better
 *  experience. */
export function SortSelect({ value, onChange, options, groupLabelKey }: SortSelectProps) {
  const { t } = useTranslation();

  return (
    <div className="relative shrink-0">
      <span
        className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 text-[18px] pointer-events-none"
        aria-hidden="true"
      >
        swap_vert
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as LibrarySortKey)}
        aria-label={t('library.common.sortBy')}
        // `appearance-none` plus the explicit chevron keeps the control the
        // same shape as the search field beside it; the native arrow varies
        // wildly between the Android WebView and Chromium on desktop.
        className="appearance-none pl-10 pr-9 py-3 bg-white dark:bg-zinc-900 rounded-full border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium text-zinc-700 dark:text-zinc-200 cursor-pointer"
      >
        {options.map((key) => (
          <option key={key} value={key}>
            {key === 'group-asc' && groupLabelKey ? t(groupLabelKey) : t(SORT_LABEL_KEYS[key])}
          </option>
        ))}
      </select>
      <span
        className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 text-[18px] pointer-events-none"
        aria-hidden="true"
      >
        expand_more
      </span>
    </div>
  );
}

export interface LibraryToolbarProps {
  value: LibraryViewMode;
  onChange: (next: LibraryViewMode) => void;
  sortValue: LibrarySortKey;
  sortOptions: LibrarySortKey[];
  onSortChange: (next: LibrarySortKey) => void;
  groupLabelKey?: string;
  /** The section's search box or filter chips, rendered before the
   *  controls so the row reads left-to-right as "narrow, then arrange". */
  children?: React.ReactNode;
}

/** The whole toolbar row. Wraps on narrow screens instead of overflowing,
 *  and lets the leading slot (search) take the slack so the two controls
 *  stay their natural width.
 *
 *  Sort and view are spelled out separately here rather than by extending
 *  ViewToggleProps and SortSelectProps — both of those own an `onChange`,
 *  and merging them would collide on it. */
export function LibraryToolbar({ value, onChange, sortValue, sortOptions, onSortChange, groupLabelKey, children }: LibraryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-4 mb-6">
      {children}
      <SortSelect value={sortValue} onChange={onSortChange} options={sortOptions} groupLabelKey={groupLabelKey} />
      <ViewToggle value={value} onChange={onChange} />
    </div>
  );
}
