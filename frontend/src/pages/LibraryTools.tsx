import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import { ResolvedImage } from '../components/CoverImage';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

const TOOL_ICONS = [
  'FaBlender', 'FaFireBurner', 'FaKitchenSet', 'FaBowlFood', 'FaUtensils',
  'FaMortarPestle', 'FaGripLines', 'FaMugHot', 'FaBreadSlice', 'FaScaleBalanced',
  'FaClock', 'FaSnowflake', 'FaBoxOpen', 'FaFilter', 'FaBrush', 'FaTag'
];

export default function LibraryTools() {
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTool, setEditingTool] = useState<any>(null);
  const [form, setForm] = useState({ name: '', category: '', description: '', icon: 'FaKitchenSet', imageUrls: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);

  const fetchTools = () => {
    setLoading(true);
    apiFetch(`/api/tools${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setTools(json.data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchTools();
  }, [contentLang]);

  const handleOpenModal = (tool: any = null) => {
    if (tool) {
      setEditingTool(tool);
      setForm({
        name: tool.name,
        category: tool.category || '',
        description: tool.description || '',
        icon: tool.icon || 'FaKitchenSet',
        imageUrls: tool.image_urls || [],
        synonyms: tool.synonyms || [],
      });
      setTranslations(tool.translations || []);
    } else {
      setEditingTool(null);
      setForm({ name: '', category: '', description: '', icon: 'FaKitchenSet', imageUrls: [], synonyms: [] });
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
    const url = editingTool ? `/api/tools/${editingTool.id}` : '/api/tools';
    const method = editingTool ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, translations: translations.filter(t => t.lang.trim() && t.name.trim()) })
      });
      const result = await res.json();
      if (res.ok) {
        setShowModal(false);
        fetchTools();
      } else {
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this tool?')) return;
    try {
      const res = await apiFetch(`/api/tools/${id}`, { method: 'DELETE' });
      if (res.ok) fetchTools();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <>
      <AppLayout librarySection="tools">
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
              <h1 className="text-6xl font-black text-zinc-900 tracking-tight leading-none">Kitchen Tools</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              Add New Tool
            </button>
          </div>

          <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pl-4">Tool Details</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Category</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {loading ? (
                    <tr><td colSpan={3} className="py-20 text-center text-zinc-400 font-medium">Loading items...</td></tr>
                  ) : tools.map((tool) => (
                    <tr key={tool.id} className="group hover:bg-zinc-50/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          {tool.image_urls?.[0] ? (
                            <ResolvedImage src={tool.image_urls[0]} className="w-12 h-12 rounded-2xl object-cover bg-zinc-100" />
                          ) : (
                            <div className="w-12 h-12 bg-zinc-100 rounded-2xl flex items-center justify-center text-xl text-zinc-400">
                              <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-[20px]" />
                            </div>
                          )}
                          <div>
                            <p className="font-extrabold text-zinc-900 leading-tight">{tool.translated_name || tool.name}</p>
                            <p className="text-zinc-400 text-[11px] font-medium tracking-tighter mt-1">{tool.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6">
                        <span className="px-3 py-1 bg-zinc-100 text-zinc-500 text-[10px] font-black uppercase rounded-md border border-zinc-200/50">
                          {tool.category || 'GENERAL'}
                        </span>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(tool)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => handleDelete(tool.id)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-tertiary transition-all">
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
              <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingTool ? 'Edit Tool' : 'New Culinary Tool'}</h2>
              <form onSubmit={handleSave} className="space-y-6">
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Tool Name</label>
                   <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Mandoline Slicer" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Reference Photos</label>
                    <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({...form, imageUrls: urls})} />
                 </div>

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-1">Choose Icon</label>
                    <div className="grid grid-cols-6 gap-3 bg-zinc-50 p-4 rounded-3xl">
                       {TOOL_ICONS.map(ic => (
                          <button key={ic} type="button" onClick={() => setForm({...form, icon: ic})} className={`w-12 h-12 flex items-center justify-center rounded-xl transition-all ${form.icon === ic ? 'bg-primary text-white shadow-lg scale-110' : 'bg-white text-zinc-400 hover:text-primary'}`}>
                             <RenderFaIcon name={ic} className="text-lg" />
                          </button>
                       ))}
                    </div>
                 </div>

                 <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Category</label>
                      <input type="text" value={form.category} onChange={e => setForm({...form, category: e.target.value})} placeholder="e.g. Prep" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                    </div>
                    <div className="opacity-50">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">ID (Read Only)</label>
                       <div className="w-full px-6 py-4 bg-zinc-100 rounded-2xl text-[10px] font-mono truncate">{editingTool?.id || 'NEW'}</div>
                    </div>
                 </div>
                 <div>
                   <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Technical Specs / Description</label>
                   <textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Maintenance requirements, serial numbers..." className="w-full h-24 px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium transition-all" />
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
                      {editingTool ? 'Update Asset' : 'Register Asset'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </>
  );
}
