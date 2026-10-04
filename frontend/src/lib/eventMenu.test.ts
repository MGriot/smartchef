import { describe, it, expect } from 'vitest';
import { defaultCourses, groupDishesByCourse, moveCourse, moveDish, newCourseId, type EventCourse } from './eventMenu';

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
