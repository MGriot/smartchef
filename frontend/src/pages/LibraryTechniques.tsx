import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

const TECHNIQUE_ICONS = [
  'FaFire', 'FaSnowflake', 'FaHandFist', 'FaKnifeKitchen', 'FaUtensils',
  'FaBowlFood', 'FaClock', 'FaDroplet', 'FaBlender', 'FaMortarPestle', 'FaTag'
];

export default function LibraryTechniques() {
  const [techniques, setTechniques] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTechnique, setEditingTechnique] = useState<any>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: 'FaFire', imageUrls: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);

  const fetchTechniques = () => {
    setLoading(true);
    apiFetch(`/api/techniques${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setTechniques(json.data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchTechniques();
  }, [contentLang]);

  const handleOpenModal = (technique: any = null) => {
    if (technique) {
      setEditingTechnique(technique);
      setForm({
        name: technique.name,
        description: technique.description || '',
        icon: technique.icon || 'FaFire',
        imageUrls: technique.image_urls || [],
        synonyms: technique.synonyms || [],
      });
      setTranslations(technique.translations || []);
    } else {
      setEditingTechnique(null);
      setForm({ name: '', description: '', icon: 'FaFire', imageUrls: [], synonyms: [] });
      setTranslations([]);
    }
    setShowModal(true);
  };

  const handleTranslationChange = (idx: number, field: 'lang' | 'name', value: string) => {
    const newT = [...translations];
    newT[idx][field] = field === 'lang' ? value.toLowerCase() : value;
    setTranslations(newT);
  };
  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);
  const removeTranslation = (idx: number) => setTranslations(translations.filter((_, i) => i !== idx));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingTechnique ? `/api/techniques/${editingTechnique.id}` : '/api/techniques';
    const method = editingTechnique ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, translations: translations.filter(t => t.lang.trim() && t.name.trim()) })
      });
      const result = await res.json();
      if (res.ok) {
        setShowModal(false);
        fetchTechniques();
      } else {
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this technique?')) return;
    try {
      const res = await apiFetch(`/api/techniques/${id}`, { method: 'DELETE' });
      if (res.ok) fetchTechniques();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <>
      <AppLayout librarySection="techniques">
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
              <h1 className="text-6xl font-black text-zinc-900 tracking-tight leading-none">Techniques</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              Add New Technique
            </button>
          </div>

          <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pl-4">Technique</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {loading ? (
                    <tr><td colSpan={2} className="py-20 text-center text-zinc-400 font-medium">Loading items...</td></tr>
                  ) : techniques.map((technique) => (
                    <tr key={technique.id} className="group hover:bg-zinc-50/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          {technique.image_urls?.[0] ? (
                            <img src={technique.image_urls[0]} alt="" className="w-12 h-12 rounded-2xl object-cover bg-zinc-100" />
                          ) : (
                            <div className="w-12 h-12 bg-zinc-100 rounded-2xl flex items-center justify-center text-xl text-zinc-400">
                              <RenderFaIcon name={technique.icon || 'FaFire'} className="text-[20px]" />
                            </div>
                          )}
                          <div>
                            <p className="font-extrabold text-zinc-900 leading-tight">{technique.translated_name || technique.name}</p>
                            <p className="text-zinc-400 text-[11px] font-medium tracking-tighter mt-1">{technique.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(technique)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => handleDelete(technique.id)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-tertiary transition-all">
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

      {/* ─── Modal ─────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
           <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
           <div className="relative bg-white w-full max-w-xl rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200 overflow-y-auto max-h-[90vh] hide-scrollbar">
              <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingTechnique ? 'Edit Technique' : 'New Technique'}</h2>
              <form onSubmit={handleSave} className="space-y-6">
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Technique Name</label>
                   <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Blanch" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Reference Photos</label>
                    <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({...form, imageUrls: urls})} />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-1">Choose Icon</label>
                    <div className="grid grid-cols-6 gap-3 bg-zinc-50 p-4 rounded-3xl">
                       {TECHNIQUE_ICONS.map(ic => (
                          <button key={ic} type="button" onClick={() => setForm({...form, icon: ic})} className={`w-12 h-12 flex items-center justify-center rounded-xl transition-all ${form.icon === ic ? 'bg-primary text-white shadow-lg scale-110' : 'bg-white text-zinc-400 hover:text-primary'}`}>
                             <RenderFaIcon name={ic} className="text-lg" />
                          </button>
                       ))}
                    </div>
                 </div>

                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Description</label>
                   <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="What this technique means, when to use it..." className="w-full h-24 px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium transition-all" />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Synonyms</label>
                    <SynonymsEditor value={form.synonyms} onChange={synonyms => setForm({ ...form, synonyms })} />
                 </div>

                 {/* Translations Section */}
                 <div className="bg-zinc-50/50 p-6 rounded-3xl border border-zinc-100">
                    <div className="flex justify-between items-center mb-4">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Translations</label>
                       <button type="button" onClick={addTranslation} className="text-[10px] font-black text-primary uppercase flex items-center gap-1 hover:underline">
                          <span className="material-symbols-outlined text-[14px]">add</span> Add Lang
                       </button>
                    </div>
                    <div className="space-y-3">
                       {translations.map((t, i) => (
                          <div key={i} className="flex gap-2 items-center">
                             <input type="text" placeholder="EN" maxLength={3} value={t.lang} onChange={(e) => handleTranslationChange(i, 'lang', e.target.value)} className="w-20 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold text-center uppercase" />
                             <input type="text" placeholder="Translated name" value={t.name} onChange={(e) => handleTranslationChange(i, 'name', e.target.value)} className="flex-1 px-4 py-2 bg-white rounded-xl border border-zinc-200 focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium" />
                             <button type="button" onClick={() => removeTranslation(i)} className="w-10 h-10 flex items-center justify-center text-zinc-400 hover:text-red-500 transition-colors">
                                <span className="material-symbols-outlined">close</span>
                             </button>
                          </div>
                       ))}
                       {translations.length === 0 && (
                          <p className="text-center text-xs text-zinc-400 py-2">No translations added.</p>
                       )}
                    </div>
                 </div>

                 <div className="flex gap-4 pt-4 sticky bottom-0 bg-white pb-2">
                    <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                    <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">
                      {editingTechnique ? 'Update Technique' : 'Add Technique'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </>
  );
}
