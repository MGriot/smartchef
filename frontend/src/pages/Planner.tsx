import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors,
  useDraggable, useDroppable, DragOverlay,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { Field } from '../components/Form';
import EventMenu, { parseMenuDate, MEAL_BADGE, applyMealPlan } from '../components/planner/EventMenu';
import {
  MEAL_TYPES, menuKind,
  type MealType, type MenuDetail, type MenuItem, type MenuKind, type MenuSummary, type RecipeOption,
} from '../components/planner/types';
import { currentMeals, defaultCourses, mealsOf, planMealChange, type EventMealType } from '../lib/eventMenu';

/** The create/edit form for a menu's own details — both kinds share it,
 *  an event menu just has more of them. */
interface DetailsForm {
  kind: MenuKind;
  name: string;
  /** The week's Monday, or the event's day. */
  date: string;
  /** The meals an event menu covers. None = a plain menu; one = that meal;
   *  several = a day menu with a section per meal. */
  meals: MealType[];
  guests: number;
  notes: string;
}

interface NutritionTotals {
  caloriesKcal: number; proteinG: number; carbsG: number; fatG: number;
  fiberG: number; sugarG: number; sodiumMg: number;
}
interface MenuNutrition {
  byDay: Record<number, NutritionTotals>;
  weekly: NutritionTotals;
  unresolved: string[];
}

/** Monday-first weekday names in the app's language — 2024-01-01 was a
 *  Monday. Capitalised because Italian, French and Spanish write them
 *  lower-case, and here they are column headings. */
function weekDays(lang: string): Array<{ idx: number; label: string }> {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, idx) => {
    const name = fmt.format(new Date(2024, 0, 1 + idx));
    return { idx, label: name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) };
  });
}

/** A planned meal you can pick up.
 *
 *  Dragging is an addition, never the only way: the card stays a normal
 *  element with its own remove button, and each day keeps its "+" button.
 *  dnd-kit's KeyboardSensor makes the drag itself reachable from the
 *  keyboard (space to lift, arrows to move, space to drop), which
 *  drag-and-drop libraries that hijack mousedown do not give you. */
function DraggableMeal({
  item, onRemove, t,
}: {
  item: MenuItem;
  onRemove: (id: string) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      className={`group bg-zinc-50 dark:bg-zinc-800/60 rounded-xl p-3 relative transition-opacity ${
        isDragging ? 'opacity-30' : ''
      }`}
    >
      {/* The grip is the drag handle rather than the whole card: making the
          card itself draggable swallows the click that opens it and fights
          text selection. */}
      <button
        type="button"
        ref={setNodeRef as unknown as React.Ref<HTMLButtonElement>}
        {...listeners}
        {...attributes}
        aria-label={t('planner.dragHandle', { title: item.recipe_title })}
        className="absolute top-2 left-2 w-5 h-5 rounded flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-primary cursor-grab active:cursor-grabbing touch-none"
      >
        <span className="material-symbols-outlined text-[15px]">drag_indicator</span>
      </button>

      <div className="pl-5">
        <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-black uppercase mb-1 ${MEAL_TYPE_STYLE[item.mealType]}`}>
          {t(`planner.mealTypes.${item.mealType}`)}
        </span>
        <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200 leading-tight pr-6">{item.recipe_title}</p>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium mt-0.5">
          {t('planner.servingsCount', { count: item.servings })}
        </p>
      </div>

      <button
        onClick={() => onRemove(item.id)}
        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 hover:text-red-500 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center"
        aria-label={t('planner.removeMeal', { title: item.recipe_title })}
      >
        <span className="material-symbols-outlined text-sm">close</span>
      </button>
    </div>
  );
}

/** One day column. Highlights while something hovers over it so the drop
 *  target is never ambiguous. */
function DayColumn({ dayIdx, children }: { dayIdx: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day-${dayIdx}` });
  return (
    <div
      ref={setNodeRef}
      className={`space-y-2 flex-1 rounded-2xl transition-colors ${
        isOver ? 'bg-primary/5 ring-2 ring-primary/30 ring-inset' : ''
      }`}
    >
      {children}
    </div>
  );
}

const MEAL_TYPE_STYLE: Record<MenuItem['mealType'], string> = {
  breakfast: 'bg-amber-100 text-amber-700',
  lunch: 'bg-sky-100 text-sky-700',
  dinner: 'bg-primary/10 text-primary',
  snack: 'bg-pink-100 text-pink-700',
};

/** A local calendar day as YYYY-MM-DD — not toISOString(), which is the
 *  UTC day and is yesterday for anyone east of Greenwich before dawn. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayMonday(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return localDay(d);
}

/** The list of menus, split by what they are so a week, a day and a single
 *  meal can be told apart at a glance: a heading per kind, and on each row
 *  an icon, the name, the meals it covers and the date in their own columns. */
function MenuSwitcher({
  menus, selectedId, onSelect, className = '',
}: {
  menus: MenuSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const weeks = menus.filter((m) => menuKind(m) === 'week');
  const events = menus.filter((m) => menuKind(m) === 'event');

  const row = (m: MenuSummary) => {
    const event = menuKind(m) === 'event';
    const date = parseMenuDate(m.week_start);
    const dateLabel = Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString(i18n.language, event
        ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
        : { day: 'numeric', month: 'short', year: 'numeric' });
    // The meals an event menu covers: one badge each, or the menu's own.
    const covered = event
      ? (() => {
          const fromCourses = mealsOf(m.courses ?? []).map((x) => x.mealType);
          return fromCourses.length > 0 ? fromCourses : m.meal_type ? [m.meal_type] : [];
        })()
      : [];
    const selected = m.id === selectedId;
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => onSelect(m.id)}
        aria-current={selected ? 'true' : undefined}
        className={`w-full grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-left px-3 py-2.5 rounded-xl border transition-colors ${
          selected
            ? 'border-primary bg-primary/5'
            : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800'
        }`}
      >
        <span className={`w-9 h-9 rounded-lg flex items-center justify-center ${selected ? 'bg-primary text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'}`}>
          <span className="material-symbols-outlined text-[20px]">{event ? 'restaurant_menu' : 'calendar_view_week'}</span>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{m.name}</span>
          <span className="flex flex-wrap items-center gap-1 mt-0.5">
            {event
              ? covered.map((meal) => (
                  <span key={meal} className={`px-1.5 py-px rounded text-[9px] font-black uppercase ${MEAL_BADGE[meal]}`}>
                    {t(`planner.mealTypes.${meal}`)}
                  </span>
                ))
              : <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{t('planner.weekBadge')}</span>}
            {event && covered.length === 0 && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{t('planner.menuBadge')}</span>
            )}
          </span>
        </span>
        <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 tabular-nums whitespace-nowrap text-right">{dateLabel}</span>
      </button>
    );
  };

  const group = (title: string, hint: string, list: MenuSummary[]) => list.length > 0 && (
    <div>
      <p className="px-3 pb-1 text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
        {title} <span className="font-semibold normal-case tracking-normal">· {hint}</span>
      </p>
      <div className="space-y-0.5">{list.map(row)}</div>
    </div>
  );

  return (
    <div className={`bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 p-3 shadow-[0_1px_8px_rgba(0,0,0,0.04)] max-h-72 overflow-y-auto space-y-3 ${className}`}>
      {group(t('planner.groupWeeks'), t('planner.groupWeeksHint'), weeks)}
      {group(t('planner.groupEvents'), t('planner.groupEventsHint'), events)}
    </div>
  );
}

export default function Planner() {
  const { t, i18n } = useTranslation();
  const DAYS = useMemo(() => weekDays(i18n.language), [i18n.language]);
  const contentLang = useStore((s) => s.contentLang);
  const [menus, setMenus] = useState<MenuSummary[]>([]);
  const [loadingMenus, setLoadingMenus] = useState(true);
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuDetail | null>(null);
  const [menuNutrition, setMenuNutrition] = useState<MenuNutrition | null>(null);

  const [allRecipes, setAllRecipes] = useState<RecipeOption[]>([]);

  // Create and edit share one modal. A create starts with form === null,
  // which is the "weekly plan or a menu for one meal?" question.
  const [detailsModal, setDetailsModal] = useState<{ mode: 'create' | 'edit'; form: DetailsForm | null } | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);

  const [addingForDay, setAddingForDay] = useState<number | null>(null);
  const [addRecipeId, setAddRecipeId] = useState('');
  const [addMealType, setAddMealType] = useState<MenuItem['mealType']>('dinner');
  const [addServings, setAddServings] = useState(4);
  const [savingItem, setSavingItem] = useState(false);

  const fetchMenus = async () => {
    setLoadingMenus(true);
    try {
      const res = await apiFetch('/api/menus');
      const json = await res.json();
      const list: MenuSummary[] = json.data || [];
      setMenus(list);
      if (!selectedMenuId && list.length > 0) setSelectedMenuId(list[0].id);
    } catch (err) {
      console.error('Failed to fetch menus:', err);
    } finally {
      setLoadingMenus(false);
    }
  };

  const fetchMenuDetail = async (id: string) => {
    try {
      const res = await apiFetch(`/api/menus/${id}`);
      const json = await res.json();
      setMenu(json.data || null);
    } catch (err) {
      console.error('Failed to fetch menu detail:', err);
    }
  };

  useEffect(() => { fetchMenus(); }, []);

  useEffect(() => {
    if (selectedMenuId) fetchMenuDetail(selectedMenuId);
    else setMenu(null);
  }, [selectedMenuId]);

  useEffect(() => {
    if (!selectedMenuId) { setMenuNutrition(null); return; }
    (async () => {
      try {
        const res = await apiFetch(`/api/menus/${selectedMenuId}/nutrition`);
        const json = await res.json();
        setMenuNutrition(json.data || null);
      } catch (err) {
        console.error('Failed to fetch menu nutrition:', err);
        setMenuNutrition(null);
      }
    })();
  }, [selectedMenuId, menu?.items?.length]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes${contentLang ? `?lang=${contentLang}` : ''}`);
        const json = await res.json();
        setAllRecipes(json.data || []);
      } catch (err) {
        console.error('Failed to fetch recipes:', err);
      }
    })();
  }, [contentLang]);

  const openCreate = () => setDetailsModal({ mode: 'create', form: null });

  const chooseKind = (kind: MenuKind) => setDetailsModal({
    mode: 'create',
    form: kind === 'week'
      ? { kind, name: '', date: todayMonday(), meals: [], guests: 4, notes: '' }
      : { kind, name: '', date: localDay(new Date()), meals: [], guests: 4, notes: '' },
  });

  const openEditDetails = () => {
    if (!menu) return;
    const date = parseMenuDate(menu.week_start);
    setDetailsModal({
      mode: 'edit',
      form: {
        kind: menuKind(menu),
        name: menu.name,
        date: Number.isNaN(date.getTime()) ? menu.week_start : localDay(date),
        meals: currentMeals(menu.courses ?? [], menu.meal_type),
        guests: menu.guests ?? 4,
        notes: menu.notes ?? '',
      },
    });
  };

  const handleSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = detailsModal?.form;
    if (!detailsModal || !form || !form.name.trim()) return;
    setSavingDetails(true);
    try {
      const event = form.kind === 'event'
        ? { guests: form.guests, notes: form.notes.trim() || null }
        : {};
      const nameFor = (key: Parameters<typeof defaultCourses>[0] extends (k: infer K) => string ? K : never) =>
        t(`planner.event.defaultCourses.${key}`);
      if (detailsModal.mode === 'create') {
        const res = await apiFetch('/api/menus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            weekStart: form.date,
            kind: form.kind,
            ...event,
            // The classic courses, named in the language the menu is being
            // written in — the user's to rename, reorder or drop.
            ...(form.kind === 'event'
              ? (() => {
                  // The classic courses once per meal chosen (or once, plain).
                  const plan = planMealChange(defaultCourses(nameFor), null, form.meals, nameFor);
                  return {
                    courses: plan.courses,
                    notes: form.notes.trim() || undefined,
                    ...(plan.mealType ? { mealType: plan.mealType } : {}),
                  };
                })()
              : {}),
          }),
        });
        const json = await res.json();
        if (res.ok && json.data?.id) {
          setDetailsModal(null);
          await fetchMenus();
          setSelectedMenuId(json.data.id);
        } else {
          window.alert(t('planner.createFailed', { error: JSON.stringify(json.error || json) }));
        }
      } else if (menu) {
        if (form.kind === 'event') {
          // Meals added, swapped or removed in the form: same rules as on the menu page.
          const plan = planMealChange(menu.courses ?? [], menu.meal_type, form.meals, nameFor);
          const lost = (menu.items ?? []).filter(i => i.courseId && plan.removeCourseIds.includes(i.courseId)).length;
          if (lost > 0) {
            const gone = currentMeals(menu.courses ?? [], menu.meal_type).filter(m => !form.meals.includes(m)).map(m => t(`planner.mealTypes.${m}`)).join(', ');
            if (!window.confirm(t('planner.event.confirmDeleteMeal', { name: gone, count: lost }))) return;
          }
          await applyMealPlan(async (path, method, body) => {
            const r = await apiFetch(path, {
              method,
              ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
            });
            if (!r.ok) throw new Error(t('planner.saveFailed', { error: path }));
          }, menu.id, menu.items ?? [], plan);
        }
        const res = await apiFetch(`/api/menus/${menu.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: form.name.trim(), weekStart: form.date, ...event }),
        });
        if (res.ok) {
          setDetailsModal(null);
          await Promise.all([fetchMenus(), fetchMenuDetail(menu.id)]);
        } else {
          const json = await res.json().catch(() => ({}));
          window.alert(t('planner.saveFailed', { error: JSON.stringify(json.error || json) }));
        }
      }
    } catch (err) {
      // Not just console.error: a failure here (before menus.local.ts, an
      // apiFetch against a server that isn't configured) made "New Menu"
      // look like a dead button rather than a broken one.
      console.error('Save menu failed:', err);
      window.alert(err instanceof Error ? err.message : t('planner.createFailedGeneric'));
    } finally {
      setSavingDetails(false);
    }
  };

  const openAddModal = (dayIdx: number) => {
    setAddingForDay(dayIdx);
    setAddRecipeId('');
    setAddMealType('dinner');
    setAddServings(4);
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!menu || addingForDay === null || !addRecipeId) return;
    setSavingItem(true);
    try {
      const res = await apiFetch(`/api/menus/${menu.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipeId: addRecipeId,
          dayOfWeek: addingForDay,
          mealType: addMealType,
          servings: addServings,
        }),
      });
      if (res.ok) {
        setAddingForDay(null);
        await fetchMenuDetail(menu.id);
        await fetchMenus();
      } else {
        const json = await res.json();
        window.alert(t('planner.addFailed', { error: JSON.stringify(json.error || json) }));
      }
    } catch (err) {
      console.error('Add item failed:', err);
      window.alert(err instanceof Error ? err.message : t('planner.addFailedGeneric'));
    } finally {
      setSavingItem(false);
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!menu) return;
    try {
      const res = await apiFetch(`/api/menus/${menu.id}/items/${itemId}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchMenuDetail(menu.id);
        await fetchMenus();
      }
    } catch (err) {
      console.error('Remove item failed:', err);
    }
  };

  const handleDeleteMenu = async () => {
    if (!menu) return;
    if (!window.confirm(t('planner.confirmDeleteMenu', { name: menu.name }))) return;
    try {
      const res = await apiFetch(`/api/menus/${menu.id}`, { method: 'DELETE' });
      if (res.ok) {
        setSelectedMenuId(null);
        await fetchMenus();
      }
    } catch (err) {
      console.error('Delete menu failed:', err);
    }
  };

  const itemsForDay = (dayIdx: number) => (menu?.items || []).filter(it => it.dayOfWeek === dayIdx);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingItem = (menu?.items || []).find(it => it.id === draggingId) ?? null;

  const sensors = useSensors(
    // A small distance threshold before a drag starts, so a tap on the
    // handle can still be a click rather than a one-pixel drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id));

  /** Optimistic: the card moves immediately and the write follows. A failure
   *  re-fetches rather than trying to reverse the move by hand — the server
   *  is the truth and re-reading it is both simpler and correct. */
  const handleDragEnd = async (e: DragEndEvent) => {
    setDraggingId(null);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!menu || !overId?.startsWith('day-')) return;

    const itemId = String(e.active.id);
    const dayOfWeek = Number(overId.slice(4));
    const items = menu.items ?? [];
    const item = items.find(it => it.id === itemId);
    if (!item || item.dayOfWeek === dayOfWeek) return;

    // Optimistic move, then persist.
    setMenu({ ...menu, items: items.map(it => (it.id === itemId ? { ...it, dayOfWeek } : it)) });

    try {
      const res = await apiFetch(`/api/menus/${menu.id}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayOfWeek }),
      });
      if (!res.ok) throw new Error('move failed');
      await fetchMenus();
    } catch (err) {
      console.error('Move failed:', err);
      await fetchMenuDetail(menu.id);
    }
  };

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-6xl mx-auto">
        {/* no-print: the only thing this page prints is an event menu's
            card (components/planner/EventMenu.tsx). */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10 no-print">
          <div>
            <h1 className="text-5xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none mb-2">{t('planner.heading')}</h1>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-md">{t('planner.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {menu && (
              <>
                {menuKind(menu) === 'week' && (
                  <button
                    onClick={openEditDetails}
                    className="w-11 h-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-primary flex items-center justify-center transition-colors"
                    aria-label={t('planner.editDetails')}
                  >
                    <span className="material-symbols-outlined text-lg">edit</span>
                  </button>
                )}
                <button
                  onClick={handleDeleteMenu}
                  className="w-11 h-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-red-500 hover:border-red-200 flex items-center justify-center transition-colors"
                  aria-label={t('planner.deleteMenu')}
                >
                  <span className="material-symbols-outlined text-lg">delete</span>
                </button>
              </>
            )}
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              {t('planner.newMenu')}
            </button>
          </div>
        </div>

        {menus.length > 0 && (
          <MenuSwitcher
            menus={menus}
            selectedId={selectedMenuId}
            onSelect={setSelectedMenuId}
            className="mb-8 no-print"
          />
        )}

        {loadingMenus ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary"></div>
          </div>
        ) : !menu ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center mb-6">
              <span className="material-symbols-outlined text-4xl text-primary">calendar_month</span>
            </div>
            <h2 className="text-2xl font-bold text-zinc-800 dark:text-zinc-200 mb-2">{t('planner.emptyTitle')}</h2>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mb-8">
              {t('planner.emptyHint')}
            </p>
            <button
              onClick={openCreate}
              className="px-8 py-4 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-2"
            >
              <span className="material-symbols-outlined">add</span>
              {t('planner.startPlanning')}
            </button>
          </div>
        ) : menuKind(menu) === 'event' ? (
          <EventMenu
            menu={menu}
            recipes={allRecipes}
            onChanged={async () => { await Promise.all([fetchMenuDetail(menu.id), fetchMenus()]); }}
            onEditDetails={openEditDetails}
          />
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
              {DAYS.map(day => (
                <div key={day.idx} className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 flex flex-col">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-headline font-bold text-zinc-800 dark:text-zinc-200">{day.label}</h3>
                    <button
                      onClick={() => openAddModal(day.idx)}
                      className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center hover:bg-primary/20 transition-colors"
                      aria-label={t('planner.addRecipeFor', { day: day.label })}
                    >
                      <span className="material-symbols-outlined text-lg">add</span>
                    </button>
                  </div>
                  <DayColumn dayIdx={day.idx}>
                    {itemsForDay(day.idx).length === 0 && (
                      <p className="text-xs text-zinc-300 dark:text-zinc-600 italic py-4 text-center">{t('planner.noMeals')}</p>
                    )}
                    {itemsForDay(day.idx).map(item => (
                      <DraggableMeal key={item.id} item={item} onRemove={handleRemoveItem} t={t as never} />
                    ))}
                  </DayColumn>
                </div>
              ))}
            </div>

            {/* Follows the cursor while dragging, so the card is visible
                over every column rather than clipped inside its own. */}
            <DragOverlay dropAnimation={null}>
              {draggingItem && (
                <div className="bg-white dark:bg-zinc-800 rounded-xl p-3 shadow-2xl border border-primary/40 rotate-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-black uppercase mb-1 ${MEAL_TYPE_STYLE[draggingItem.mealType]}`}>
                    {t(`planner.mealTypes.${draggingItem.mealType}`)}
                  </span>
                  <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200 leading-tight">{draggingItem.recipe_title}</p>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}

        {/* Nutrition summary — the week, or the whole event menu. `weekly`
            is the total over every planned dish either way. */}
        {menu && menuNutrition && menuNutrition.weekly.caloriesKcal > 0 && (
          <div className="mt-8 bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 no-print">
            <h3 className="font-headline font-bold text-lg mb-4">
              {menuKind(menu) === 'event' ? t('planner.event.menuNutrition') : t('planner.weeklyNutrition')}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-4">
              {[
                { key: 'caloriesKcal', label: t('recipeDetail.calories'), unit: 'kcal' },
                { key: 'proteinG', label: t('recipeDetail.protein'), unit: 'g' },
                { key: 'carbsG', label: t('recipeDetail.carbs'), unit: 'g' },
                { key: 'fatG', label: t('recipeDetail.fat'), unit: 'g' },
                { key: 'fiberG', label: t('recipeDetail.fiber'), unit: 'g' },
                { key: 'sugarG', label: t('recipeDetail.sugar'), unit: 'g' },
                { key: 'sodiumMg', label: t('recipeDetail.sodium'), unit: 'mg' },
              ].map(f => (
                <div key={f.key} className="text-center py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-900">
                  <p className="text-[9px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-1">{f.label}</p>
                  <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200 tabular-nums">
                    {Math.round((menuNutrition.weekly as any)[f.key])} {f.unit}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {menuKind(menu) === 'event'
                ? t('planner.event.perGuest', { kcal: Math.round(menuNutrition.weekly.caloriesKcal / Math.max(1, menu.guests ?? 1)) })
                : t('planner.dailyAverage', { kcal: Math.round(menuNutrition.weekly.caloriesKcal / 7) })}
            </p>
            {menuNutrition.unresolved.length > 0 && (
              <p className="text-[10px] text-amber-600 mt-2 italic">
                {t('planner.nutritionUnavailable', { names: menuNutrition.unresolved.join(', ') })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Create / edit a menu ─────────────────────────────────── */}
      <Modal
        open={detailsModal !== null}
        onClose={() => setDetailsModal(null)}
        onSubmit={detailsModal?.form ? handleSaveDetails : undefined}
        size="sm"
        title={detailsModal?.mode === 'edit' ? t('planner.editDetails') : t('planner.newMenu')}
        subtitle={detailsModal?.form
          ? (detailsModal.form.kind === 'event' ? t('planner.kindEvent') : t('planner.kindWeek'))
          : t('planner.kindQuestion')}
        footer={
          <>
            {detailsModal?.mode === 'create' && detailsModal.form ? (
              <ModalCancelButton onClick={() => setDetailsModal({ mode: 'create', form: null })}>{t('common.back')}</ModalCancelButton>
            ) : (
              <ModalCancelButton onClick={() => setDetailsModal(null)}>{t('common.cancel')}</ModalCancelButton>
            )}
            {detailsModal?.form && (
              <ModalSubmitButton disabled={savingDetails}>
                {savingDetails
                  ? t('planner.creating')
                  : detailsModal.mode === 'edit' ? t('common.save') : t('planner.createMenu')}
              </ModalSubmitButton>
            )}
          </>
        }
      >
        {detailsModal && !detailsModal.form && (
          /* Step one: which kind of menu. Both live in this one Planner;
             they differ in what a dish is placed by — a weekday, or a course. */
          <div className="grid grid-cols-1 gap-3">
            {([
              { kind: 'week' as const, icon: 'calendar_month', title: t('planner.kindWeek'), hint: t('planner.kindWeekHint') },
              { kind: 'event' as const, icon: 'restaurant_menu', title: t('planner.kindEvent'), hint: t('planner.kindEventHint') },
            ]).map(option => (
              <button
                key={option.kind}
                type="button"
                onClick={() => chooseKind(option.kind)}
                className="flex items-start gap-4 text-left p-4 rounded-2xl border border-zinc-200 dark:border-zinc-700 hover:border-primary hover:bg-primary/5 transition-colors"
              >
                <span className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <span className="material-symbols-outlined">{option.icon}</span>
                </span>
                <span className="min-w-0">
                  <span className="block font-bold text-zinc-900 dark:text-zinc-100">{option.title}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {detailsModal?.form && (() => {
          const form = detailsModal.form;
          const update = (patch: Partial<DetailsForm>) => setDetailsModal({ ...detailsModal, form: { ...form, ...patch } });
          return (
            <div className="space-y-4">
              <Field label={t('planner.menuName')}>
                <input
                  type="text" required value={form.name}
                  onChange={e => update({ name: e.target.value })}
                  placeholder={form.kind === 'event' ? t('planner.eventNamePlaceholder') : t('planner.menuNamePlaceholder')}
                  className="sc-field"
                />
              </Field>
              <Field label={form.kind === 'event' ? t('planner.eventDate') : t('planner.weekStart')}>
                <input
                  type="date" required value={form.date}
                  onChange={e => update({ date: e.target.value })}
                  className="sc-field"
                />
              </Field>
              {form.kind === 'event' && (
                <>
                  <Field label={t('planner.meals')} hint={t('planner.mealsHint')}>
                    <div className="flex flex-wrap gap-2">
                      {MEAL_TYPES.map(mt => {
                        const on = form.meals.includes(mt);
                        // A day menu cannot lose its last meal in one go.
                        const locked = on && form.meals.length === 1 && detailsModal.mode === 'edit' && (menu ? currentMeals(menu.courses ?? [], menu.meal_type).length > 1 : false);
                        return (
                          <button
                            key={mt}
                            type="button"
                            aria-pressed={on}
                            disabled={locked}
                            onClick={() => update({ meals: on ? form.meals.filter(m => m !== mt) : [...form.meals, mt] })}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors disabled:opacity-50 ${
                              on ? `${MEAL_BADGE[mt]} border-transparent` : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-primary'
                            }`}
                          >
                            <span className="material-symbols-outlined text-[16px]">{on ? 'check' : 'add'}</span>
                            {t(`planner.mealTypes.${mt}`)}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <Field label={t('planner.guests')}>
                    <input
                      type="number" min={1} max={500} required value={form.guests}
                      onChange={e => update({ guests: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="sc-field"
                    />
                  </Field>
                  <Field label={t('planner.eventNotes')}>
                    <textarea
                      rows={2} value={form.notes}
                      onChange={e => update({ notes: e.target.value })}
                      placeholder={t('planner.eventNotesPlaceholder')}
                      className="sc-field"
                    />
                  </Field>
                </>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* ─── Add Recipe Modal ──────────────────────────────────────── */}
      <Modal
        open={addingForDay !== null}
        onClose={() => setAddingForDay(null)}
        onSubmit={handleAddItem}
        size="sm"
        title={t('planner.addRecipe')}
        subtitle={DAYS.find(d => d.idx === addingForDay)?.label}
        footer={
          <>
            <ModalCancelButton onClick={() => setAddingForDay(null)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton disabled={savingItem || !addRecipeId}>
              {savingItem ? t('planner.adding') : t('planner.addToPlan')}
            </ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('planner.recipe')}>
            <Autocomplete
              value={addRecipeId}
              options={allRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
              onSelect={(id) => setAddRecipeId(id)}
              onClear={() => setAddRecipeId('')}
              placeholder={t('planner.searchRecipes')}
              className="sc-field"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('planner.meal')}>
              <select
                value={addMealType}
                onChange={e => setAddMealType(e.target.value as MenuItem['mealType'])}
                className="sc-field cursor-pointer"
              >
                {MEAL_TYPES.map(mt => <option key={mt} value={mt}>{t(`planner.mealTypes.${mt}`)}</option>)}
              </select>
            </Field>
            <Field label={t('planner.servings')}>
              <input
                type="number" min={1} required value={addServings}
                onChange={e => setAddServings(parseInt(e.target.value) || 1)}
                className="sc-field"
              />
            </Field>
          </div>
        </div>
      </Modal>

    </AppLayout>
  );
}
