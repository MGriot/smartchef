import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import TagPicker from '../components/TagPicker';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

const INGREDIENT_ICONS = [
  'FaEgg', 'FaCarrot', 'FaAppleWhole', 'FaFish', 'FaBacon',
  'FaLeaf', 'FaDroplet', 'FaBottleWater', 'FaLemon', 'FaPepperHot',
  'FaPizzaSlice', 'FaHamburger', 'FaIceCream', 'FaWineGlass', 'FaCheese',
  'FaBreadSlice', 'FaDrumstickBite', 'FaBowlRice', 'FaMugHot', 'FaCookie'
];

export default function LibraryIngredients() {
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [allTags, setAllTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);

  // Modals state
  const [showModal, setShowModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  
  // Ingredient form
  const [editingIng, setEditingIng] = useState<any>(null);
  const emptyNutrition = { caloriesKcal: '', proteinG: '', carbsG: '', fatG: '', fiberG: '', sugarG: '', sodiumMg: '' };
  const [form, setForm] = useState({ name: '', categoryId: '', description: '', icon: 'egg', imageUrls: [] as string[], tagIds: [] as string[], nutrition: { ...emptyNutrition } });
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
      if (!inName) return false;
    }
    if (activeTagFilters.length > 0) {
      const ingTagIds = (ing.tags || []).map((t: any) => t.id);
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
        tagIds: (ing.tags || []).map((t: any) => t.id),
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
    } else {
      setEditingIng(null);
      setForm({
        name: '',
        categoryId: categories[0]?.id || '',
        description: '',
        icon: 'egg',
        imageUrls: [],
        tagIds: [],
        nutrition: { ...emptyNutrition },
      });
      setTranslations([]);
    }
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.categoryId) {
      const firstCat = categories[0]?.id;
      if (!firstCat) return alert("Please wait for categories to load or create one.");
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
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      alert('Network error while saving.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete ingredient?')) return;
    try {
      const res = await apiFetch(`/api/ingredients/${id}`, { method: 'DELETE' });
      if (res.ok) fetchData();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // Translation helpers
  const handleTranslationChange = (idx: number, field: 'lang'|'text', value: string) => {
    const newT = [...translations];
    newT[idx][field] = value;
    setTranslations(newT);
  };
  const addTranslation = () => {
    setTranslations([...translations, { lang: '', text: '' }]);
  };
  const removeTranslation = (idx: number) => {
    setTranslations(translations.filter((_, i) => i !== idx));
  };


  /* ─── CATEGORY ACTIONS ───────────────────── */
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
  const handleCatTranslationChange = (idx: number, field: 'lang' | 'name', value: string) => {
    const newT = [...catTranslations];
    newT[idx][field] = value;
    setCatTranslations(newT);
  };
  const addCatTranslation = () => setCatTranslations([...catTranslations, { lang: '', name: '' }]);
  const removeCatTranslation = (idx: number) => setCatTranslations(catTranslations.filter((_, i) => i !== idx));

  const handleDeleteCat = async (id: string) => {
    if (!window.confirm('Delete this category? Ensure no ingredients use it.')) return;
    try {
      const res = await apiFetch(`/api/ingredients/categories/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setShowCategoryModal(false);
        fetchData();
      } else {
         const result = await res.json();
         alert(`Cannot delete category: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert('Network error while deleting category.');
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
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      alert('Network error while saving category.');
    }
  };


  const categorySidebar = (
    <>
      <div className="pt-8 mb-2">
         <p className="text-[10px] font-bold text-zinc-400 tracking-[0.2em] uppercase px-4">Categories</p>
      </div>
      {categories.map((c) => (
          <button
             key={c.id}
             onClick={() => handleOpenCatModal(c)}
             className="w-full flex items-center justify-between gap-3 px-4 py-2 text-zinc-500 hover:bg-zinc-50 rounded-xl font-medium text-xs transition-all group"
          >
             <div className="flex items-center gap-2 truncate">
                <RenderFaIcon name={c.icon || 'FaTag'} className="text-[16px]" color={c.color} />
                <span className="truncate">{c.translated_name || c.name}</span>
             </div>
             <span className="material-symbols-outlined text-[14px] opacity-0 group-hover:opacity-100 transition-opacity">edit</span>
          </button>
      ))}
      <button
         onClick={() => handleOpenCatModal()}
         className="w-full mt-2 flex justify-center items-center gap-2 px-4 py-2 bg-zinc-100/50 hover:bg-zinc-100 text-zinc-500 rounded-xl font-bold text-xs transition-all border border-zinc-200 border-dashed"
      >
         <span className="material-symbols-outlined text-[16px]">add</span>
         New Category
      </button>
    </>
  );

  const renderIngredientRow = (ing: any) => (
    <tr key={ing.id} className="group hover:bg-zinc-50/50 transition-colors">
      <td className="py-6 pl-4">
        <div className="flex items-center gap-4">
          <div className="relative w-12 h-12 shrink-0">
            {ing.image_urls?.[0] ? (
              <>
                <img
                  src={ing.image_urls[0]}
                  alt=""
                  onClick={() => setPreviewImage({ url: ing.image_urls[0], name: ing.translated_name || ing.name })}
                  className="w-12 h-12 rounded-2xl object-cover bg-zinc-100 cursor-zoom-in"
                />
                <span
                  className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center text-[11px] text-white ring-2 ring-white"
                  style={{ backgroundColor: ing.category_color || '#71717a' }}
                >
                  <RenderFaIcon name={ing.icon || 'FaEgg'} />
                </span>
              </>
            ) : (
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-[24px] text-white"
                style={{ backgroundColor: ing.category_color || '#71717a' }}
              >
                <RenderFaIcon name={ing.icon || 'FaEgg'} />
              </div>
            )}
          </div>
          <p className="font-extrabold text-zinc-900 leading-tight">{ing.translated_name || ing.name}</p>
        </div>
      </td>
      <td className="py-6">
         <div className="flex flex-wrap gap-1 max-w-[200px]">
            {ing.translations?.map((t: any, idx: number) => (
               <span key={idx} className="px-2 py-0.5 bg-zinc-100 text-zinc-500 text-[9px] font-black uppercase rounded border border-zinc-200">
                  {t.lang}: {t.text}
               </span>
            ))}
            {(!ing.translations || ing.translations.length === 0) && (
               <span className="text-zinc-300 text-[10px] italic">None</span>
            )}
         </div>
      </td>
      <td className="py-6">
         <div className="flex flex-wrap gap-1 max-w-[220px]">
            {ing.tags?.map((t: any) => (
               <span
                  key={t.id}
                  className="px-2 py-0.5 text-white text-[9px] font-black uppercase rounded-full"
                  style={{ backgroundColor: t.color || '#3f3f46' }}
               >
                  {t.translated_name || t.name}
               </span>
            ))}
            {(!ing.tags || ing.tags.length === 0) && (
               <span className="text-zinc-300 text-[10px] italic">None</span>
            )}
         </div>
      </td>
      <td className="py-6 text-right pr-4">
         <div className="flex justify-end gap-2">
            <Link
              to={`/?q=${encodeURIComponent(ing.name)}`}
              title="Used in recipes"
              className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all"
            >
              <span className="material-symbols-outlined text-xl">search</span>
            </Link>
            <button onClick={() => handleOpenModal(ing)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all">
              <span className="material-symbols-outlined text-xl">edit</span>
            </button>
            <button onClick={() => handleDelete(ing.id)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-tertiary transition-all">
              <span className="material-symbols-outlined text-xl">delete</span>
            </button>
         </div>
      </td>
    </tr>
  );

  const categorySection = (categoryId: string | null, catName: string, catIcon: string | undefined, catColor: string | undefined, items: any[]) => {
    const matched = items.filter(matchesFilters);
    if (isFiltering && matched.length === 0) return null;
    return (
      <details key={categoryId || 'uncategorized'} open className="group/section">
        <summary className="flex items-center justify-between cursor-pointer list-none py-4 px-2 select-none">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-[16px]" style={{ backgroundColor: catColor || '#71717a' }}>
              <RenderFaIcon name={catIcon || 'FaTag'} />
            </span>
            <span className="font-black text-zinc-900 text-lg">{catName}</span>
            <span className="px-2 py-0.5 bg-zinc-100 text-zinc-400 text-[10px] font-bold rounded-full">{matched.length}</span>
          </div>
          <span className="material-symbols-outlined text-zinc-400 transition-transform group-open/section:rotate-180">expand_more</span>
        </summary>
        <div className="overflow-x-auto pb-4">
          <table className="w-full">
            <tbody className="divide-y divide-zinc-50">
              {matched.map(renderIngredientRow)}
            </tbody>
          </table>
        </div>
      </details>
    );
  };

  return (
    <>
      <AppLayout librarySection="ingredients" sidebarExtra={categorySidebar}>
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
              <h1 className="text-6xl font-black text-zinc-900 tracking-tight leading-none">Ingredients</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              Add New SKU
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4 mb-6">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 text-[18px]">search</span>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search ingredients…"
                className="w-full pl-11 pr-4 py-3 bg-white rounded-full border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map(t => (
                <button
                  key={t.id}
                  onClick={() => toggleTagFilter(t.id)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                    activeTagFilters.includes(t.id) ? 'text-white border-transparent' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'
                  }`}
                  style={activeTagFilters.includes(t.id) ? { backgroundColor: t.color || '#3f3f46' } : undefined}
                >
                  {t.translated_name || t.name}
                </button>
              ))}
            </div>
          </div>

          <section className="bg-white rounded-[40px] px-10 py-4 shadow-sm border border-zinc-100 divide-y divide-zinc-100">
            {loading ? (
              <p className="py-20 text-center text-zinc-400 font-medium">Scanning pantry...</p>
            ) : (
              <>
                {categories.map(c => categorySection(c.id, c.translated_name || c.name, c.icon, c.color, ingredients.filter(i => i.category_id === c.id)))}
                {uncategorized.length > 0 && categorySection(null, 'Uncategorized', 'FaTag', '#71717a', uncategorized)}
              </>
            )}
          </section>
      </AppLayout>

      {/* ─── Ingredient Modal ─────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
           <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
           <div className="relative bg-white w-full max-w-2xl rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200 overflow-y-auto max-h-[90vh] hide-scrollbar">
              <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingIng ? 'Edit Ingredient' : 'New Ingredient SKU'}</h2>
              <form onSubmit={handleSave} className="space-y-6">
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Name (Native)</label>
                   <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Maldon Sea Salt" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                 </div>

                 {/* Translations Section */}
                 <div className="bg-zinc-50/50 p-6 rounded-3xl border border-zinc-100">
                    <div className="flex justify-between items-center mb-4">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Global Translations</label>
                       <button type="button" onClick={addTranslation} className="text-[10px] font-black text-primary uppercase flex items-center gap-1 hover:underline">
                          <span className="material-symbols-outlined text-[14px]">add</span> Add Lang
                       </button>
                    </div>
                    
                    <div className="space-y-3">
                       {translations.map((t, i) => (
                          <div key={i} className="flex gap-2 items-center">
                             <input type="text" placeholder="EN" maxLength={3} value={t.lang} onChange={(e) => handleTranslationChange(i, 'lang', e.target.value)} className="w-20 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold text-center uppercase" />
                             <input type="text" placeholder="Translated name" value={t.text} onChange={(e) => handleTranslationChange(i, 'text', e.target.value)} className="flex-1 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium" />
                             <button type="button" onClick={() => removeTranslation(i)} className="w-10 h-10 flex items-center justify-center text-zinc-400 hover:text-red-500 transition-colors">
                                <span className="material-symbols-outlined">close</span>
                             </button>
                          </div>
                       ))}
                       {translations.length === 0 && (
                          <p className="text-center text-xs text-zinc-400 py-2">No translations added. Provide multiple languages to standardize your database.</p>
                       )}
                    </div>
                 </div>

                 <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Category</label>
                      <select required value={form.categoryId} onChange={e => setForm({...form, categoryId: e.target.value})} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all appearance-none cursor-pointer">
                        {categories.map(c => <option key={c.id} value={c.id}>{c.translated_name || c.name}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Select Icon</label>
                       <div className="grid grid-cols-8 gap-2 bg-zinc-50 p-4 rounded-2xl">
                          {INGREDIENT_ICONS.map(ic => (
                            <button
                              key={ic}
                              type="button"
                              title={ic}
                              onClick={() => setForm({...form, icon: ic})}
                              className={`w-full aspect-square rounded-xl flex items-center justify-center transition-all ${form.icon === ic ? 'bg-primary text-white shadow-md shadow-primary/30 scale-105' : 'bg-white border border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:border-zinc-300'}`}
                            >
                              <RenderFaIcon name={ic} className="text-[20px]" />
                            </button>
                          ))}
                       </div>
                    </div>
                 </div>

                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Nutrition / Notes</label>
                   <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="High protein, locally sourced..." className="w-full h-24 px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium transition-all" />
                 </div>

                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Nutrition (per 100g)</label>
                   <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 bg-zinc-50 p-4 rounded-2xl">
                     {[
                       { key: 'caloriesKcal', label: 'Kcal' },
                       { key: 'proteinG', label: 'Protein (g)' },
                       { key: 'carbsG', label: 'Carbs (g)' },
                       { key: 'fatG', label: 'Fat (g)' },
                       { key: 'fiberG', label: 'Fiber (g)' },
                       { key: 'sugarG', label: 'Sugar (g)' },
                       { key: 'sodiumMg', label: 'Sodium (mg)' },
                     ].map(f => (
                       <label key={f.key}>
                         <span className="block text-[9px] font-bold text-zinc-400 uppercase mb-1">{f.label}</span>
                         <input
                           type="number" step="any" min="0"
                           value={(form.nutrition as any)[f.key]}
                           onChange={e => setForm({ ...form, nutrition: { ...form.nutrition, [f.key]: e.target.value } })}
                           className="w-full px-3 py-2 bg-white rounded-lg border-none focus:ring-2 focus:ring-primary/20 text-sm font-bold"
                         />
                       </label>
                     ))}
                   </div>
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Reference Photos</label>
                    <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({...form, imageUrls: urls})} />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Tags</label>
                    <TagPicker by="id" value={form.tagIds} onChange={tagIds => setForm({...form, tagIds})} />
                 </div>

                 <div className="flex gap-4 pt-4 sticky bottom-0 bg-white pb-2">
                    <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                    <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">
                      {editingIng ? 'Update Catalog' : 'Add to Catalog'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}

      {/* ─── Category Modal ─────────────────────────────────────────────── */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
           <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowCategoryModal(false)} />
           <div className="relative bg-white w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
              <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingCat ? 'Edit Category' : 'New Category'}</h2>
              <form onSubmit={handleSaveCat} className="space-y-6">
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Category Name</label>
                   <input type="text" required value={catForm.name} onChange={e => setCatForm({...catForm, name: e.target.value})} placeholder="e.g. Dairy / Formaggi" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                 </div>
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Color</label>
                   <div className="flex items-center gap-3">
                     <input type="color" value={catForm.color} onChange={e => setCatForm({...catForm, color: e.target.value})} className="w-14 h-14 rounded-2xl border-none cursor-pointer bg-zinc-50" />
                     <span className="text-sm font-mono text-zinc-500">{catForm.color}</span>
                   </div>
                 </div>
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Visual Icon</label>
                   <div className="grid grid-cols-8 gap-2 bg-zinc-50 p-4 rounded-2xl">
                      {INGREDIENT_ICONS.map(ic => (
                        <button
                          key={ic}
                          type="button"
                          title={ic}
                          onClick={() => setCatForm({...catForm, icon: ic})}
                          className={`w-full aspect-square rounded-xl flex items-center justify-center transition-all ${catForm.icon === ic ? 'text-white shadow-md scale-105' : 'bg-white border border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:border-zinc-300'}`}
                          style={catForm.icon === ic ? { backgroundColor: catForm.color } : undefined}
                        >
                          <RenderFaIcon name={ic} className="text-[20px]" />
                        </button>
                      ))}
                   </div>
                 </div>

                 {/* Translations Section */}
                 <div className="bg-zinc-50/50 p-6 rounded-3xl border border-zinc-100">
                    <div className="flex justify-between items-center mb-4">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Translations</label>
                       <button type="button" onClick={addCatTranslation} className="text-[10px] font-black text-primary uppercase flex items-center gap-1 hover:underline">
                          <span className="material-symbols-outlined text-[14px]">add</span> Add Lang
                       </button>
                    </div>
                    <div className="space-y-3">
                       {catTranslations.map((t, i) => (
                          <div key={i} className="flex gap-2 items-center">
                             <input type="text" placeholder="EN" maxLength={3} value={t.lang} onChange={(e) => handleCatTranslationChange(i, 'lang', e.target.value)} className="w-20 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold text-center uppercase" />
                             <input type="text" placeholder="Translated name" value={t.name} onChange={(e) => handleCatTranslationChange(i, 'name', e.target.value)} className="flex-1 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium" />
                             <button type="button" onClick={() => removeCatTranslation(i)} className="w-10 h-10 flex items-center justify-center text-zinc-400 hover:text-red-500 transition-colors">
                                <span className="material-symbols-outlined">close</span>
                             </button>
                          </div>
                       ))}
                       {catTranslations.length === 0 && (
                          <p className="text-center text-xs text-zinc-400 py-2">No translations added.</p>
                       )}
                    </div>
                 </div>

                 <div className="flex gap-4 pt-4">
                    {editingCat && (
                        <button type="button" onClick={() => handleDeleteCat(editingCat.id)} className="w-14 h-14 bg-red-50 text-red-500 rounded-2xl hover:bg-red-100 hover:text-red-700 transition-all flex items-center justify-center shrink-0">
                           <span className="material-symbols-outlined text-[24px]">delete</span>
                        </button>
                    )}
                    <button type="button" onClick={() => setShowCategoryModal(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                    <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">
                      {editingCat ? 'Update' : 'Create'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}

      {/* ─── Photo Lightbox ─────────────────────────────────────────────── */}
      {previewImage && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6" onClick={() => setPreviewImage(null)}>
          <div className="absolute inset-0 bg-zinc-900/80 backdrop-blur-sm" />
          <div className="relative max-w-2xl w-full">
            <img src={previewImage.url} alt={previewImage.name} className="w-full max-h-[80vh] object-contain rounded-3xl shadow-2xl" />
            <p className="text-center text-white font-bold mt-4">{previewImage.name}</p>
            <button
              onClick={() => setPreviewImage(null)}
              className="absolute -top-4 -right-4 w-10 h-10 bg-white rounded-full shadow-lg flex items-center justify-center text-zinc-600 hover:text-zinc-900"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
