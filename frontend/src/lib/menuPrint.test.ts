import { describe, it, expect } from 'vitest';
import { buildMenuCard, type MenuCardInput, type MenuCardItem, type MenuCardOptions } from './menuPrint';

const opts: MenuCardOptions = {
  showNotes: true,
  locale: 'en-GB',
  mealName: (m) => m.toUpperCase(),
  otherDishesLabel: 'Other',
  forGuestsLabel: (n) => `for ${n}`,
  titleFor: (i) => i.recipe_title,
};

const dish = (id: string, courseId: string | null, sortOrder = 0, notes: string | null = null): MenuCardItem =>
  ({ id, recipeId: `r-${id}`, recipe_title: `Dish ${id}`, courseId, sortOrder, notes });

const plain: MenuCardInput = {
  name: 'Sunday lunch',
  notes: 'Welcome',
  week_start: '2025-03-09',
  meal_type: 'lunch',
  guests: 6,
  courses: [{ id: 'starter', name: 'Starter' }, { id: 'main', name: 'Main' }, { id: 'dessert', name: 'Dessert' }],
  items: [dish('a', 'main', 1), dish('b', 'main', 0, 'with love'), dish('c', 'starter')],
};

describe('buildMenuCard', () => {
  it('lists courses in order, dishes by sort order, and drops empty courses', () => {
    const card = buildMenuCard(plain, opts);
    expect(card.sections.map((s) => s.courseName)).toEqual(['Starter', 'Main']);
    expect(card.sections[1].dishes.map((d) => d.name)).toEqual(['Dish b', 'Dish a']);
  });

  it('puts the meal and the date in the kicker, the guests in the footer', () => {
    const card = buildMenuCard(plain, opts);
    expect(card.kicker).toContain('LUNCH');
    expect(card.kicker).toContain('9 March 2025');
    expect(card.footer).toBe('for 6');
    expect(card.intro).toBe('Welcome');
  });

  it('hides notes unless asked', () => {
    expect(buildMenuCard(plain, opts).sections[1].dishes[0].note).toBe('with love');
    expect(buildMenuCard(plain, { ...opts, showNotes: false }).sections[1].dishes[0].note).toBeNull();
  });

  it('gathers dishes of a deleted course under the catch-all', () => {
    const card = buildMenuCard({ ...plain, items: [dish('z', 'gone')] }, opts);
    expect(card.sections.map((s) => s.courseName)).toEqual(['Other']);
  });

  it('starts each further meal of a day menu on a new page', () => {
    const day: MenuCardInput = {
      ...plain,
      meal_type: null,
      courses: [
        { id: 'l-main', name: 'Main', mealType: 'lunch' },
        { id: 'd-starter', name: 'Starter', mealType: 'dinner' },
        { id: 'd-main', name: 'Main', mealType: 'dinner' },
      ],
      items: [dish('1', 'l-main'), dish('2', 'd-starter'), dish('3', 'd-main')],
    };
    const card = buildMenuCard(day, opts);
    expect(card.kicker).toContain('LUNCH + DINNER');
    expect(card.sections.map((s) => s.mealHeading)).toEqual(['LUNCH', 'DINNER', null]);
    expect(card.sections.map((s) => s.startsNewPage)).toEqual([false, true, false]);
  });

  it('copes with a bad date', () => {
    const card = buildMenuCard({ ...plain, week_start: 'nope' }, opts);
    expect(card.kicker).toBe('LUNCH');
  });
});
