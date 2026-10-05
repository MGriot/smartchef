import { describe, it, expect } from 'vitest';
import { currentMeals, defaultCourses, groupDishesByCourse, mealsOf, moveCourse, moveCourseWithinMeal, moveDish, newCourseId, planMealChange, type EventCourse } from './eventMenu';

const courses: EventCourse[] = [
  { id: 'starter', name: 'Antipasti' },
  { id: 'main', name: 'Secondi' },
];

const dish = (id: string, courseId: string | null, sortOrder: number) => ({ id, courseId, sortOrder });

describe('defaultCourses', () => {
  it('lists the classic courses in serving order with stable ids', () => {
    const list = defaultCourses((key) => `name:${key}`);
    expect(list.map((c) => c.id)).toEqual(['starter', 'first', 'main', 'side', 'dessert']);
    expect(list[0].name).toBe('name:starter');
  });
});

describe('newCourseId', () => {
  it('never reuses an id already in the menu', () => {
    const rolls = [0, 0, 0.5];
    const taken = [{ id: 'c-000000', name: 'x' }];
    expect(newCourseId(taken, () => rolls.shift()!)).not.toBe('c-000000');
  });
});

describe('groupDishesByCourse', () => {
  it('keeps the courses’ order and each course’s dishes in sort order', () => {
    const groups = groupDishesByCourse(courses, [dish('b', 'starter', 1), dish('m', 'main', 0), dish('a', 'starter', 0)]);
    expect(groups.map((g) => [g.course?.id, g.dishes.map((d) => d.id)])).toEqual([
      ['starter', ['a', 'b']],
      ['main', ['m']],
    ]);
  });

  it('shows an empty course rather than dropping it', () => {
    expect(groupDishesByCourse(courses, [])).toEqual([
      { course: courses[0], dishes: [] },
      { course: courses[1], dishes: [] },
    ]);
  });

  it('keeps dishes whose course is gone in a trailing group', () => {
    const groups = groupDishesByCourse(courses, [dish('x', 'deleted-course', 0), dish('y', null, 1)]);
    expect(groups[groups.length - 1]).toEqual({ course: null, dishes: [dish('x', 'deleted-course', 0), dish('y', null, 1)] });
  });
});

describe('moveDish', () => {
  const list = [dish('a', 'starter', 0), dish('b', 'starter', 1), dish('c', 'starter', 2)];

  it('writes only the rows whose position changes', () => {
    expect(moveDish(list, 'c', -1)).toEqual([{ id: 'c', sortOrder: 1 }, { id: 'b', sortOrder: 2 }]);
  });

  it('does nothing past either end', () => {
    expect(moveDish(list, 'a', -1)).toEqual([]);
    expect(moveDish(list, 'c', 1)).toEqual([]);
  });

  it('still moves dishes that share a sort_order', () => {
    // Two dishes added on two devices can both be 0; swapping equal values
    // would move nothing, renumbering does.
    const tied = [dish('a', 'starter', 0), dish('b', 'starter', 0)];
    const writes = moveDish(tied, 'b', -1);
    const order = new Map(tied.map((d) => [d.id, d.sortOrder]));
    for (const w of writes) order.set(w.id, w.sortOrder);
    expect(order.get('b')).toBeLessThan(order.get('a')!);
  });
});

describe('moveCourse', () => {
  it('moves a course one place and leaves the list alone at the ends', () => {
    expect(moveCourse(courses, 'main', -1).map((c) => c.id)).toEqual(['main', 'starter']);
    expect(moveCourse(courses, 'starter', -1)).toBe(courses);
  });
});

describe('meals of a day menu', () => {
  const courses = [
    { id: 'lunch-main', name: 'Main', mealType: 'lunch' as const },
    { id: 'dinner-starter', name: 'Starter', mealType: 'dinner' as const },
    { id: 'dinner-main', name: 'Main', mealType: 'dinner' as const },
  ];

  it('lists meals in serving order, none for a plain menu', () => {
    expect(mealsOf(courses).map((m) => m.mealType)).toEqual(['lunch', 'dinner']);
    expect(mealsOf([{ id: 'a', name: 'A' }])).toEqual([]);
  });

  it('moves a course only among those of its own meal', () => {
    const moved = moveCourseWithinMeal(courses, 'dinner-main', -1).map((c) => c.id);
    expect(moved).toEqual(['lunch-main', 'dinner-main', 'dinner-starter']);
    // already first of its meal: unchanged, even though a lunch course precedes it
    expect(moveCourseWithinMeal(courses, 'dinner-starter', -1)).toBe(courses);
  });

  it('gives a second meal its own course ids', () => {
    const ids = defaultCourses((k) => k, 'lunch').map((c) => c.id);
    expect(ids[0]).toBe('lunch-starter');
    expect(new Set([...ids, ...defaultCourses((k) => k, 'dinner').map((c) => c.id)]).size).toBe(10);
  });
});

describe('planMealChange', () => {
  const name = (k: string) => k;
  const plain: EventCourse[] = [{ id: 'starter', name: 'S' }, { id: 'main', name: 'M' }];

  it('naming a meal on a plain menu labels what is there, keeping it untagged', () => {
    const plan = planMealChange(plain, null, ['dinner'], name);
    expect(plan.mealType).toBe('dinner');
    expect(plan.courses).toEqual(plain);
    expect(plan.removeCourseIds).toEqual([]);
  });

  it('a second meal tags every course and brings its own', () => {
    const plan = planMealChange(plain, 'dinner', ['lunch', 'dinner'], name);
    expect(plan.courses.filter((c) => c.mealType === 'dinner').map((c) => c.id)).toEqual(['starter', 'main']);
    expect(plan.courses.filter((c) => c.mealType === 'lunch')).toHaveLength(5);
    expect(plan.mealType).toBe('lunch');
    expect(plan.removeCourseIds).toEqual([]);
  });

  it('swaps a meal for another keeping its courses', () => {
    const plan = planMealChange(plain, 'dinner', ['lunch'], name);
    expect(plan.courses).toEqual(plain);
    expect(plan.mealType).toBe('lunch');
    expect(plan.removeCourseIds).toEqual([]);
    expect(plan.retag).toEqual([{ courseIds: ['starter', 'main'], to: 'lunch' }]);
  });

  it('removing one of two meals drops its courses and returns to a single meal', () => {
    const both = planMealChange(plain, 'dinner', ['lunch', 'dinner'], name).courses;
    const plan = planMealChange(both, 'lunch', ['dinner'], name);
    expect(plan.removeCourseIds).toHaveLength(5);
    expect(plan.courses).toEqual(plain);
    expect(plan.mealType).toBe('dinner');
  });

  it('clearing the only meal makes the menu plain again, courses kept', () => {
    const plan = planMealChange(plain, 'dinner', [], name);
    expect(plan.mealType).toBeNull();
    expect(plan.courses).toEqual(plain);
  });

  it('never reuses a course id after a swap', () => {
    const both = planMealChange(plain, 'dinner', ['dinner', 'lunch'], name).courses;
    const swapped = planMealChange(both, 'dinner', ['breakfast', 'lunch'], name).courses;
    const again = planMealChange(swapped, 'breakfast', ['breakfast', 'lunch', 'dinner'], name).courses;
    expect(new Set(again.map((c) => c.id)).size).toBe(again.length);
  });

  it('currentMeals reads tagged courses, else the menu meal', () => {
    expect(currentMeals(plain, null)).toEqual([]);
    expect(currentMeals(plain, 'lunch')).toEqual(['lunch']);
    expect(currentMeals([{ id: 'a', name: 'A', mealType: 'snack' }, { id: 'b', name: 'B', mealType: 'breakfast' }], null)).toEqual(['breakfast', 'snack']);
  });
});
