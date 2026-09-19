import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { canPrint, printPage } from '../lib/print';
import { pickIngredientName } from '../lib/ingredientDisplay';

interface MenuSummary {
  id: string;
  name: string;
  week_start: string;
}

interface RecipeOption {
  id: string;
  title: string;
  translated_title?: string | null;
}

interface ShoppingListSource {
  recipeId: string;
  recipeTitle: string;
  servings: number;
  quantity: number;
  unitSymbol: string;
}

interface ShoppingListItem {
  id: string;
  ingredientId?: string;
  ingredientName?: string;
  ingredientPluralName?: string;
  totalQuantity?: number;
  quantityText?: string;
  unit?: { symbol: string; name: string };
  isChecked: boolean;
  sourceDetails: ShoppingListSource[];
  categoryId?: string;
  categoryName?: string;
  categoryColor?: string;
  categoryIcon?: string;
  categorySortOrder?: number;
}

interface ShoppingListDetail {
  id: string;
  name: string;
  menuId?: string;
  items: ShoppingListItem[];
  createdAt: string;
}

interface ShoppingListSummary {
  id: string;
  name: string;
  menu_id: string | null;
  item_count: string | number;
  created_at: string;
}

/** Aisles in walking order, uncategorised last. Mirrors groupByAisle() in
 *  services/shopping.local.ts and shopping.service.ts — the three have to
 *  agree or the screen, the offline screen and the Markdown export show the
 *  same list in three different orders. */
function groupByAisle(items: ShoppingListItem[], otherLabel: string) {
  const buckets = new Map<string, {
    key: string; name: string; color?: string; icon?: string;
    sortOrder: number; items: ShoppingListItem[];
  }>();

  for (const item of items) {
    const key = item.categoryId ?? '__other__';
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        name: item.categoryName ?? otherLabel,
        color: item.categoryColor,
        icon: item.categoryIcon,
        sortOrder: item.categoryName ? (item.categorySortOrder ?? 0) : Number.MAX_SAFE_INTEGER,
        items: [],
      });
    }
    buckets.get(key)!.items.push(item);
  }

  for (const bucket of buckets.values()) {
    bucket.items.sort((a, b) => (a.ingredientName ?? '').localeCompare(b.ingredientName ?? ''));
  }

  return [...buckets.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

function displayName(item: ShoppingListItem, t: TFunction): string {
  if (!item.ingredientName) return t('shopping.ingredientFallback');
  return pickIngredientName(item.ingredientName, item.ingredientPluralName, item.totalQuantity ?? null);
}

function formatQty(item: ShoppingListItem, t: TFunction): string {
  if (item.quantityText) return item.quantityText;
  if (item.totalQuantity) {
    const v = item.totalQuantity;
    return `${v % 1 === 0 ? v : v.toFixed(1)} ${item.unit?.symbol ?? ''}`.trim();
  }
  return t('shopping.toTaste');
}

export default function ShoppingList() {
  const { t, i18n } = useTranslation();
  const cart = useStore((s) => s.shoppingCart);
  const removeFromCart = useStore((s) => s.removeFromShoppingCart);
  const updateCartServings = useStore((s) => s.updateShoppingCartServings);
  const addToCart = useStore((s) => s.addToShoppingCart);
  const clearCart = useStore((s) => s.clearShoppingCart);
  const contentLang = useStore((s) => s.contentLang);

  const [menus, setMenus] = useState<MenuSummary[]>([]);
  const [selectedMenuId, setSelectedMenuId] = useState('');
  const [allRecipes, setAllRecipes] = useState<RecipeOption[]>([]);
  const [pickerRecipeId, setPickerRecipeId] = useState('');
  const [pickerServings, setPickerServings] = useState(4);

  const [pastLists, setPastLists] = useState<ShoppingListSummary[]>([]);
  const [activeList, setActiveList] = useState<ShoppingListDetail | null>(null);
  const [viewMode, setViewMode] = useState<'ingredient' | 'recipe'>('ingredient');
  const [generating, setGenerating] = useState(false);
  const [listName, setListName] = useState('');
  // Generation used to fail entirely into console.error, which is how a
  // missing offline route read as "the button does nothing" instead of as
  // an error. Anything that stops a list being generated says so here.
  const [error, setError] = useState<string | null>(null);

  const fetchMenus = async () => {
    try {
      const res = await apiFetch('/api/menus');
      const json = await res.json();
      setMenus(json.data || []);
    } catch (err) { console.error('Failed to fetch menus:', err); }
  };

  const fetchPastLists = async () => {
    try {
      const res = await apiFetch('/api/shopping');
      const json = await res.json();
      setPastLists(json.data || []);
    } catch (err) { console.error('Failed to fetch shopping lists:', err); }
  };

  useEffect(() => {
    fetchMenus();
    fetchPastLists();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes${contentLang ? `?lang=${contentLang}` : ''}`);
        const json = await res.json();
        setAllRecipes(json.data || []);
      } catch (err) { console.error('Failed to fetch recipes:', err); }
    })();
  }, [contentLang]);

  const openList = async (id: string) => {
    try {
      const res = await apiFetch(`/api/shopping/${id}`);
      const json = await res.json();
      setActiveList(json.data);
      setViewMode('ingredient');
    } catch (err) { console.error('Failed to load shopping list:', err); }
  };

  const handleGenerateFromMenu = async () => {
    if (!selectedMenuId) return;
    setGenerating(true);
    setError(null);
    try {
      const menuName = menus.find(m => m.id === selectedMenuId)?.name || t('shopping.menuFallback');
      const res = await apiFetch('/api/shopping/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuId: selectedMenuId, listName: listName.trim() || t('shopping.listFromMenu', { menu: menuName }) }),
      });
      const json = await res.json();
      if (res.ok) {
        setActiveList(json.data);
        setViewMode('ingredient');
        await fetchPastLists();
      } else {
        setError(typeof json.error === 'string' ? json.error : JSON.stringify(json.error || json));
      }
    } catch (err) {
      console.error('Generate from menu failed:', err);
      setError(err instanceof Error ? err.message : t('shopping.generateFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateFromCart = async () => {
    if (cart.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/shopping/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipes: cart.map(c => ({ recipeId: c.recipeId, servings: c.servings })),
          listName: listName.trim() || t('shopping.heading'),
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setActiveList(json.data);
        setViewMode('ingredient');
        clearCart();
        await fetchPastLists();
      } else {
        setError(typeof json.error === 'string' ? json.error : JSON.stringify(json.error || json));
      }
    } catch (err) {
      console.error('Generate from cart failed:', err);
      setError(err instanceof Error ? err.message : t('shopping.generateFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleAddToCart = () => {
    if (!pickerRecipeId) return;
    const recipe = allRecipes.find(r => r.id === pickerRecipeId);
    if (!recipe) return;
    addToCart({ recipeId: recipe.id, title: recipe.translated_title || recipe.title, servings: pickerServings });
    setPickerRecipeId('');
    setPickerServings(4);
  };

  const handleToggleCheck = async (itemId: string, checked: boolean) => {
    if (!activeList) return;
    setActiveList({ ...activeList, items: activeList.items.map(it => it.id === itemId ? { ...it, isChecked: checked } : it) });
    try {
      await apiFetch(`/api/shopping/${activeList.id}/items/${itemId}/check`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked }),
      });
    } catch (err) {
      console.error('Failed to update item:', err);
    }
  };

  const handleDeleteList = async () => {
    if (!activeList) return;
    if (!window.confirm(t('shopping.confirmDelete', { name: activeList.name }))) return;
    try {
      const res = await apiFetch(`/api/shopping/${activeList.id}`, { method: 'DELETE' });
      if (res.ok) {
        setActiveList(null);
        await fetchPastLists();
      }
    } catch (err) { console.error('Delete failed:', err); }
  };

  const progress = useMemo(() => {
    if (!activeList) return { checked: 0, total: 0 };
    return { checked: activeList.items.filter(i => i.isChecked).length, total: activeList.items.length };
  }, [activeList]);

  const byRecipe = useMemo(() => {
    if (!activeList) return [];
    const map = new Map<string, { recipeTitle: string; items: (ShoppingListItem & { forQuantity: string })[] }>();
    for (const item of activeList.items) {
      for (const src of item.sourceDetails) {
        if (!map.has(src.recipeId)) map.set(src.recipeId, { recipeTitle: src.recipeTitle, items: [] });
        map.get(src.recipeId)!.items.push({ ...item, forQuantity: `${src.quantity % 1 === 0 ? src.quantity : src.quantity.toFixed(1)} ${src.unitSymbol}` });
      }
    }
    return Array.from(map.entries()).map(([recipeId, v]) => ({ recipeId, ...v }));
  }, [activeList]);

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-6xl mx-auto">
        {!activeList ? (
          <>
            <div className="mb-10">
              <h1 className="text-5xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none mb-2">{t('shopping.heading')}</h1>
              <p className="text-zinc-500 dark:text-zinc-400 max-w-xl">{t('shopping.subtitle')}</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
              {/* From a menu */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-xl mb-1">{t('shopping.fromMenu')}</h3>
                <p className="text-zinc-400 dark:text-zinc-500 text-sm mb-5">{t('shopping.fromMenuHint')}</p>
                {menus.length === 0 ? (
                  <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">{t('shopping.noMenus')}</p>
                ) : (
                  <>
                    <select
                      value={selectedMenuId}
                      onChange={e => setSelectedMenuId(e.target.value)}
                      className="w-full px-5 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold mb-4"
                    >
                      <option value="">{t('shopping.selectMenu')}</option>
                      {menus.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <button
                      onClick={handleGenerateFromMenu}
                      disabled={!selectedMenuId || generating}
                      className="w-full py-3.5 bg-primary text-white rounded-xl font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-lg">auto_awesome</span>
                      {generating ? t('shopping.generating') : t('shopping.generate')}
                    </button>
                  </>
                )}
              </div>

              {/* From cart */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-xl mb-1">{t('shopping.fromRecipes')}</h3>
                <p className="text-zinc-400 dark:text-zinc-500 text-sm mb-5">{t('shopping.fromRecipesHint')}</p>

                <div className="flex gap-2 mb-4">
                  <div className="flex-1">
                    <Autocomplete
                      value={pickerRecipeId}
                      options={allRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
                      onSelect={(id) => setPickerRecipeId(id)}
                      onClear={() => setPickerRecipeId('')}
                      placeholder={t('shopping.searchRecipes')}
                      className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
                    />
                  </div>
                  <input
                    type="number" min={1} value={pickerServings}
                    onChange={e => setPickerServings(parseInt(e.target.value) || 1)}
                    className="w-16 px-2 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-center"
                  />
                  <button
                    onClick={handleAddToCart}
                    disabled={!pickerRecipeId}
                    className="w-11 h-11 rounded-xl bg-zinc-900 text-white flex items-center justify-center disabled:opacity-30 shrink-0"
                  >
                    <span className="material-symbols-outlined text-lg">add</span>
                  </button>
                </div>

                {cart.length === 0 ? (
                  <p className="text-sm text-zinc-300 dark:text-zinc-600 italic text-center py-4">{t('shopping.noRecipes')}</p>
                ) : (
                  <div className="space-y-2 mb-4">
                    {cart.map(c => (
                      <div key={c.recipeId} className="flex items-center justify-between gap-2 bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-2.5">
                        <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 truncate">{c.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <input
                            type="number" min={1} value={c.servings}
                            onChange={e => updateCartServings(c.recipeId, parseInt(e.target.value) || 1)}
                            className="w-14 px-2 py-1 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-center"
                          />
                          <button onClick={() => removeFromCart(c.recipeId)} className="text-zinc-400 dark:text-zinc-500 hover:text-red-500">
                            <span className="material-symbols-outlined text-lg">close</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={handleGenerateFromCart}
                  disabled={cart.length === 0 || generating}
                  className="w-full py-3.5 bg-primary text-white rounded-xl font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-lg">auto_awesome</span>
                  {generating ? t('shopping.generating') : t('shopping.generate')}
                </button>
              </div>
            </div>

            {error && (
              <p className="px-5 py-4 bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/50 rounded-2xl text-sm font-medium text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            {/* Past lists */}
            {pastLists.length > 0 && (
              <div>
                <h3 className="font-headline font-bold text-xl mb-4">{t('shopping.recentLists')}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {pastLists.map(l => (
                    <button
                      key={l.id}
                      onClick={() => openList(l.id)}
                      className="text-left bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 transition-all"
                    >
                      <p className="font-bold text-zinc-800 dark:text-zinc-200 truncate mb-1">{l.name}</p>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium">{t('shopping.itemCount', { count: Number(l.item_count) })} · {new Date(l.created_at).toLocaleDateString(i18n.language)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2 no-print">
              <button onClick={() => setActiveList(null)} className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors text-sm font-bold">
                <span className="material-symbols-outlined text-lg">arrow_back</span>
                {t('common.back')}
              </button>
              <div className="flex items-center gap-3">
                <a
                  href={`/api/shopping/${activeList.id}/export`}
                  className="flex items-center gap-1.5 px-4 py-2 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full text-xs font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  {t('shopping.export')}
                </a>
                {canPrint() && (
                  <button
                    onClick={() => printPage(activeList.name)}
                    className="flex items-center gap-1.5 px-4 py-2 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full text-xs font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                  >
                    <span className="material-symbols-outlined text-sm">print</span>
                    {t('print.printList')}
                  </button>
                )}
                <button onClick={handleDeleteList} className="flex items-center gap-1.5 px-4 py-2 text-red-500 hover:bg-red-50 rounded-full text-xs font-bold transition-colors">
                  <span className="material-symbols-outlined text-sm">delete</span>
                  {t('common.delete')}
                </button>
              </div>
            </div>

            <h1 className="text-4xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight mb-4">{activeList.name}</h1>
            <p className="print-only text-xs mb-4">
              {t('print.printedFrom')} · {progress.total - progress.checked}/{progress.total}
            </p>

            <div className="flex items-center gap-4 mb-8 no-print">
              <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: progress.total ? `${(progress.checked / progress.total) * 100}%` : '0%' }}
                />
              </div>
              <span className="text-sm font-bold text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{t('shopping.checked', { checked: progress.checked, total: progress.total })}</span>
            </div>

            <div className="flex gap-2 mb-6 bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl w-max no-print">
              <button
                onClick={() => setViewMode('ingredient')}
                className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${viewMode === 'ingredient' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'}`}
              >
                {t('shopping.byIngredient')}
              </button>
              <button
                onClick={() => setViewMode('recipe')}
                className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${viewMode === 'recipe' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'}`}
              >
                {t('shopping.byRecipe')}
              </button>
            </div>

            {viewMode === 'ingredient' ? (
              <div className="space-y-4">
                {groupByAisle(activeList.items, t('shopping.otherAisle')).map(group => {
                  const remaining = group.items.filter(i => !i.isChecked).length;
                  return (
                    <div key={group.key} className="bg-white dark:bg-zinc-900 rounded-3xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 overflow-hidden print-keep-together">
                      {/* The aisle header carries the category's own colour and
                          icon, so the list reads the same way the Library and
                          the ingredient cards already do. */}
                      <div className="flex items-center gap-2.5 px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40">
                        <span
                          className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-[11px] shrink-0"
                          style={{ backgroundColor: group.color || '#71717a' }}
                        >
                          <RenderFaIcon name={group.icon || 'TbCarrot'} />
                        </span>
                        <h3 className="text-[11px] font-black uppercase tracking-widest text-zinc-500 dark:text-zinc-400 flex-1 min-w-0 truncate">
                          {group.name}
                        </h3>
                        <span className="text-[11px] font-bold text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
                          {remaining > 0 ? `${remaining}/${group.items.length}` : '✓'}
                        </span>
                      </div>
                      <div className="px-6 py-1 divide-y divide-zinc-50 dark:divide-zinc-800">
                        {group.items.map(item => (
                          <label key={item.id} className={`flex items-center gap-4 py-3.5 px-2 cursor-pointer transition-opacity ${item.isChecked ? 'opacity-40' : ''}`}>
                            <input
                              type="checkbox" checked={item.isChecked}
                              onChange={e => handleToggleCheck(item.id, e.target.checked)}
                              className="w-5 h-5 rounded border-zinc-300 dark:border-zinc-600 text-primary focus:ring-primary/30 shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-bold text-zinc-800 dark:text-zinc-200 ${item.isChecked ? 'line-through' : ''}`}>{displayName(item, t)}</p>
                              {item.sourceDetails.length > 0 && (
                                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium truncate">
                                  {t('shopping.usedIn')} {item.sourceDetails.map(s => s.recipeTitle).join(', ')}
                                </p>
                              )}
                            </div>
                            <span className="text-sm text-zinc-500 dark:text-zinc-400 font-semibold tabular-nums shrink-0">{formatQty(item, t)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-5">
                {byRecipe.map(group => (
                  <div key={group.recipeId} className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                    <h3 className="font-headline font-bold text-lg mb-3">{group.recipeTitle}</h3>
                    <div className="divide-y divide-zinc-50 dark:divide-zinc-800">
                      {group.items.map(item => (
                        <label key={item.id} className={`flex items-center gap-4 py-3 cursor-pointer transition-opacity ${item.isChecked ? 'opacity-40' : ''}`}>
                          <input
                            type="checkbox" checked={item.isChecked}
                            onChange={e => handleToggleCheck(item.id, e.target.checked)}
                            className="w-5 h-5 rounded border-zinc-300 dark:border-zinc-600 text-primary focus:ring-primary/30 shrink-0"
                          />
                          <span className={`flex-1 text-sm font-bold text-zinc-800 dark:text-zinc-200 ${item.isChecked ? 'line-through' : ''}`}>{displayName(item, t)}</span>
                          <span className="text-sm text-zinc-500 dark:text-zinc-400 font-semibold tabular-nums">{item.forQuantity}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
