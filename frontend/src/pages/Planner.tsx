import React, { useEffect, useState } from 'react';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

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

const DAYS = [
  { idx: 0, label: 'Monday' },
  { idx: 1, label: 'Tuesday' },
  { idx: 2, label: 'Wednesday' },
  { idx: 3, label: 'Thursday' },
  { idx: 4, label: 'Friday' },
  { idx: 5, label: 'Saturday' },
  { idx: 6, label: 'Sunday' },
];

const MEAL_TYPES: MenuItem['mealType'][] = ['breakfast', 'lunch', 'dinner', 'snack'];

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
        window.alert(`Failed to create menu: ${JSON.stringify(json.error || json)}`);
      }
    } catch (err) {
      console.error('Create menu failed:', err);
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
        window.alert(`Failed to add recipe: ${JSON.stringify(json.error || json)}`);
      }
    } catch (err) {
      console.error('Add item failed:', err);
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
    if (!window.confirm(`Delete menu "${menu.name}"? This cannot be undone.`)) return;
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

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10">
          <div>
            <h1 className="text-5xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none mb-2">Meal Planner</h1>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-md">Organize your recipes into a weekly culinary schedule.</p>
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
                    <option key={m.id} value={m.id}>{m.name} ({new Date(m.week_start).toLocaleDateString()})</option>
                  ))}
                </select>
                {menu && (
                  <button
                    onClick={handleDeleteMenu}
                    className="w-11 h-11 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-red-500 hover:border-red-200 flex items-center justify-center transition-colors"
                    aria-label="Delete menu"
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
              New Menu
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
            <h2 className="text-2xl font-bold text-zinc-800 dark:text-zinc-200 mb-2">No menu yet</h2>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mb-8">
              Create a weekly menu, then assign recipes to each day — prep times and portions come straight from the recipe.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-8 py-4 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-2"
            >
              <span className="material-symbols-outlined">add</span>
              Start Planning
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
            {DAYS.map(day => (
              <div key={day.idx} className="bg-white dark:bg-zinc-900 rounded-3xl p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 flex flex-col">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-headline font-bold text-zinc-800 dark:text-zinc-200">{day.label}</h3>
                  <button
                    onClick={() => openAddModal(day.idx)}
                    className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center hover:bg-primary/20 transition-colors"
                    aria-label={`Add recipe for ${day.label}`}
                  >
                    <span className="material-symbols-outlined text-lg">add</span>
                  </button>
                </div>
                <div className="space-y-2 flex-1">
                  {itemsForDay(day.idx).length === 0 && (
                    <p className="text-xs text-zinc-300 dark:text-zinc-600 italic py-4 text-center">No meals planned</p>
                  )}
                  {itemsForDay(day.idx).map(item => (
                    <div key={item.id} className="group bg-zinc-50 dark:bg-zinc-900 rounded-xl p-3 relative">
                      <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-black uppercase mb-1 ${MEAL_TYPE_STYLE[item.mealType]}`}>
                        {item.mealType}
                      </span>
                      <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200 leading-tight pr-6">{item.recipe_title}</p>
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium mt-0.5">{item.servings} servings</p>
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      >
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Weekly nutrition summary */}
        {menu && menuNutrition && menuNutrition.weekly.caloriesKcal > 0 && (
          <div className="mt-8 bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
            <h3 className="font-headline font-bold text-lg mb-4">Weekly Nutrition</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-4">
              {[
                { key: 'caloriesKcal', label: 'Calories', unit: 'kcal' },
                { key: 'proteinG', label: 'Protein', unit: 'g' },
                { key: 'carbsG', label: 'Carbs', unit: 'g' },
                { key: 'fatG', label: 'Fat', unit: 'g' },
                { key: 'fiberG', label: 'Fiber', unit: 'g' },
                { key: 'sugarG', label: 'Sugar', unit: 'g' },
                { key: 'sodiumMg', label: 'Sodium', unit: 'mg' },
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
              Daily average: ≈{Math.round(menuNutrition.weekly.caloriesKcal / 7)} kcal/day
            </p>
            {menuNutrition.unresolved.length > 0 && (
              <p className="text-[10px] text-amber-600 mt-2 italic">
                Nutrition unavailable for: {menuNutrition.unresolved.join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ─── Create Menu Modal ─────────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white dark:bg-zinc-900 w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-3xl font-black text-zinc-900 dark:text-zinc-100 mb-8">New Menu</h2>
            <form onSubmit={handleCreateMenu} className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2 px-1">Menu Name</label>
                <input
                  type="text" required autoFocus value={newMenuName}
                  onChange={e => setNewMenuName(e.target.value)}
                  placeholder="e.g. Week of Aug 10"
                  className="w-full px-6 py-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold transition-all"
                />
              </div>
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2 px-1">Week Starting (Monday)</label>
                <input
                  type="date" required value={newMenuWeekStart}
                  onChange={e => setNewMenuWeekStart(e.target.value)}
                  className="w-full px-6 py-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold transition-all"
                />
              </div>
              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setShowCreateModal(false)} className="flex-1 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all">Cancel</button>
                <button type="submit" disabled={creating} className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50">
                  {creating ? 'Creating…' : 'Create Menu'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Add Recipe Modal ──────────────────────────────────────── */}
      {addingForDay !== null && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setAddingForDay(null)} />
          <div className="relative bg-white dark:bg-zinc-900 w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-3xl font-black text-zinc-900 dark:text-zinc-100 mb-1">Add Recipe</h2>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mb-8">{DAYS.find(d => d.idx === addingForDay)?.label}</p>
            <form onSubmit={handleAddItem} className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2 px-1">Recipe</label>
                <Autocomplete
                  value={addRecipeId}
                  options={allRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
                  onSelect={(id) => setAddRecipeId(id)}
                  onClear={() => setAddRecipeId('')}
                  placeholder="Type to search recipes…"
                  className="w-full px-6 py-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold transition-all"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2 px-1">Meal</label>
                  <select
                    value={addMealType}
                    onChange={e => setAddMealType(e.target.value as MenuItem['mealType'])}
                    className="w-full px-6 py-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold transition-all appearance-none"
                  >
                    {MEAL_TYPES.map(mt => <option key={mt} value={mt}>{mt[0].toUpperCase() + mt.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2 px-1">Servings</label>
                  <input
                    type="number" min={1} required value={addServings}
                    onChange={e => setAddServings(parseInt(e.target.value) || 1)}
                    className="w-full px-6 py-4 bg-zinc-50 dark:bg-zinc-900 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 dark:text-zinc-100 font-bold transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setAddingForDay(null)} className="flex-1 py-4 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-2xl font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all">Cancel</button>
                <button type="submit" disabled={savingItem || !addRecipeId} className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50">
                  {savingItem ? 'Adding…' : 'Add to Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
