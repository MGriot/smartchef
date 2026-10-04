// The Planner's API shapes — GET /api/menus and /api/menus/:id, the same
// from the server (backend/src/routes/menus.ts) and from standalone mode
// (services/menus.local.ts).

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** 'week' = Monday-to-Sunday plan; 'event' = one meal, by course. Menus
 *  saved before event menus existed have no kind and are weekly plans. */
export type MenuKind = 'week' | 'event';

export interface MenuCourse {
  id: string;
  name: string;
}

export interface MenuSummary {
  id: string;
  name: string;
  /** The week's Monday for a weekly plan, the event's date for an event menu. */
  week_start: string;
  item_count: string | number;
  kind?: MenuKind;
  meal_type?: MealType | null;
  guests?: number | null;
}

export interface MenuItem {
  id: string;
  recipeId: string;
  recipe_title: string;
  dayOfWeek: number;
  mealType: MealType;
  servings: number;
  notes: string | null;
  courseId?: string | null;
  sortOrder?: number;
}

export interface MenuDetail extends MenuSummary {
  notes?: string | null;
  courses?: MenuCourse[] | null;
  items: MenuItem[] | null;
}

export interface RecipeOption {
  id: string;
  title: string;
  translated_title?: string | null;
}

export function menuKind(menu: Pick<MenuSummary, 'kind'> | null | undefined): MenuKind {
  return menu?.kind === 'event' ? 'event' : 'week';
}
