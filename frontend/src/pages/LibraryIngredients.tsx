import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import { useStore } from '../store/app.store';

const INGREDIENT_ICONS = [
  'FaEgg', 'FaCarrot', 'FaAppleWhole', 'FaFish', 'FaBacon',
  'FaLeaf', 'FaDroplet', 'FaBottleWater', 'FaLemon', 'FaPepperHot',
  'FaPizzaSlice', 'FaHamburger', 'FaIceCream', 'FaWineGlass', 'FaCheese',
  'FaBreadSlice', 'FaDrumstickBite', 'FaBowlRice', 'FaMugHot', 'FaCookie'
];

export default function LibraryIngredients() {
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Modals state
  const [showModal, setShowModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  
  // Ingredient form
  const [editingIng, setEditingIng] = useState<any>(null);
  const [form, setForm] = useState({ name: '', categoryId: '', description: '', icon: 'egg' });
  const [translations, setTranslations] = useState<{lang: string, text: string}[]>([]);

  // Category form
  const [editingCat, setEditingCat] = useState<any>(null);
  const [catForm, setCatForm] = useState({ name: '', description: '', icon: 'category' });
  const [catTranslations, setCatTranslations] = useState<{ lang: string; name: string }[]>([]);

  const contentLang = useStore((s) => s.contentLang);
  const langQuery = contentLang ? `?lang=${contentLang}` : '';

  const fetchData = async () => {
    setLoading(true);
    try {
      const [ingRes, catRes] = await Promise.all([
        fetch(`/api/ingredients${langQuery}`),
        fetch(`/api/ingredients/categories${langQuery}`)
      ]);
      const ings = await ingRes.json();
      const cats = await catRes.json();
      setIngredients(ings.data || []);
      setCategories(cats.data || []);
    } catch (err) {
      console.error('Fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

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
        icon: ing.icon || 'egg' 
      });
      setTranslations(ing.translations || []);
    } else {
      setEditingIng(null);
      setForm({ 
        name: '', 
        categoryId: categories[0]?.id || '', 
        description: '', 
        icon: 'egg' 
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

    const url = editingIng ? `/api/ingredients/${editingIng.id}` : '/api/ingredients';
    const method = editingIng ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, translations: cleanTranslations })
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
      const res = await fetch(`/api/ingredients/${id}`, { method: 'DELETE' });
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
      setCatForm({ name: cat.name, description: cat.description || '', icon: cat.icon || 'category' });
      setCatTranslations(cat.translations || []);
    } else {
      setEditingCat(null);
      setCatForm({ name: '', description: '', icon: 'category' });
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
      const res = await fetch(`/api/ingredients/categories/${id}`, { method: 'DELETE' });
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
      const res = await fetch(url, {
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
                <RenderFaIcon name={c.icon || 'FaTag'} className="text-[16px] text-zinc-400" />
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

          <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pl-4">Ingredient</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Translations</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Category</th>
                    <th className="text-right py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {loading ? (
                    <tr><td colSpan={4} className="py-20 text-center text-zinc-400 font-medium">Scanning pantry...</td></tr>
                  ) : ingredients.map((ing) => (
                    <tr key={ing.id} className="group hover:bg-zinc-50/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-zinc-100 rounded-2xl flex items-center justify-center text-[24px] text-zinc-400">
                            <RenderFaIcon name={ing.icon || 'FaEgg'} />
                          </div>
                          <div>
                            <p className="font-extrabold text-zinc-900 leading-tight">{ing.translated_name || ing.name}</p>
                            <p className="text-zinc-400 text-[11px] font-medium tracking-tighter mt-1">{ing.translated_category_name || ing.category_name || 'Uncategorized'}</p>
                          </div>
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
                         <span className="px-3 py-1 bg-zinc-100 text-zinc-500 text-[10px] font-black uppercase rounded-md border border-zinc-200/50 flex items-center gap-1 w-max">
                          <RenderFaIcon name={ing.category_icon || 'FaTag'} className="text-[14px]" />
                          {ing.translated_category_name || ing.category_name || 'GENERAL'}
                        </span>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(ing)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => handleDelete(ing.id)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-tertiary transition-all">
                              <span className="material-symbols-outlined text-xl">delete</span>
                            </button>
                         </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Visual Icon</label>
                   <div className="grid grid-cols-8 gap-2 bg-zinc-50 p-4 rounded-2xl">
                      {INGREDIENT_ICONS.map(ic => (
                        <button
                          key={ic}
                          type="button"
                          title={ic}
                          onClick={() => setCatForm({...catForm, icon: ic})}
                          className={`w-full aspect-square rounded-xl flex items-center justify-center transition-all ${catForm.icon === ic ? 'bg-primary text-white shadow-md shadow-primary/30 scale-105' : 'bg-white border border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:border-zinc-300'}`}
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
    </>
  );
}
