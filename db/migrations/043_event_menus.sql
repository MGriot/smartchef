-- 043_event_menus.sql
-- A second kind of menu in the Planner: the menu for ONE meal — a dinner
-- party, a Sunday lunch — laid out the way a restaurant prints one, by
-- course (starters, first courses, mains, sides, desserts) rather than by
-- weekday.
--
-- Same two tables as the weekly plan rather than new ones, because
-- everything downstream already reads them: the shopping list's "From a
-- Menu" and the menu nutrition total both walk menu_items, and an event
-- menu should feed both exactly like a week does.
--
--   menus.kind       'week' (the original Monday-to-Sunday plan) or 'event'.
--   menus.meal_type  Which meal an event menu is (breakfast/lunch/dinner/snack).
--   menus.guests     How many it is for — the default servings of each dish.
--   menus.courses    The event menu's courses, in order, as a JSON array of
--                    {id, name}. Stored on the menu rather than derived from
--                    its items so a course can exist before it has a dish in
--                    it, and can be renamed or reordered without touching
--                    every item.
--   menus.week_start Reused as the event's date for kind = 'event' — it is
--                    already the NOT NULL date the menu list sorts on.
--
--   menu_items.course_id   The {id} of the course an event dish sits in.
--   menu_items.sort_order  Position within that course.
--   An event dish keeps day_of_week = 0; it has no weekday.

ALTER TABLE menus ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'week';
ALTER TABLE menus ADD COLUMN IF NOT EXISTS meal_type VARCHAR(30);
ALTER TABLE menus ADD COLUMN IF NOT EXISTS guests INT;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS courses JSONB NOT NULL DEFAULT '[]';

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS course_id VARCHAR(64);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
