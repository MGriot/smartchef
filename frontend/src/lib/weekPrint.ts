// ════════════════════════════════════════════════════════════════════════
// SmartChef — The printed weekly plan, as data
//
// A week on paper is a grid: one column per day, one row per meal of the
// day. This builds it (pure, tested) so pages/MenuPrint.tsx only lays it
// out. Meal rows nobody planned anything for are dropped, so a week of
// dinners prints as one row, not four.
// ════════════════════════════════════════════════════════════════════════

import { parseMenuDate } from './eventMenu';

export type WeekMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
const MEAL_ROWS: WeekMeal[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface WeekItem {
  id: string;
  recipeId: string;
  recipe_title: string;
  dayOfWeek: number;
  mealType: WeekMeal;
  servings: number;
  notes: string | null;
  sortOrder?: number;
}

export interface WeekInput {
  name: string;
  notes?: string | null;
  week_start: string;
  items?: WeekItem[] | null;
}

/** Monday-first weekday names in the app's language — 2024-01-01 was a
 *  Monday. Capitalised because Italian, French and Spanish write them
 *  lower-case, and here they are column headings. */
export function weekDays(lang: string): Array<{ idx: number; label: string }> {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, idx) => {
    const name = fmt.format(new Date(2024, 0, 1 + idx));
    return { idx, label: name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) };
  });
}

export interface WeekOptions {
  locale: string;
  showNotes: boolean;
  mealName: (meal: WeekMeal) => string;
  titleFor: (item: WeekItem) => string;
}

export interface WeekCell {
  id: string;
  name: string;
  servings: number;
  note: string | null;
}

export interface WeekSheet {
  title: string;
  notes: string | null;
  /** The Monday the week starts on, long form; '' if week_start is bad. */
  weekStart: string;
  days: Array<{ idx: number; label: string; date: string }>;
  rows: Array<{ meal: WeekMeal; label: string; cells: WeekCell[][] }>;
  /** True when nothing at all is planned. */
  empty: boolean;
}

export function buildWeekSheet(menu: WeekInput, opts: WeekOptions): WeekSheet {
  const items = menu.items ?? [];
  const start = parseMenuDate(menu.week_start);
  const validStart = !Number.isNaN(start.getTime());

  const days = weekDays(opts.locale).map((d) => ({
    ...d,
    date: validStart
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + d.idx)
          .toLocaleDateString(opts.locale, { day: 'numeric', month: 'short' })
      : '',
  }));

  const rows = MEAL_ROWS
    .filter((meal) => items.some((i) => i.mealType === meal))
    .map((meal) => ({
      meal,
      label: opts.mealName(meal),
      cells: days.map((d) =>
        items
          .filter((i) => i.mealType === meal && i.dayOfWeek === d.idx)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((i) => ({
            id: i.id,
            name: opts.titleFor(i),
            servings: i.servings,
            note: opts.showNotes && i.notes ? i.notes : null,
          })),
      ),
    }));

  return {
    title: menu.name,
    notes: menu.notes || null,
    weekStart: validStart
      ? start.toLocaleDateString(opts.locale, { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
    days,
    rows,
    empty: rows.length === 0,
  };
}
