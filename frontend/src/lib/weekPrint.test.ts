import { describe, it, expect } from 'vitest';
import { buildWeekSheet, weekDays, type WeekInput, type WeekItem, type WeekOptions } from './weekPrint';

const opts: WeekOptions = {
  locale: 'en-GB',
  showNotes: true,
  mealName: (m) => m,
  titleFor: (i) => i.recipe_title,
};

const item = (id: string, dayOfWeek: number, mealType: WeekItem['mealType'], extra: Partial<WeekItem> = {}): WeekItem =>
  ({ id, recipeId: `r${id}`, recipe_title: `Dish ${id}`, dayOfWeek, mealType, servings: 2, notes: null, ...extra });

const week = (items: WeekItem[]): WeekInput => ({ name: 'Week', week_start: '2025-03-10', items });

describe('weekDays', () => {
  it('starts on Monday and capitalises', () => {
    const days = weekDays('en-GB');
    expect(days[0].label).toBe('Monday');
    expect(days[6].label).toBe('Sunday');
    expect(weekDays('it')[0].label).toBe('Lunedì');
  });
});

describe('buildWeekSheet', () => {
  it('keeps only meal rows that have something planned, in day order', () => {
    const sheet = buildWeekSheet(week([item('a', 0, 'dinner'), item('b', 2, 'breakfast')]), opts);
    expect(sheet.rows.map((r) => r.meal)).toEqual(['breakfast', 'dinner']);
    expect(sheet.empty).toBe(false);
  });

  it('places dishes in the right day column, ordered by sortOrder', () => {
    const sheet = buildWeekSheet(
      week([item('a', 1, 'lunch', { sortOrder: 1 }), item('b', 1, 'lunch', { sortOrder: 0 })]),
      opts,
    );
    const lunch = sheet.rows[0].cells;
    expect(lunch[0]).toEqual([]);
    expect(lunch[1].map((c) => c.name)).toEqual(['Dish b', 'Dish a']);
  });

  it('dates each column from the week start', () => {
    const sheet = buildWeekSheet(week([item('a', 0, 'dinner')]), opts);
    expect(sheet.days[0].date).toBe('10 Mar');
    expect(sheet.days[6].date).toBe('16 Mar');
  });

  it('hides notes when asked, and flags an empty week', () => {
    const noted = week([item('a', 0, 'dinner', { notes: 'hot' })]);
    expect(buildWeekSheet(noted, opts).rows[0].cells[0][0].note).toBe('hot');
    expect(buildWeekSheet(noted, { ...opts, showNotes: false }).rows[0].cells[0][0].note).toBeNull();
    expect(buildWeekSheet(week([]), opts).empty).toBe(true);
  });

  it('survives a bad week_start', () => {
    const sheet = buildWeekSheet({ name: 'x', week_start: 'bad', items: [] }, opts);
    expect(sheet.weekStart).toBe('');
    expect(sheet.days[0].date).toBe('');
  });
});
