// ════════════════════════════════════════════════════════════════════════
// SmartChef — The printed event menu, as data
//
// What goes on the menu card, decided here (pure, tested — the suite has no
// jsdom) so pages/MenuPrint.tsx only has to lay it out: the heading line,
// each course with its dishes in order, a new meal heading where a day menu
// moves on to the next meal, and which of those headings must start a fresh
// sheet.
// ════════════════════════════════════════════════════════════════════════

import {
  groupDishesByCourse, mealsOf, parseMenuDate,
  type EventCourse, type EventMealType,
} from './eventMenu';

export interface MenuCardItem {
  id: string;
  recipeId: string;
  recipe_title: string;
  mealType?: string;
  notes: string | null;
  courseId?: string | null;
  sortOrder?: number;
}

export interface MenuCardInput {
  name: string;
  notes?: string | null;
  week_start: string;
  meal_type?: EventMealType | null;
  guests?: number | null;
  courses?: EventCourse[] | null;
  items?: MenuCardItem[] | null;
}

export interface MenuCardOptions {
  showNotes: boolean;
  locale: string;
  mealName: (meal: EventMealType) => string;
  otherDishesLabel: string;
  forGuestsLabel: (count: number) => string;
  titleFor: (item: MenuCardItem) => string;
}

export interface MenuCardSection {
  /** Set on the first course of a meal in a day menu: the meal's name. */
  mealHeading: string | null;
  /** True where a day menu moves on to a further meal — the sheet starts a
   *  new page there rather than splitting a meal across two. */
  startsNewPage: boolean;
  courseName: string;
  dishes: Array<{ id: string; name: string; note: string | null }>;
}

export interface MenuCard {
  kicker: string;
  title: string;
  intro: string | null;
  sections: MenuCardSection[];
  footer: string;
}

export function buildMenuCard(menu: MenuCardInput, opts: MenuCardOptions): MenuCard {
  const courses = menu.courses ?? [];
  const items = menu.items ?? [];
  const groups = groupDishesByCourse(courses, items.map((i) => ({ ...i, courseId: i.courseId ?? null, sortOrder: i.sortOrder ?? 0 })));
  const meals = mealsOf(courses);
  const multi = meals.length > 0;

  // A day menu lists its courses meal by meal; dishes whose course vanished
  // trail at the end.
  const ordered = multi
    ? (() => {
        const byId = new Map(groups.filter((g) => g.course).map((g) => [g.course!.id, g]));
        return [
          ...meals.flatMap((m) => m.courses.map((c) => byId.get(c.id)!).filter(Boolean)),
          ...groups.filter((g) => !g.course),
        ];
      })()
    : groups;

  const shown = ordered.filter((g) => g.dishes.length > 0);
  const sections: MenuCardSection[] = shown.map((group, i) => {
    const meal = group.course?.mealType;
    const startsMeal = multi && !!meal && shown[i - 1]?.course?.mealType !== meal;
    return {
      mealHeading: startsMeal && meal ? opts.mealName(meal) : null,
      startsNewPage: startsMeal && i > 0,
      courseName: group.course ? group.course.name : opts.otherDishesLabel,
      dishes: group.dishes.map((item) => ({
        id: item.id,
        name: opts.titleFor(item),
        note: opts.showNotes && item.notes ? item.notes : null,
      })),
    };
  });

  const date = parseMenuDate(menu.week_start);
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(opts.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const mealLabel = multi
    ? meals.map((m) => opts.mealName(m.mealType)).join(' + ')
    : menu.meal_type ? opts.mealName(menu.meal_type) : '';

  return {
    kicker: [mealLabel, dateLabel].filter(Boolean).join(' · '),
    title: menu.name,
    intro: menu.notes || null,
    sections,
    footer: opts.forGuestsLabel(menu.guests ?? 4),
  };
}
