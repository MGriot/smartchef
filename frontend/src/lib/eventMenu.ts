// ════════════════════════════════════════════════════════════════════════
// SmartChef — Event menus (one meal, by course)
//
// The Planner's second kind of menu, next to the weekly plan: a dinner or a
// party laid out the way a restaurant prints its menu — courses in order,
// dishes in each. Storage is db/migrations/043_event_menus.sql; this module
// is the arithmetic the page needs on top of it, kept pure so it can be
// tested (the suite has no jsdom):
//   - the classic courses a new menu starts with,
//   - grouping a menu's dishes under its courses, in order, without losing
//     a dish whose course was removed from under it,
//   - the sort_order writes that moving a dish up or down comes down to.
// ════════════════════════════════════════════════════════════════════════

export type EventMealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** Serving order of a day's meals. */
export const MEAL_ORDER: EventMealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface EventCourse {
  id: string;
  name: string;
  /** The meal of a day menu this course belongs to; absent while the menu
   *  is just one meal. */
  mealType?: EventMealType;
}

export interface EventDish {
  id: string;
  courseId: string | null;
  sortOrder: number;
}

/** The courses a new event menu starts with, in serving order. The ids are
 *  stable keys; the names are whatever language the menu was created in
 *  and are the user's to rename. */
export const DEFAULT_COURSE_KEYS = ['starter', 'first', 'main', 'side', 'dessert'] as const;

export function defaultCourses(
  nameFor: (key: (typeof DEFAULT_COURSE_KEYS)[number]) => string,
  mealType?: EventMealType,
): EventCourse[] {
  // Course ids only have to be unique within one menu, so a second meal's
  // "main" must not collide with the first's.
  return DEFAULT_COURSE_KEYS.map((key) => (mealType
    ? { id: `${mealType}-${key}`, name: nameFor(key), mealType }
    : { id: key, name: nameFor(key) }));
}

/** An id for a course the user adds. Only has to be unique within one
 *  menu, and short enough for menu_items.course_id. */
export function newCourseId(existing: EventCourse[], random: () => number = Math.random): string {
  const taken = new Set(existing.map((c) => c.id));
  for (;;) {
    const id = `c-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
    if (!taken.has(id)) return id;
  }
}

export interface CourseGroup<D extends EventDish> {
  /** null for the catch-all group of dishes with no known course. */
  course: EventCourse | null;
  dishes: D[];
}

/** Every course in the menu's order with its dishes in theirs. A dish whose
 *  course no longer exists — removed on another device, or by a client that
 *  deleted the course before its dishes — lands in a trailing group with
 *  course null rather than disappearing from the menu. */
export function groupDishesByCourse<D extends EventDish>(courses: EventCourse[], dishes: D[]): Array<CourseGroup<D>> {
  const known = new Set(courses.map((c) => c.id));
  const bySort = (a: D, b: D) => a.sortOrder - b.sortOrder;
  const groups: Array<CourseGroup<D>> = courses.map((course) => ({
    course,
    dishes: dishes.filter((d) => d.courseId === course.id).sort(bySort),
  }));
  const orphans = dishes.filter((d) => !d.courseId || !known.has(d.courseId)).sort(bySort);
  if (orphans.length > 0) groups.push({ course: null, dishes: orphans });
  return groups;
}

/** The sort_order writes that move one dish a step up or down within its
 *  course. The whole course is renumbered 0..n-1 rather than two values
 *  swapped: two dishes added on different devices can share a sort_order,
 *  and swapping equal numbers moves nothing. Only rows whose number
 *  actually changes are returned. */
export function moveDish<D extends EventDish>(courseDishes: D[], dishId: string, direction: -1 | 1): Array<{ id: string; sortOrder: number }> {
  const ordered = [...courseDishes].sort((a, b) => a.sortOrder - b.sortOrder);
  const from = ordered.findIndex((d) => d.id === dishId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ordered.length) return [];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  return ordered
    .map((d, index) => ({ id: d.id, sortOrder: index, previous: d.sortOrder }))
    .filter((d) => d.sortOrder !== d.previous)
    .map(({ id, sortOrder }) => ({ id, sortOrder }));
}

/** A course list with one course moved a step up or down. */
export function moveCourse(courses: EventCourse[], courseId: string, direction: -1 | 1): EventCourse[] {
  const from = courses.findIndex((c) => c.id === courseId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= courses.length) return courses;
  const next = [...courses];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export interface MealGroup<C extends EventCourse = EventCourse> {
  mealType: EventMealType;
  courses: C[];
}

/** The meals of a day menu, in serving order, each with its courses in
 *  their stored order. Empty for a menu that is one plain meal (no course
 *  names a meal) — the caller then shows the courses directly. */
export function mealsOf<C extends EventCourse>(courses: C[]): Array<MealGroup<C>> {
  const present = new Set(courses.map((c) => c.mealType).filter((m): m is EventMealType => !!m));
  return MEAL_ORDER.filter((m) => present.has(m)).map((mealType) => ({
    mealType,
    courses: courses.filter((c) => c.mealType === mealType),
  }));
}

/** A course list with one course moved a step up or down among the courses
 *  of its own meal — the neighbour in the whole list may belong to another
 *  meal, which a plain moveCourse() would swap it with. */
export function moveCourseWithinMeal(courses: EventCourse[], courseId: string, direction: -1 | 1): EventCourse[] {
  const course = courses.find((c) => c.id === courseId);
  if (!course) return courses;
  const siblings = courses.filter((c) => c.mealType === course.mealType);
  const from = siblings.findIndex((c) => c.id === courseId);
  const neighbour = siblings[from + direction];
  if (!neighbour) return courses;
  return courses.map((c) => (c.id === courseId ? neighbour : c.id === neighbour.id ? course : c));
}
