import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../../lib/api';
import { canPrint, printPage } from '../../lib/print';
import { groupDishesByCourse, moveCourse, moveDish, newCourseId } from '../../lib/eventMenu';
import Autocomplete from '../Autocomplete';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../Modal';
import { Field } from '../Form';
import type { MenuCourse, MenuDetail, MenuItem, RecipeOption } from './types';

const SHOW_NOTES_KEY = 'smartchef.planner.cardShowsNotes';

/** A bare YYYY-MM-DD is a calendar day, not an instant: parsed by Date()
 *  as UTC midnight, it shows as the day before in every timezone behind UTC. */
export function parseMenuDate(value: string): Date {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(value);
}

type DishForm = {
  mode: 'add' | 'edit';
  itemId?: string;
  recipeId: string;
  courseId: string;
  servings: number;
  notes: string;
};

/** The event menu: one meal laid out by course, the way a restaurant prints
 *  its menu. Edited on screen course by course; printed as a menu card
 *  (the `print-only` block at the end) through lib/print.ts, which works on
 *  Android too. Everything is written straight to /api/menus — `onChanged`
 *  re-reads the menu afterwards, so the server stays the source of truth. */
export default function EventMenu({
  menu,
  recipes,
  onChanged,
  onEditDetails,
}: {
  menu: MenuDetail;
  recipes: RecipeOption[];
  onChanged: () => Promise<void> | void;
  onEditDetails: () => void;
}) {
  const { t, i18n } = useTranslation();
  const courses: MenuCourse[] = menu.courses ?? [];
  const items: MenuItem[] = menu.items ?? [];
  const groups = useMemo(
    () => groupDishesByCourse(courses, items.map((i) => ({ ...i, courseId: i.courseId ?? null, sortOrder: i.sortOrder ?? 0 }))),
    [courses, items],
  );
  const guests = menu.guests ?? 4;

  const titleFor = (item: MenuItem) => {
    const r = recipes.find((x) => x.id === item.recipeId);
    return r ? r.translated_title || r.title : item.recipe_title;
  };

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dish, setDish] = useState<DishForm | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [newCourse, setNewCourse] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_NOTES_KEY) !== '0'; } catch { return true; }
  });

  /** Runs a set of writes, then re-reads the menu once — never leaves the
   *  screen showing half of an operation that failed partway. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      console.error('Event menu update failed:', err);
      setError(err instanceof Error ? err.message : t('planner.event.saveFailed'));
    } finally {
      await onChanged();
      setBusy(false);
    }
  };

  const send = async (path: string, method: string, body?: unknown) => {
    const res = await apiFetch(path, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(typeof json.error === 'string' ? json.error : t('planner.event.saveFailed'));
    }
  };

  const saveCourses = (next: MenuCourse[]) => send(`/api/menus/${menu.id}`, 'PATCH', { courses: next });

  /* ── Courses ─────────────────────────────────────────────────── */
  const addCourse = () => {
    const name = (newCourse ?? '').trim();
    if (!name) { setNewCourse(null); return; }
    setNewCourse(null);
    run(() => saveCourses([...courses, { id: newCourseId(courses), name }]));
  };

  const renameCourse = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (!name) return;
    run(() => saveCourses(courses.map((c) => (c.id === renaming.id ? { ...c, name } : c))));
  };

  const deleteCourse = (course: MenuCourse, dishCount: number) => {
    if (dishCount > 0 && !window.confirm(t('planner.event.confirmDeleteCourse', { name: course.name, count: dishCount }))) return;
    run(async () => {
      // Dishes first: a course removed before its dishes would leave them
      // stranded (they would show under "Other dishes", but still).
      for (const item of items.filter((i) => i.courseId === course.id)) {
        await send(`/api/menus/${menu.id}/items/${item.id}`, 'DELETE');
      }
      await saveCourses(courses.filter((c) => c.id !== course.id));
    });
  };

  /* ── Dishes ──────────────────────────────────────────────────── */
  const openAddDish = (courseId: string) =>
    setDish({ mode: 'add', recipeId: '', courseId, servings: guests, notes: '' });

  const openEditDish = (item: MenuItem) =>
    setDish({
      mode: 'edit', itemId: item.id, recipeId: item.recipeId,
      courseId: item.courseId ?? courses[0]?.id ?? '', servings: item.servings, notes: item.notes ?? '',
    });

  const saveDish = (e: React.FormEvent) => {
    e.preventDefault();
    if (!dish || !dish.recipeId) return;
    const form = dish;
    setDish(null);
    run(async () => {
      const notes = form.notes.trim() || null;
      if (form.mode === 'add') {
        await send(`/api/menus/${menu.id}/items`, 'POST', {
          recipeId: form.recipeId, courseId: form.courseId, servings: form.servings,
          mealType: menu.meal_type ?? 'dinner', ...(notes ? { notes } : {}),
        });
      } else if (form.itemId) {
        const current = items.find((i) => i.id === form.itemId);
        const moving = current && current.courseId !== form.courseId;
        // A dish moved to another course goes to the end of it.
        const sortOrder = moving
          ? items.filter((i) => i.courseId === form.courseId).reduce((max, i) => Math.max(max, (i.sortOrder ?? 0) + 1), 0)
          : undefined;
        await send(`/api/menus/${menu.id}/items/${form.itemId}`, 'PATCH', {
          courseId: form.courseId, servings: form.servings, notes,
          ...(sortOrder !== undefined ? { sortOrder } : {}),
        });
      }
    });
  };

  const removeDish = (item: MenuItem) => run(() => send(`/api/menus/${menu.id}/items/${item.id}`, 'DELETE'));

  const shiftDish = (courseDishes: MenuItem[], item: MenuItem, direction: -1 | 1) => {
    const writes = moveDish(
      courseDishes.map((d) => ({ ...d, courseId: d.courseId ?? null, sortOrder: d.sortOrder ?? 0 })),
      item.id,
      direction,
    );
    if (writes.length === 0) return;
    run(async () => {
      for (const w of writes) await send(`/api/menus/${menu.id}/items/${w.id}`, 'PATCH', { sortOrder: w.sortOrder });
    });
  };

  const setGuests = (next: number) => {
    if (next < 1 || next > 500 || next === menu.guests) return;
    run(() => send(`/api/menus/${menu.id}`, 'PATCH', { guests: next }));
  };

  const toggleNotes = (value: boolean) => {
    setShowNotes(value);
    try { localStorage.setItem(SHOW_NOTES_KEY, value ? '1' : '0'); } catch { /* ignore */ }
  };

  const date = parseMenuDate(menu.week_start);
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const mealLabel = menu.meal_type ? t(`planner.mealTypes.${menu.meal_type}`) : '';
  const iconButton = 'w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:text-zinc-400 transition-colors';

  return (
    <>
      <div className="no-print space-y-5">
        {/* ── The event itself ─────────────────────────────────── */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-primary">
                {[mealLabel, dateLabel].filter(Boolean).join(' · ')}
              </p>
              <h2 className="mt-1 font-headline text-2xl font-extrabold text-zinc-900 dark:text-zinc-100 break-words">{menu.name}</h2>
              {menu.notes && <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">{menu.notes}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onEditDetails}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">edit</span>
                {t('planner.editDetails')}
              </button>
              {canPrint() && (
                <button
                  onClick={() => { printPage(menu.name).catch((err) => console.error('Print failed:', err)); }}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold text-white bg-primary hover:opacity-90 transition-opacity"
                >
                  <span className="material-symbols-outlined text-sm">print</span>
                  {t('planner.event.printMenu')}
                </button>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{t('planner.guests')}</span>
              <div className="flex items-center rounded-xl border border-zinc-200 dark:border-zinc-700">
                <button onClick={() => setGuests(guests - 1)} disabled={busy || guests <= 1} className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-primary disabled:opacity-30" aria-label={t('planner.event.fewerGuests')}>
                  <span className="material-symbols-outlined text-[18px]">remove</span>
                </button>
                <span className="w-8 text-center text-sm font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{guests}</span>
                <button onClick={() => setGuests(guests + 1)} disabled={busy} className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-primary disabled:opacity-30" aria-label={t('planner.event.moreGuests')}>
                  <span className="material-symbols-outlined text-[18px]">add</span>
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs font-bold text-zinc-500 dark:text-zinc-400 cursor-pointer">
              <input type="checkbox" className="accent-primary w-4 h-4" checked={showNotes} onChange={(e) => toggleNotes(e.target.checked)} />
              {t('planner.event.showNotes')}
            </label>
          </div>
          {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        {/* ── Courses ──────────────────────────────────────────── */}
        {groups.map((group, groupIdx) => {
          const course = group.course;
          const isRenaming = course && renaming?.id === course.id;
          return (
            <div key={course?.id ?? '__other'} className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2 mb-3">
                {isRenaming ? (
                  <form
                    className="flex-1 flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); renameCourse(); }}
                  >
                    <input
                      autoFocus
                      value={renaming!.name}
                      onChange={(e) => setRenaming({ id: renaming!.id, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
                      className="sc-field flex-1"
                      aria-label={t('planner.event.renameCourse')}
                    />
                    <button type="submit" className="px-3 py-2 rounded-xl text-xs font-bold text-white bg-primary">{t('common.save')}</button>
                  </form>
                ) : (
                  <h3 className="flex-1 min-w-0 font-headline font-extrabold text-lg text-zinc-900 dark:text-zinc-100 break-words">
                    {course ? course.name : t('planner.event.otherDishes')}
                  </h3>
                )}
                {course && !isRenaming && (
                  <div className="flex items-center">
                    <button onClick={() => run(() => saveCourses(moveCourse(courses, course.id, -1)))} disabled={busy || groupIdx === 0} className={iconButton} aria-label={t('planner.event.moveCourseUp', { name: course.name })}>
                      <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                    </button>
                    <button onClick={() => run(() => saveCourses(moveCourse(courses, course.id, 1)))} disabled={busy || groupIdx >= courses.length - 1} className={iconButton} aria-label={t('planner.event.moveCourseDown', { name: course.name })}>
                      <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
                    </button>
                    <button onClick={() => setRenaming({ id: course.id, name: course.name })} disabled={busy} className={iconButton} aria-label={t('planner.event.renameCourse')}>
                      <span className="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button onClick={() => deleteCourse(course, group.dishes.length)} disabled={busy} className={`${iconButton} hover:!text-red-500`} aria-label={t('planner.event.deleteCourse', { name: course.name })}>
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                )}
              </div>

              {group.dishes.length === 0 && (
                <p className="text-xs text-zinc-300 dark:text-zinc-600 italic py-2">{t('planner.event.noDishes')}</p>
              )}
              <ul className="space-y-2">
                {group.dishes.map((item, idx) => (
                  <li key={item.id} className="group flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl px-3 py-2.5">
                    {course && (
                      <div className="flex flex-col -my-1">
                        <button onClick={() => shiftDish(group.dishes, item, -1)} disabled={busy || idx === 0} className="text-zinc-300 dark:text-zinc-600 hover:text-primary disabled:opacity-30 leading-none" aria-label={t('planner.event.moveDishUp', { title: titleFor(item) })}>
                          <span className="material-symbols-outlined text-[18px]">keyboard_arrow_up</span>
                        </button>
                        <button onClick={() => shiftDish(group.dishes, item, 1)} disabled={busy || idx === group.dishes.length - 1} className="text-zinc-300 dark:text-zinc-600 hover:text-primary disabled:opacity-30 leading-none" aria-label={t('planner.event.moveDishDown', { title: titleFor(item) })}>
                          <span className="material-symbols-outlined text-[18px]">keyboard_arrow_down</span>
                        </button>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <Link to={`/recipe/${item.recipeId}`} className="text-sm font-bold text-zinc-800 dark:text-zinc-200 hover:text-primary break-words">
                        {titleFor(item)}
                      </Link>
                      {item.notes && <p className="text-xs italic text-zinc-500 dark:text-zinc-400 break-words">{item.notes}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 tabular-nums">
                      {t('planner.servingsCount', { count: item.servings })}
                    </span>
                    <button onClick={() => openEditDish(item)} disabled={busy} className={iconButton} aria-label={t('planner.event.editDish', { title: titleFor(item) })}>
                      <span className="material-symbols-outlined text-[18px]">edit</span>
                    </button>
                    <button onClick={() => removeDish(item)} disabled={busy} className={`${iconButton} hover:!text-red-500`} aria-label={t('planner.removeMeal', { title: titleFor(item) })}>
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </li>
                ))}
              </ul>

              {course && (
                <button
                  onClick={() => openAddDish(course.id)}
                  disabled={busy}
                  className="mt-3 flex items-center gap-1.5 text-xs font-bold text-primary hover:opacity-70 disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  {t('planner.event.addDish')}
                </button>
              )}
            </div>
          );
        })}

        {/* ── Add a course ─────────────────────────────────────── */}
        {newCourse === null ? (
          <button
            onClick={() => setNewCourse('')}
            disabled={busy}
            className="w-full py-4 rounded-3xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 text-sm font-bold text-zinc-500 dark:text-zinc-400 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined">add</span>
            {t('planner.event.addCourse')}
          </button>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); addCourse(); }}
            className="flex items-center gap-2 bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-zinc-100 dark:border-zinc-800"
          >
            <input
              autoFocus
              value={newCourse}
              onChange={(e) => setNewCourse(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setNewCourse(null); }}
              placeholder={t('planner.event.courseNamePlaceholder')}
              className="sc-field flex-1"
              aria-label={t('planner.event.addCourse')}
            />
            <button type="submit" className="px-4 py-2.5 rounded-xl text-sm font-bold text-white bg-primary">{t('common.add')}</button>
            <button type="button" onClick={() => setNewCourse(null)} className="px-3 py-2.5 rounded-xl text-sm font-bold text-zinc-500">{t('common.cancel')}</button>
          </form>
        )}
      </div>

      {/* ── The printed menu card ──────────────────────────────── */}
      <div className="print-only menu-card">
        {(mealLabel || dateLabel) && <p className="menu-card-kicker">{[mealLabel, dateLabel].filter(Boolean).join(' · ')}</p>}
        <h1 className="menu-card-title">{menu.name}</h1>
        {menu.notes && <p className="menu-card-intro">{menu.notes}</p>}
        <div className="menu-card-rule" aria-hidden="true" />
        {groups.filter((g) => g.dishes.length > 0).map((group) => (
          <section key={group.course?.id ?? '__other'} className="menu-card-course">
            <h2 className="menu-card-course-name">{group.course ? group.course.name : t('planner.event.otherDishes')}</h2>
            {group.dishes.map((item) => (
              <div key={item.id} className="menu-card-dish">
                <p className="menu-card-dish-name">{titleFor(item)}</p>
                {showNotes && item.notes && <p className="menu-card-dish-note">{item.notes}</p>}
              </div>
            ))}
          </section>
        ))}
        <div className="menu-card-rule" aria-hidden="true" />
        <p className="menu-card-footer">{t('planner.event.forGuests', { count: guests })}</p>
      </div>

      {/* ── Add / edit a dish ──────────────────────────────────── */}
      <Modal
        open={dish !== null}
        onClose={() => setDish(null)}
        onSubmit={saveDish}
        size="sm"
        title={dish?.mode === 'edit' ? t('planner.event.editDishTitle') : t('planner.event.addDish')}
        subtitle={menu.name}
        footer={
          <>
            <ModalCancelButton onClick={() => setDish(null)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton disabled={!dish?.recipeId}>{t('common.save')}</ModalSubmitButton>
          </>
        }
      >
        {dish && (
          <div className="space-y-4">
            {dish.mode === 'add' ? (
              <Field label={t('planner.recipe')}>
                <Autocomplete
                  value={dish.recipeId}
                  options={recipes.map((r) => ({ id: r.id, label: r.translated_title || r.title }))}
                  onSelect={(id) => setDish({ ...dish, recipeId: id })}
                  onClear={() => setDish({ ...dish, recipeId: '' })}
                  placeholder={t('planner.searchRecipes')}
                  className="sc-field"
                />
              </Field>
            ) : (
              <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
                {titleFor(items.find((i) => i.id === dish.itemId) ?? ({ recipeId: dish.recipeId, recipe_title: '' } as MenuItem))}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('planner.event.course')}>
                <select value={dish.courseId} onChange={(e) => setDish({ ...dish, courseId: e.target.value })} className="sc-field cursor-pointer">
                  {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label={t('planner.servings')}>
                <input
                  type="number" min={1} required value={dish.servings}
                  onChange={(e) => setDish({ ...dish, servings: parseInt(e.target.value) || 1 })}
                  className="sc-field"
                />
              </Field>
            </div>
            <Field label={t('planner.event.dishNote')}>
              <input
                type="text" value={dish.notes}
                onChange={(e) => setDish({ ...dish, notes: e.target.value })}
                placeholder={t('planner.event.dishNotePlaceholder')}
                className="sc-field"
              />
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}
