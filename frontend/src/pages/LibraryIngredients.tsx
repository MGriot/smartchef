import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import { ResolvedImage } from '../components/CoverImage';
import SynonymsEditor from '../components/SynonymsEditor';
import TagPicker from '../components/TagPicker';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { INGREDIENT_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalDeleteButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, IconPicker, TranslationRows } from '../components/Form';

/** Short month names in the UI language. LibrarySeasonality.tsx already
 *  derives its own month labels this way; doing the same here avoids
 *  hardcoding English and avoids adding 12 more keys per locale file. */
function useMonthLabels(): string[] {
  const { i18n } = useTranslation();
  return React.useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: 'short' });
    // Any known non-leap year — only the month component is used.
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 1)));
  }, [i18n.language]);
}


export default function LibraryIngredients() {
  const { t } = useTranslation();
  const monthLabels = useMonthLabels();
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [allTags, setAllTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [viewingIng, setViewingIng] = useState<any>(null);
  const [mergingIng, setMergingIng] = useState<any>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeQuery, setMergeQuery] = useState('');
  const [merging, setMerging] = useState(false);

  // Modals state
  const [showModal, setShowModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  
  // Ingredient form
  const [editingIng, setEditingIng] = useState<any>(null);
  const emptyNutrition = { caloriesKcal: '', proteinG: '', carbsG: '', fatG: '', fiberG: '', sugarG: '', sodiumMg: '' };
  const [form, setForm] = useState({ name: '', categoryId: '', description: '', icon: 'egg', imageUrls: [] as string[], tagIds: [] as string[], seasonalMonths: [] as number[], synonyms: [] as string[], parentIngredientId: null as string | null, nutrition: { ...emptyNutrition } });
  const [parentQuery, setParentQuery] = useState('');
  const [translations, setTranslations] = useState<{lang: string, text: string}[]>([]);

  // Category form
  const [editingCat, setEditingCat] = useState<any>(null);
  const [catForm, setCatForm] = useState({ name: '', description: '', icon: 'category', color: '#71717a' });
  const [catTranslations, setCatTranslations] = useState<{ lang: string; name: string }[]>([]);

  const contentLang = useStore((s) => s.contentLang);
  const langQuery = contentLang ? `?lang=${contentLang}` : '';

  const fetchData = async () => {
    setLoading(true);
    try {
      const [ingRes, catRes, tagRes] = await Promise.all([
        apiFetch(`/api/ingredients${langQuery}`),
        apiFetch(`/api/ingredients/categories${langQuery}`),
        apiFetch(`/api/tags${langQuery}`)
      ]);
      const ings = await ingRes.json();
      const cats = await catRes.json();
      const tgs = await tagRes.json();
      setIngredients(ings.data || []);
      setCategories(cats.data || []);
      setAllTags(tgs.data || []);
    } catch (err) {
      console.error('Fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleTagFilter = (tagId: string) => {
    setActiveTagFilters(f => f.includes(tagId) ? f.filter(x => x !== tagId) : [...f, tagId]);
  };

  const matchesFilters = (ing: any) => {
    const q = search.trim().toLowerCase();
    if (q) {
      const inName = ing.name?.toLowerCase().includes(q) || ing.translated_name?.toLowerCase().includes(q);
      const inSynonyms = (ing.synonyms || []).some((s: string) => s.toLowerCase().includes(q));
      if (!inName && !inSynonyms) return false;
    }
    if (activeTagFilters.length > 0) {
      const ingTagIds = (ing.tags || []).map((tg: any) => tg.id);
      if (!activeTagFilters.some(id => ingTagIds.includes(id))) return false;
    }
    return true;
  };

  const isFiltering = search.trim().length > 0 || activeTagFilters.length > 0;
  const uncategorized = ingredients.filter(i => !i.category_id || !categories.some(c => c.id === i.category_id));

  useEffect(() => {
    fetchData();
  }, [contentLang]);

  /* ─── INGREDIENT ACTIONS ───────────────────── */
  const handleOpenModal = (ing: any = null) => {
    if (ing) {
      setEditingIng(ing);
      setForm({
        name: ing.name,
        categoryId: ing.category_id,
        description: ing.description || '',
        icon: ing.icon || 'egg',
        imageUrls: ing.image_urls || [],
        tagIds: (ing.tags || []).map((tg: any) => tg.id),
        seasonalMonths: ing.seasonal_months || [],
        synonyms: ing.synonyms || [],
        parentIngredientId: ing.parent_ingredient_id ?? null,
        nutrition: {
          caloriesKcal: ing.calories_kcal ?? '',
          proteinG: ing.protein_g ?? '',
          carbsG: ing.carbs_g ?? '',
          fatG: ing.fat_g ?? '',
          fiberG: ing.fiber_g ?? '',
          sugarG: ing.sugar_g ?? '',
          sodiumMg: ing.sodium_mg ?? '',
        },
      });
      setTranslations(ing.translations || []);
      setParentQuery(ing.parent_name || '');
    } else {
      setEditingIng(null);
      setForm({
        name: '',
        categoryId: categories[0]?.id || '',
        description: '',
        icon: 'egg',
        imageUrls: [],
        tagIds: [],
        seasonalMonths: [],
        synonyms: [],
        parentIngredientId: null,
        nutrition: { ...emptyNutrition },
      });
      setTranslations([]);
      setParentQuery('');
    }
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.categoryId) {
      const firstCat = categories[0]?.id;
      if (!firstCat) return alert(t('library.ingredients.waitForCategories'));
      form.categoryId = firstCat;
    }
    
    // Clean empty translations
    const cleanTranslations = translations.filter(t => t.lang.trim() && t.text.trim());

    // Nutrition fields are entered as text inputs; blank means "not set" (omit),
    // not zero — an ingredient with no data shouldn't silently count as 0 kcal.
    const nutritionFields = Object.fromEntries(
      Object.entries(form.nutrition).map(([k, v]) => [k, v === '' ? undefined : parseFloat(String(v))])
    );

    const { nutrition, ...formRest } = form;
    const url = editingIng ? `/api/ingredients/${editingIng.id}` : '/api/ingredients';
    const method = editingIng ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formRest, ...nutritionFields, translations: cleanTranslations })
      });
      const result = await res.json();
      if (res.ok) {
        setShowModal(false);
        fetchData();
      } else {
        alert(t('library.ingredients.saveFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      alert(t('library.ingredients.networkErrorSaving'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('library.ingredients.confirmDeleteIngredient'))) return;
    try {
      const res = await apiFetch(`/api/ingredients/${id}`, { method: 'DELETE' });
      if (res.ok) fetchData();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleMerge = async () => {
    if (!mergingIng || !mergeTargetId) return;
    setMerging(true);
    try {
      const res = await apiFetch(`/api/ingredients/${mergingIng.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: mergeTargetId }),
      });
      const result = await res.json();
      if (res.ok) {
        setMergingIng(null);
        setMergeTargetId('');
        setMergeQuery('');
        fetchData();
      } else {
        alert(t('library.ingredients.mergeFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      alert(t('library.ingredients.networkErrorMerging'));
    } finally {
      setMerging(false);
    }
  };

  // Translation helpers — <TranslationRows> owns the per-row edit/remove.
  const addTranslation = () => {
    setTranslations([...translations, { lang: '', text: '' }]);
  };


  /* ─── CATEGORY ACTIONS ───────────────────── */
  const [reorderingCats, setReorderingCats] = useState(false);

  // Optimistic: the rail reorders immediately and the write follows. A
  // failure re-fetches rather than trying to undo the swap by hand.
  const moveCategory = async (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= categories.length) return;
    const next = [...categories];
    [next[idx], next[target]] = [next[target], next[idx]];
    setCategories(next);
    setReorderingCats(true);
    try {
      const res = await apiFetch('/api/ingredients/categories/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map((c) => c.id) }),
      });
      if (!res.ok) throw new Error('reorder failed');
    } catch (err) {
      console.error('Category reorder failed:', err);
      fetchData();
    } finally {
      setReorderingCats(false);
    }
  };

  const handleOpenCatModal = (cat: any = null) => {
    if (cat) {
      setEditingCat(cat);
      setCatForm({ name: cat.name, description: cat.description || '', icon: cat.icon || 'category', color: cat.color || '#71717a' });
      setCatTranslations(cat.translations || []);
    } else {
      setEditingCat(null);
      setCatForm({ name: '', description: '', icon: 'category', color: '#71717a' });
      setCatTranslations([]);
    }
    setShowCategoryModal(true);
  };

  // Category translation helpers
  const addCatTranslation = () => setCatTranslations([...catTranslations, { lang: '', name: '' }]);

  const handleDeleteCat = async (id: string) => {
    if (!window.confirm(t('library.ingredients.confirmDeleteCategory'))) return;
    try {
      const res = await apiFetch(`/api/ingredients/categories/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setShowCategoryModal(false);
        fetchData();
      } else {
         const result = await res.json();
         alert(t('library.ingredients.cannotDeleteCategory', { error: result.error || t('library.ingredients.unknownError') }));
      }
    } catch (err) {
      alert(t('library.ingredients.networkErrorDeletingCategory'));
    }
  };

  const handleSaveCat = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingCat ? `/api/ingredients/categories/${editingCat.id}` : '/api/ingredients/categories';
    const method = editingCat ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...catForm, translations: catTranslations.filter(t => t.lang.trim() && t.name.trim()) })
      });
      const result = await res.json();
      if (res.ok) {
        setShowCategoryModal(false);
        // if we updated a category, we should refresh the data to show updated category names in the list
        fetchData();
      } else {
        alert(t('library.ingredients.saveFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      alert(t('library.ingredients.networkErrorSavingCategory'));
    }
  };


  const categorySidebar = (
    <>
      <div className="pt-8 mb-2">
         <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 tracking-[0.2em] uppercase px-4">{t('library.ingredients.categories')}</p>
      </div>
      {/* This order is the shopping list's aisle order — the list groups by
          category and walks them in sort_order — so it is worth being able
          to set. Up/down rather than drag-and-drop: this rail is narrow, the
          arrows work by keyboard, and dragging here would pull in a
          dependency for one control. */}
      {categories.map((c, idx) => (
          <div key={c.id} className="w-full flex items-center gap-1 pr-1 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-all group">
             <button
                onClick={() => handleOpenCatModal(c)}
                className="flex-1 min-w-0 flex items-center gap-2 px-4 py-2 text-zinc-500 dark:text-zinc-400 font-medium text-xs text-left"
             >
                <RenderFaIcon name={c.icon || 'TbTag'} className="text-[16px] shrink-0" color={c.color} />
                <span className="truncate">{c.translated_name || c.name}</span>
                <span className="material-symbols-outlined text-[14px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity shrink-0">edit</span>
             </button>
             <span className="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <button
                   type="button"
                   onClick={() => moveCategory(idx, -1)}
                   disabled={idx === 0 || reorderingCats}
                   title={t('library.ingredients.moveUp')}
                   aria-label={t('library.ingredients.moveUp')}
                   className="w-5 h-6 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary disabled:opacity-25 disabled:hover:text-zinc-400"
                >
                   <span className="material-symbols-outlined text-[15px]">keyboard_arrow_up</span>
                </button>
                <button
                   type="button"
                   onClick={() => moveCategory(idx, 1)}
                   disabled={idx === categories.length - 1 || reorderingCats}
                   title={t('library.ingredients.moveDown')}
                   aria-label={t('library.ingredients.moveDown')}
                   className="w-5 h-6 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary disabled:opacity-25 disabled:hover:text-zinc-400"
                >
                   <span className="material-symbols-outlined text-[15px]">keyboard_arrow_down</span>
                </button>
             </span>
          </div>
      ))}
      <button
         onClick={() => handleOpenCatModal()}
         className="w-full mt-2 flex justify-center items-center gap-2 px-4 py-2 bg-zinc-100/50 dark:bg-zinc-800/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400 rounded-xl font-bold text-xs transition-all border border-zinc-200 dark:border-zinc-700 border-dashed"
      >
         <span className="material-symbols-outlined text-[16px]">add</span>
         {t('library.ingredients.newCategory')}
      </button>
    </>
  );

  const renderIngredientRow = (ing: any) => (
    <tr key={ing.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
      <td className="py-6 pl-4">
        <div className={`flex items-center gap-4 ${ing.parent_ingredient_id ? 'pl-8' : ''}`}>
          <div className="relative w-12 h-12 shrink-0">
            {ing.image_urls?.[0] ? (
              <>
                <ResolvedImage
                  src={ing.image_urls[0]}
                  onClick={() => setPreviewImage({ url: ing.image_urls[0], name: ing.translated_name || ing.name })}
                  className="w-12 h-12 rounded-2xl object-cover bg-zinc-100 dark:bg-zinc-800 cursor-zoom-in"
                />
                <span
                  className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center text-[11px] text-white ring-2 ring-white"
                  style={{ backgroundColor: ing.category_color || '#71717a' }}
                >
                  <RenderFaIcon name={ing.icon || 'TbCarrot'} />
                </span>
              </>
            ) : (
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-[24px] text-white"
                style={{ backgroundColor: ing.category_color || '#71717a' }}
              >
                <RenderFaIcon name={ing.icon || 'TbCarrot'} />
              </div>
            )}
          </div>
          <button type="button" onClick={() => setViewingIng(ing)} className="text-left">
            <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight hover:text-primary transition-colors">{ing.translated_name || ing.name}</p>
            {ing.parent_name && <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500">↳ {t('library.ingredients.varietyOf', { name: ing.parent_name })}</p>}
          </button>
        </div>
      </td>
      <td className="py-6">
         <div className="flex flex-wrap gap-1 max-w-[200px]">
            {ing.translations?.map((tr: any, idx: number) => (
               <span key={idx} className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[9px] font-black uppercase rounded border border-zinc-200 dark:border-zinc-700">
                  {tr.lang}: {tr.text}
               </span>
            ))}
            {(!ing.translations || ing.translations.length === 0) && (
               <span className="text-zinc-300 dark:text-zinc-600 text-[10px] italic">{t('library.ingredients.none')}</span>
            )}
         </div>
      </td>
      <td className="py-6">
         <div className="flex flex-wrap gap-1 max-w-[220px]">
            {ing.tags?.map((tg: any) => (
               <span
                  key={tg.id}
                  className="px-2 py-0.5 text-white text-[9px] font-black uppercase rounded-full"
                  style={{ backgroundColor: tg.color || '#3f3f46' }}
               >
                  {tg.translated_name || tg.name}
               </span>
            ))}
            {(!ing.tags || ing.tags.length === 0) && (
               <span className="text-zinc-300 dark:text-zinc-600 text-[10px] italic">{t('library.ingredients.none')}</span>
            )}
         </div>
      </td>
      <td className="py-6 text-right pr-4">
         <div className="flex justify-end gap-2">
            <Link
              to={`/?q=${encodeURIComponent(ing.name)}`}
              title={t('library.ingredients.usedInRecipes')}
              className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all"
            >
              <span className="material-symbols-outlined text-xl">search</span>
            </Link>
            <button onClick={() => handleOpenModal(ing)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
              <span className="material-symbols-outlined text-xl">edit</span>
            </button>
            <button onClick={() => { setMergingIng(ing); setMergeTargetId(''); setMergeQuery(''); }} title={t('library.ingredients.mergeInto')} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
              <span className="material-symbols-outlined text-xl">call_merge</span>
            </button>
            <button onClick={() => handleDelete(ing.id)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
              <span className="material-symbols-outlined text-xl">delete</span>
            </button>
         </div>
      </td>
    </tr>
  );

  const renderIngredientCard = (ing: any) => (
    <div
      key={ing.id}
      className={`group relative bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 hover:border-zinc-200 dark:hover:border-zinc-700 hover:shadow-md transition-all overflow-hidden flex flex-col ${ing.parent_ingredient_id ? 'ring-1 ring-zinc-100 dark:ring-zinc-800' : ''}`}
    >
      <button type="button" onClick={() => setViewingIng(ing)} className="text-left flex-1 flex flex-col">
        <div className="relative w-full aspect-square bg-zinc-50 dark:bg-zinc-900">
          {ing.image_urls?.[0] ? (
            <ResolvedImage src={ing.image_urls[0]} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[40px] text-white" style={{ backgroundColor: ing.category_color || '#71717a' }}>
              <RenderFaIcon name={ing.icon || 'TbCarrot'} />
            </div>
          )}
          {ing.seasonal_months?.length > 0 && (
            <span className="absolute top-2 right-2 w-7 h-7 rounded-full bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm flex items-center justify-center text-[13px] text-primary shadow-sm" title={t('library.ingredients.hasSeasonality')}>
              <span className="material-symbols-outlined text-[15px]">eco</span>
            </span>
          )}
        </div>
        <div className="p-4 flex-1">
          <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight group-hover:text-primary transition-colors">{ing.translated_name || ing.name}</p>
          {ing.parent_name && <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 mt-0.5">↳ {t('library.ingredients.varietyOf', { name: ing.parent_name })}</p>}
          {ing.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {ing.tags.slice(0, 3).map((tg: any) => (
                <span key={tg.id} className="px-2 py-0.5 text-white text-[9px] font-black uppercase rounded-full" style={{ backgroundColor: tg.color || '#3f3f46' }}>
                  {tg.translated_name || tg.name}
                </span>
              ))}
              {ing.tags.length > 3 && <span className="px-2 py-0.5 text-zinc-400 dark:text-zinc-500 text-[9px] font-black">+{ing.tags.length - 3}</span>}
            </div>
          )}
        </div>
      </button>
      <div className="flex items-center justify-end gap-1 px-2 pb-2">
        <Link to={`/?q=${encodeURIComponent(ing.name)}`} title={t('library.ingredients.usedInRecipes')} className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
          <span className="material-symbols-outlined text-lg">search</span>
        </Link>
        <button onClick={() => handleOpenModal(ing)} className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
          <span className="material-symbols-outlined text-lg">edit</span>
        </button>
        <button onClick={() => { setMergingIng(ing); setMergeTargetId(''); setMergeQuery(''); }} title={t('library.ingredients.mergeInto')} className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
          <span className="material-symbols-outlined text-lg">call_merge</span>
        </button>
        <button onClick={() => handleDelete(ing.id)} className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
          <span className="material-symbols-outlined text-lg">delete</span>
        </button>
      </div>
    </div>
  );

  // Files each variety (parent_ingredient_id set, and the parent is also in
  // this same filtered set) directly after its base ingredient rather than
  // wherever alphabetical order would otherwise scatter it — one level
  // deep only (a variety-of-a-variety still just lists under whichever
  // root it isn't itself, no recursive tree needed for what this is for).
  const sortWithVariants = (items: any[]) => {
    const ids = new Set(items.map(i => i.id));
    const byParent = new Map<string, any[]>();
    const roots: any[] = [];
    for (const item of items) {
      if (item.parent_ingredient_id && ids.has(item.parent_ingredient_id)) {
        if (!byParent.has(item.parent_ingredient_id)) byParent.set(item.parent_ingredient_id, []);
        byParent.get(item.parent_ingredient_id)!.push(item);
      } else {
        roots.push(item);
      }
    }
    const result: any[] = [];
    for (const root of roots) {
      result.push(root);
      for (const child of byParent.get(root.id) || []) result.push(child);
    }
    return result;
  };

  const categorySection = (categoryId: string | null, catName: string, catIcon: string | undefined, catColor: string | undefined, items: any[]) => {
    const matched = sortWithVariants(items.filter(matchesFilters));
    if (isFiltering && matched.length === 0) return null;
    return (
      <details key={categoryId || 'uncategorized'} open className="group/section">
        <summary className="flex items-center justify-between cursor-pointer list-none py-4 px-2 select-none">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-[16px]" style={{ backgroundColor: catColor || '#71717a' }}>
              <RenderFaIcon name={catIcon || 'TbTag'} />
            </span>
            <span className="font-black text-zinc-900 dark:text-zinc-100 text-lg">{catName}</span>
            <span className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 text-[10px] font-bold rounded-full">{matched.length}</span>
          </div>
          <span className="material-symbols-outlined text-zinc-400 dark:text-zinc-500 transition-transform group-open/section:rotate-180">expand_more</span>
        </summary>
        {viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-6">
            {matched.map(renderIngredientCard)}
          </div>
        ) : (
          <div className="overflow-x-auto pb-4">
            <table className="w-full">
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                {matched.map(renderIngredientRow)}
              </tbody>
            </table>
          </div>
        )}
      </details>
    );
  };

  return (
    <>
      <AppLayout librarySection="ingredients" sidebarExtra={categorySidebar}>
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">{t('library.ingredients.eyebrow')}</p>
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">{t('library.ingredients.heading')}</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              {t('library.ingredients.addNew')}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 mb-6">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 text-[18px]">search</span>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('library.ingredients.searchPlaceholder')}
                className="w-full pl-11 pr-4 py-3 bg-white dark:bg-zinc-900 rounded-full border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
              />
            </div>
            <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 rounded-full border border-zinc-200 dark:border-zinc-700 p-1 shrink-0">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                title={t('library.ingredients.gridView')}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'}`}
              >
                <span className="material-symbols-outlined text-lg">grid_view</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                title={t('library.ingredients.listView')}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${viewMode === 'list' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'}`}
              >
                <span className="material-symbols-outlined text-lg">view_list</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map(tg => (
                <button
                  key={tg.id}
                  onClick={() => toggleTagFilter(tg.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                    activeTagFilters.includes(tg.id) ? 'text-white border-transparent' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                  }`}
                  style={activeTagFilters.includes(tg.id) ? { backgroundColor: tg.color || '#3f3f46' } : undefined}
                >
                  {tg.translated_name || tg.name}
                </button>
              ))}
            </div>
          </div>

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] px-10 py-4 shadow-sm border border-zinc-100 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {loading ? (
              <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.ingredients.loading')}</p>
            ) : (
              <>
                {categories.map(c => categorySection(c.id, c.translated_name || c.name, c.icon, c.color, ingredients.filter(i => i.category_id === c.id)))}
                {uncategorized.length > 0 && categorySection(null, t('library.ingredients.uncategorized'), 'TbTag', '#71717a', uncategorized)}
              </>
            )}
          </section>
      </AppLayout>

      {/* ─── Ingredient Modal ───────────────────────────────────────────── */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="lg"
        title={editingIng ? t('library.ingredients.editIngredient') : t('library.ingredients.newIngredient')}
        subtitle={t('library.ingredients.modalSubtitle')}
        footer={
          <>
            <ModalCancelButton onClick={() => setShowModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>
              {editingIng ? t('library.ingredients.updateCatalog') : t('library.ingredients.addToCatalog')}
            </ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title={t('library.ingredients.sectionIdentity')}>
            <FieldRow>
              <Field label={t('library.ingredients.nameNative')}>
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder={t('library.ingredients.namePlaceholder')}
                  className="sc-field"
                />
              </Field>
              {/* Not `required` — a stored categoryId that no longer matches any
                  currently-loaded category (a deleted/merged category, or this
                  modal opening before categories finish loading) makes a required
                  <select> fail the browser's OWN native validation, which blocks
                  the submit event before handleSave ever runs — silently, no
                  error, the button just appears to do nothing. handleSave already
                  has a fallback for a missing categoryId (defaults to the first
                  loaded category, or alerts clearly); that fallback can only run
                  if the browser lets the submit through in the first place. */}
              <Field label={t('library.ingredients.category')}>
                <select
                  value={form.categoryId}
                  onChange={e => setForm({ ...form, categoryId: e.target.value })}
                  className="sc-field cursor-pointer"
                >
                  {!categories.some(c => c.id === form.categoryId) && (
                    <option value={form.categoryId}>{t('library.ingredients.loadingOption')}</option>
                  )}
                  {categories.map(c => <option key={c.id} value={c.id}>{c.translated_name || c.name}</option>)}
                </select>
              </Field>
            </FieldRow>
            <Field label={t('library.ingredients.notesLabel')}>
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder={t('library.ingredients.notesPlaceholder')}
                className="sc-field h-24 resize-none font-medium"
              />
            </Field>
          </FormSection>

          <FormSection title={t('library.ingredients.sectionAppearance')}>
            <Field label={t('library.ingredients.selectIcon')}>
              <IconPicker icons={INGREDIENT_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
            <Field label={t('library.ingredients.referencePhotos')}>
              <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({ ...form, imageUrls: urls })} />
            </Field>
          </FormSection>

          <FormSection
            title={t('library.ingredients.sectionClassification')}
            description={t('library.ingredients.sectionClassificationHint')}
          >
            <Field label={t('library.ingredients.tags')}>
              <TagPicker by="id" value={form.tagIds} onChange={tagIds => setForm({ ...form, tagIds })} />
            </Field>
            <Field
              label={t('library.ingredients.varietyOfLabel')}
              hint={!form.parentIngredientId ? t('library.ingredients.varietyOfHint') : undefined}
            >
              <div className="relative">
                <input
                  type="text"
                  value={parentQuery}
                  onChange={e => { setParentQuery(e.target.value); setForm({ ...form, parentIngredientId: null }); }}
                  placeholder={t('library.ingredients.searchBaseIngredient')}
                  autoComplete="off"
                  className="sc-field"
                />
                {parentQuery.trim() && !form.parentIngredientId && (
                  <div className="absolute z-10 mt-2 max-h-56 w-full overflow-y-auto rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg">
                    {ingredients
                      .filter(i => i.id !== editingIng?.id)
                      .filter(i => (i.translated_name || i.name).toLowerCase().includes(parentQuery.trim().toLowerCase()))
                      .slice(0, 30)
                      .map(i => (
                        <button
                          key={i.id}
                          type="button"
                          onClick={() => { setForm({ ...form, parentIngredientId: i.id }); setParentQuery(i.translated_name || i.name); }}
                          className="w-full px-5 py-3 text-left text-sm font-bold text-zinc-700 dark:text-zinc-300 first:rounded-t-2xl last:rounded-b-2xl hover:bg-zinc-50 dark:hover:bg-zinc-800"
                        >
                          {i.translated_name || i.name}
                        </button>
                      ))}
                  </div>
                )}
                {form.parentIngredientId && (
                  <button
                    type="button"
                    onClick={() => { setForm({ ...form, parentIngredientId: null }); setParentQuery(''); }}
                    className="mt-2 flex items-center gap-1 text-xs font-bold text-zinc-400 dark:text-zinc-500 hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-sm">close</span>
                    {t('library.ingredients.clear')}
                  </button>
                )}
              </div>
            </Field>
            <Field
              label={t('library.ingredients.seasonality')}
              hint={form.seasonalMonths.length === 0 ? t('library.ingredients.seasonalityNoData') : undefined}
            >
              <div className="sc-panel grid grid-cols-4 gap-2 p-3 sm:grid-cols-6">
                {monthLabels.map((label, i) => {
                  const month = i + 1;
                  const active = form.seasonalMonths.includes(month);
                  return (
                    <button
                      key={month}
                      type="button"
                      onClick={() => setForm({
                        ...form,
                        seasonalMonths: active
                          ? form.seasonalMonths.filter(m => m !== month)
                          : [...form.seasonalMonths, month].sort((a, b) => a - b),
                      })}
                      className={`rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                        active
                          ? 'border-transparent bg-primary text-white shadow-md shadow-primary/30'
                          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:border-primary/40 hover:text-primary'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </Field>
          </FormSection>

          <FormSection title={t('library.ingredients.nutritionPer100g')}>
            <div className="sc-panel grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
              {[
                { key: 'caloriesKcal', label: t('library.ingredients.kcal') },
                { key: 'proteinG', label: t('library.ingredients.proteinG') },
                { key: 'carbsG', label: t('library.ingredients.carbsG') },
                { key: 'fatG', label: t('library.ingredients.fatG') },
                { key: 'fiberG', label: t('library.ingredients.fiberG') },
                { key: 'sugarG', label: t('library.ingredients.sugarG') },
                { key: 'sodiumMg', label: t('library.ingredients.sodiumMg') },
              ].map(f => (
                <label key={f.key} className="min-w-0">
                  <span className="sc-label mb-1 truncate">{f.label}</span>
                  <input
                    type="number" step="any" min="0"
                    value={(form.nutrition as any)[f.key]}
                    onChange={e => setForm({ ...form, nutrition: { ...form.nutrition, [f.key]: e.target.value } })}
                    className="sc-field-inset"
                  />
                </label>
              ))}
            </div>
          </FormSection>

          <FormSection
            title={t('library.ingredients.sectionNaming')}
            description={t('library.ingredients.sectionNamingHint')}
            action={<AddLangButton onClick={addTranslation} label={t('library.ingredients.addLang')} />}
          >
            <Field label={t('library.ingredients.synonyms')}>
              <SynonymsEditor value={form.synonyms} onChange={synonyms => setForm({ ...form, synonyms })} />
            </Field>
            <Field label={t('library.ingredients.globalTranslations')}>
              <TranslationRows
                value={translations}
                onChange={setTranslations}
                textKey="text"
                emptyLabel={t('library.ingredients.noTranslationsLong')}
                langPlaceholder={t('library.ingredients.langCodePlaceholder')}
                textPlaceholder={t('library.ingredients.translatedNamePlaceholder')}
              />
            </Field>
          </FormSection>
        </div>
      </Modal>

      {/* ─── Category Modal ─────────────────────────────────────────────── */}
      <Modal
        open={showCategoryModal}
        onClose={() => setShowCategoryModal(false)}
        onSubmit={handleSaveCat}
        size="sm"
        zIndex={110}
        title={editingCat ? t('library.ingredients.editCategory') : t('library.ingredients.newCategory')}
        subtitle={t('library.ingredients.categoryModalSubtitle')}
        footer={
          <>
            {editingCat && (
              <ModalDeleteButton onClick={() => handleDeleteCat(editingCat.id)} label={t('library.ingredients.editCategory')} />
            )}
            <ModalCancelButton onClick={() => setShowCategoryModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>
              {editingCat ? t('library.ingredients.update') : t('library.ingredients.create')}
            </ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title={t('library.ingredients.sectionIdentity')}>
            <Field label={t('library.ingredients.categoryName')}>
              <input
                type="text" required value={catForm.name}
                onChange={e => setCatForm({ ...catForm, name: e.target.value })}
                placeholder={t('library.ingredients.categoryNamePlaceholder')}
                className="sc-field"
              />
            </Field>
          </FormSection>

          <FormSection title={t('library.ingredients.sectionAppearance')}>
            <Field label={t('library.ingredients.color')}>
              <div className="flex items-center gap-3">
                <input
                  type="color" value={catForm.color}
                  onChange={e => setCatForm({ ...catForm, color: e.target.value })}
                  className="h-12 w-16 shrink-0 cursor-pointer rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-transparent p-1"
                />
                <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">{catForm.color}</span>
              </div>
            </Field>
            <Field label={t('library.ingredients.visualIcon')}>
              {/* Selected tile is painted in the category's own colour, so this
                  one can't use the shared <IconPicker>. */}
              <div className="sc-panel grid grid-cols-8 gap-2 max-h-52 overflow-y-auto p-3">
                {INGREDIENT_ICONS.map(ic => {
                  const selected = catForm.icon === ic;
                  return (
                    <button
                      key={ic}
                      type="button"
                      title={ic}
                      aria-pressed={selected}
                      onClick={() => setCatForm({ ...catForm, icon: ic })}
                      className={`flex aspect-square w-full items-center justify-center rounded-xl border transition-all ${
                        selected
                          ? 'border-transparent text-white shadow-md'
                          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:border-primary/40 hover:text-primary'
                      }`}
                      style={selected ? { backgroundColor: catForm.color } : undefined}
                    >
                      <RenderFaIcon name={ic} className="text-[19px]" />
                    </button>
                  );
                })}
              </div>
            </Field>
          </FormSection>

          <FormSection
            title={t('library.ingredients.translations')}
            action={<AddLangButton onClick={addCatTranslation} label={t('library.ingredients.addLang')} />}
          >
            <TranslationRows
              value={catTranslations}
              onChange={setCatTranslations}
              emptyLabel={t('library.ingredients.noTranslations')}
              langPlaceholder={t('library.ingredients.langCodePlaceholder')}
              textPlaceholder={t('library.ingredients.translatedNamePlaceholder')}
            />
          </FormSection>
        </div>
      </Modal>

      {/* ─── Photo Lightbox ─────────────────────────────────────────────── */}
      {previewImage && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6" onClick={() => setPreviewImage(null)}>
          <div className="absolute inset-0 bg-zinc-900/80 backdrop-blur-sm" />
          <div className="relative max-w-2xl w-full">
            <ResolvedImage src={previewImage.url} alt={previewImage.name} className="w-full max-h-[80vh] object-contain rounded-3xl shadow-2xl" />
            <p className="text-center text-white font-bold mt-4">{previewImage.name}</p>
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-4 -right-4 w-10 h-10 bg-white dark:bg-zinc-900 rounded-full shadow-lg flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
      )}

      {/* ─── Merge Ingredient ───────────────────────────────────────────── */}
      <Modal
        open={!!mergingIng}
        onClose={() => setMergingIng(null)}
        size="sm"
        zIndex={120}
        title={t('library.ingredients.mergeTitle')}
        subtitle={mergingIng ? t('library.ingredients.mergeDescription', { name: mergingIng.translated_name || mergingIng.name }) : undefined}
        footer={
          <>
            <ModalCancelButton onClick={() => setMergingIng(null)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton type="button" onClick={handleMerge} disabled={!mergeTargetId || merging}>
              {merging ? t('library.ingredients.merging') : t('library.ingredients.merge')}
            </ModalSubmitButton>
          </>
        }
      >
        <Field label={t('library.ingredients.mergeIntoLabel')}>
          <div className="relative">
            <input
              type="text"
              value={mergeQuery}
              onChange={e => { setMergeQuery(e.target.value); setMergeTargetId(''); }}
              placeholder={t('library.ingredients.searchIngredient')}
              autoComplete="off"
              className="sc-field"
            />
            {mergeQuery.trim() && !mergeTargetId && (
              <div className="absolute z-10 mt-2 max-h-56 w-full overflow-y-auto rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg">
                {ingredients
                  .filter(i => i.id !== mergingIng?.id)
                  .filter(i => (i.translated_name || i.name).toLowerCase().includes(mergeQuery.trim().toLowerCase()))
                  .slice(0, 30)
                  .map(i => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => { setMergeTargetId(i.id); setMergeQuery(i.translated_name || i.name); }}
                      className="w-full px-5 py-3 text-left text-sm font-bold text-zinc-700 dark:text-zinc-300 first:rounded-t-2xl last:rounded-b-2xl hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      {i.translated_name || i.name}
                    </button>
                  ))}
                {ingredients
                  .filter(i => i.id !== mergingIng?.id)
                  .filter(i => (i.translated_name || i.name).toLowerCase().includes(mergeQuery.trim().toLowerCase())).length === 0 && (
                  <p className="sc-hint px-5 py-3 italic">{t('library.ingredients.noMatchingIngredients')}</p>
                )}
              </div>
            )}
          </div>
        </Field>
      </Modal>

      {/* ─── Ingredient Detail (read-only) ─────────────────────────────── */}
      {viewingIng && (
        <IngredientDetailModal
          ing={viewingIng}
          onClose={() => setViewingIng(null)}
          onViewImage={(url, name) => setPreviewImage({ url, name })}
          onEdit={() => { setViewingIng(null); handleOpenModal(viewingIng); }}
          onMerge={() => { setViewingIng(null); setMergingIng(viewingIng); setMergeTargetId(''); setMergeQuery(''); }}
          onDelete={() => { setViewingIng(null); handleDelete(viewingIng.id); }}
          onOpenVariety={(id) => {
            const target = ingredients.find(i => i.id === id);
            if (target) setViewingIng(target);
          }}
        />
      )}
    </>
  );
}

function IngredientDetailModal({
  ing, onClose, onViewImage, onEdit, onMerge, onDelete, onOpenVariety,
}: {
  ing: any;
  onClose: () => void;
  onViewImage: (url: string, name: string) => void;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onOpenVariety: (id: string) => void;
}) {
  const { t } = useTranslation();
  const monthLabels = useMonthLabels();
  const displayName = ing.translated_name || ing.name;
  const nutritionRows: Array<[string, unknown, string]> = [
    [t('library.ingredients.calories'), ing.calories_kcal, 'kcal'],
    [t('library.ingredients.protein'), ing.protein_g, 'g'],
    [t('library.ingredients.carbs'), ing.carbs_g, 'g'],
    [t('library.ingredients.fat'), ing.fat_g, 'g'],
    [t('library.ingredients.fiber'), ing.fiber_g, 'g'],
    [t('library.ingredients.sugar'), ing.sugar_g, 'g'],
    [t('library.ingredients.sodium'), ing.sodium_mg, 'mg'],
  ].filter(([, v]) => v !== null && v !== undefined) as Array<[string, unknown, string]>;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      zIndex={115}
      title={displayName}
      subtitle={ing.translated_category_name || ing.category_name || t('library.ingredients.uncategorized')}
      hero={
        <div className="relative aspect-[21/9] w-full shrink-0 bg-zinc-100 dark:bg-zinc-800">
          {ing.image_urls?.[0] ? (
            <ResolvedImage
              src={ing.image_urls[0]}
              onClick={() => onViewImage(ing.image_urls[0], displayName)}
              className="h-full w-full cursor-zoom-in object-cover"
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-[56px] text-white"
              style={{ backgroundColor: ing.category_color || '#71717a' }}
            >
              <RenderFaIcon name={ing.icon || 'TbCarrot'} />
            </div>
          )}
          {ing.image_urls?.length > 1 && (
            <div className="absolute bottom-3 right-3 flex gap-1.5">
              {ing.image_urls.slice(1, 5).map((url: string, i: number) => (
                <ResolvedImage
                  key={i}
                  src={url}
                  onClick={() => onViewImage(url, displayName)}
                  className="h-10 w-10 cursor-zoom-in rounded-lg border-2 border-white object-cover shadow"
                />
              ))}
            </div>
          )}
        </div>
      }
      footer={
        <>
          <Link
            to={`/?q=${encodeURIComponent(ing.name)}`}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 py-3.5 font-bold text-zinc-600 dark:text-zinc-300 transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            <span className="material-symbols-outlined text-lg">search</span>
            {t('library.ingredients.recipes')}
          </Link>
          <button
            type="button"
            onClick={onMerge}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-zinc-100 dark:bg-zinc-800 py-3.5 font-bold text-zinc-600 dark:text-zinc-300 transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            <span className="material-symbols-outlined text-lg">call_merge</span>
            {t('library.ingredients.merge')}
          </button>
          <ModalDeleteButton onClick={onDelete} label={t('common.delete')} />
          <ModalSubmitButton type="button" onClick={onEdit}>
            <span className="material-symbols-outlined mr-1.5 align-middle text-lg">edit</span>
            {t('common.edit')}
          </ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-7">
        {(ing.parent_name || ing.description) && (
          <div className="space-y-2">
            {ing.parent_name && (
              <button
                onClick={() => onOpenVariety(ing.parent_ingredient_id)}
                className="text-sm font-bold text-primary hover:underline"
              >
                ↳ {t('library.ingredients.varietyOf', { name: ing.parent_name })}
              </button>
            )}
            {ing.description && (
              <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{ing.description}</p>
            )}
          </div>
        )}

        {nutritionRows.length > 0 && (
          <FormSection title={t('library.ingredients.nutritionPer100g')}>
            <div className="sc-panel grid grid-cols-3 gap-3 p-4 sm:grid-cols-4">
              {nutritionRows.map(([label, value, unit]) => (
                <div key={label} className="min-w-0">
                  <p className="sc-label truncate">{label}</p>
                  <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                    {String(value)}
                    <span className="ml-0.5 text-[10px] font-bold text-zinc-400 dark:text-zinc-500">{unit}</span>
                  </p>
                </div>
              ))}
            </div>
          </FormSection>
        )}

        {ing.seasonal_months?.length > 0 && (
          <FormSection title={t('library.ingredients.seasonality')}>
            <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
              {monthLabels.map((label, i) => {
                const active = ing.seasonal_months.includes(i + 1);
                return (
                  <div
                    key={label}
                    className={`rounded-lg py-2 text-center text-[10px] font-bold ${
                      active
                        ? 'bg-primary text-white'
                        : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-300 dark:text-zinc-600'
                    }`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </FormSection>
        )}

        {ing.tags?.length > 0 && (
          <FormSection title={t('library.ingredients.tags')}>
            <div className="flex flex-wrap gap-1.5">
              {ing.tags.map((tg: any) => (
                <span
                  key={tg.id}
                  className="rounded-full px-3 py-1.5 text-xs font-bold text-white"
                  style={{ backgroundColor: tg.color || '#3f3f46' }}
                >
                  {tg.translated_name || tg.name}
                </span>
              ))}
            </div>
          </FormSection>
        )}

        {(ing.synonyms?.length > 0 || ing.translations?.length > 0) && (
          <FormSection title={t('library.ingredients.sectionNaming')}>
            {ing.synonyms?.length > 0 && (
              <Field label={t('library.ingredients.synonyms')}>
                <div className="flex flex-wrap gap-1.5">
                  {ing.synonyms.map((sy: string, i: number) => (
                    <span
                      key={i}
                      className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-600 dark:text-zinc-400"
                    >
                      {sy}
                    </span>
                  ))}
                </div>
              </Field>
            )}
            {ing.translations?.length > 0 && (
              <Field label={t('library.ingredients.translations')}>
                <div className="flex flex-wrap gap-1.5">
                  {ing.translations.map((tr: any, i: number) => (
                    <span
                      key={i}
                      className="rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[9px] font-black uppercase text-zinc-500 dark:text-zinc-400"
                    >
                      {tr.lang}: {tr.text}
                    </span>
                  ))}
                </div>
              </Field>
            )}
          </FormSection>
        )}
      </div>
    </Modal>
  );
}
