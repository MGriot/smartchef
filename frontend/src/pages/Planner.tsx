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

interface MenuSummary {
  id: string;
  name: string;
  week_start: string;
  item_count: string | number;
}

interface MenuItem {
  id: string;
  recipeId: string;
  recipe_title: string;
  dayOfWeek: number;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  servings: number;
  notes: string | null;
}

interface MenuDetail extends MenuSummary {
  items: MenuItem[] | null;
}

interface RecipeOption {
  id: string;
  title: string;
  translated_title?: string | null;
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

const MEAL_TYPES: MenuItem['mealType'][] = ['breakfast', 'lunch', 'dinner', 'snack'];

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

function todayMonday(): string {
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
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

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newMenuName, setNewMenuName] = useState('');
  const [newMenuWeekStart, setNewMenuWeekStart] = useState(todayMonday());
  const [creating, setCreating] = useState(false);

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

  const handleCreateMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMenuName.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/menus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMenuName.trim(), weekStart: newMenuWeekStart }),
      });
      const json = await res.json();
      if (res.ok && json.data?.id) {
        setShowCreateModal(false);
        setNewMenuName('');
        await fetchMenus();
        setSelectedMenuId(json.data.id);
      } else {
        window.alert(t('planner.createFailed', { error: JSON.stringify(json.error || json) }));
      }
    } catch (err) {
      // Not just console.error: a failure here (before menus.local.ts, an
      // apiFetch against a server that isn't configured) made "New Menu"
      // look like a dead button rather than a broken one.
      console.error('Create menu failed:', err);
      window.alert(err instanceof Error ? err.message : t('planner.createFailedGeneric'));
    } finally {
      setCreating(false);
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
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="text-5xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none mb-2">{t('planner.heading')}</h1>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-md">{t('planner.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            {menus.length > 0 && (
              <>
                <select
                  value={selectedMenuId || ''}
                  onChange={e => setSelectedMenuId(e.target.value)}
                  className="px-4 py-3 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 text-sm font-bold focus:ring-2 focus:ring-primary/20"
                >
                  {menus.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({new Date(m.week_start).toLocaleDateString(i18n.language)})</option>
                  ))}
                </select>
                {menu && (
                  <button
                    onClick={handleDeleteMenu}
                    className="w-11 h-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-red-500 hover:border-red-200 flex items-center justify-center transition-colors"
                    aria-label={t('planner.deleteMenu')}
                  >
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                )}
              </>
            )}
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              {t('planner.newMenu')}
            </button>
          </div>
        </div>

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
              onClick={() => setShowCreateModal(true)}
              className="px-8 py-4 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-2"
            >
              <span className="material-symbols-outlined">add</span>
              {t('planner.startPlanning')}
            </button>
          </div>
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

        {/* Weekly nutrition summary */}
        {menu && menuNutrition && menuNutrition.weekly.caloriesKcal > 0 && (
          <div className="mt-8 bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
            <h3 className="font-headline font-bold text-lg mb-4">{t('planner.weeklyNutrition')}</h3>
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
              {t('planner.dailyAverage', { kcal: Math.round(menuNutrition.weekly.caloriesKcal / 7) })}
            </p>
            {menuNutrition.unresolved.length > 0 && (
              <p className="text-[10px] text-amber-600 mt-2 italic">
                {t('planner.nutritionUnavailable', { names: menuNutrition.unresolved.join(', ') })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Create Menu Modal ─────────────────────────────────────── */}
      <Modal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateMenu}
        size="sm"
        title={t('planner.newMenu')}
        footer={
          <>
            <ModalCancelButton onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton disabled={creating}>{creating ? t('planner.creating') : t('planner.createMenu')}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('planner.menuName')}>
            <input
              type="text" required value={newMenuName}
              onChange={e => setNewMenuName(e.target.value)}
              placeholder={t('planner.menuNamePlaceholder')}
              className="sc-field"
            />
          </Field>
          <Field label={t('planner.weekStart')}>
            <input
              type="date" required value={newMenuWeekStart}
              onChange={e => setNewMenuWeekStart(e.target.value)}
              className="sc-field"
            />
          </Field>
        </div>
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
