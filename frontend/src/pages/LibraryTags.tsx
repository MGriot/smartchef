import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

const TAG_ICONS = [
  'FaTag', 'FaLeaf', 'FaSeedling', 'FaDrumstickBite', 'FaFish', 'FaShrimp',
  'FaEgg', 'FaCheese', 'FaWheatAwn', 'FaTree', 'FaUtensils', 'FaBowlFood',
  'FaCarrot', 'FaIceCream', 'FaMugHot'
];

const DEFAULT_COLOR = '#3f3f46';

export default function LibraryTags() {
  const [tags, setTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTag, setEditingTag] = useState<any>(null);
  const [form, setForm] = useState({ name: '', groupName: 'Altro', color: DEFAULT_COLOR, icon: 'FaTag', excludeTagIds: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);

  const fetchTags = () => {
    setLoading(true);
    apiFetch(`/api/tags${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setTags(json.data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchTags();
  }, [contentLang]);

  const handleOpenModal = (tag: any = null) => {
    if (tag) {
      setEditingTag(tag);
      setForm({
        name: tag.name,
        groupName: tag.group_name || 'Altro',
        color: tag.color || DEFAULT_COLOR,
        icon: tag.icon || 'FaTag',
        excludeTagIds: tag.exclude_tag_ids || [],
      });
      setTranslations(tag.translations || []);
    } else {
      setEditingTag(null);
      setForm({ name: '', groupName: 'Altro', color: DEFAULT_COLOR, icon: 'FaTag', excludeTagIds: [] });
      setTranslations([]);
    }
    setShowModal(true);
  };

  const handleTranslationChange = (idx: number, field: 'lang' | 'name', value: string) => {
    const newT = [...translations];
    newT[idx][field] = value;
    setTranslations(newT);
  };
  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);
  const removeTranslation = (idx: number) => setTranslations(translations.filter((_, i) => i !== idx));

  const toggleExclude = (id: string) => {
    setForm(f => ({
      ...f,
      excludeTagIds: f.excludeTagIds.includes(id)
        ? f.excludeTagIds.filter(x => x !== id)
        : [...f.excludeTagIds, id],
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingTag ? `/api/tags/${editingTag.id}` : '/api/tags';
    const method = editingTag ? 'PUT' : 'POST';

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, translations: translations.filter(t => t.lang.trim() && t.name.trim()) })
      });
      const result = await res.json();
      if (res.ok) {
        setShowModal(false);
        fetchTags();
      } else {
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this tag? It will stop being auto-applied, but stays on recipes that already have it.')) return;
    try {
      const res = await apiFetch(`/api/tags/${id}`, { method: 'DELETE' });
      if (res.ok) fetchTags();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const groups = tags.reduce<Record<string, any[]>>((acc, t) => {
    (acc[t.group_name] ||= []).push(t);
    return acc;
  }, {});

  return (
    <>
      <AppLayout librarySection="tags">
        <div className="flex justify-between items-end mb-10">
          <div>
            <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
            <h1 className="text-6xl font-black text-zinc-900 tracking-tight leading-none">Tags</h1>
          </div>
          <button
            onClick={() => handleOpenModal()}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
          >
            <span className="material-symbols-outlined">add</span>
            New Tag
          </button>
        </div>

        <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 space-y-8">
          {loading ? (
            <p className="py-20 text-center text-zinc-400 font-medium">Loading tags...</p>
          ) : Object.keys(groups).length === 0 ? (
            <p className="py-20 text-center text-zinc-400 font-medium">No tags yet — create your first one.</p>
          ) : Object.entries(groups).map(([group, groupTags]) => (
            <div key={group}>
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-3">{group}</p>
              <div className="flex flex-wrap gap-3">
                {groupTags.map(tag => (
                  <button
                    key={tag.id}
                    onClick={() => handleOpenModal(tag)}
                    className="group flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-2xl border border-zinc-100 hover:border-zinc-200 hover:shadow-sm transition-all"
                  >
                    <span
                      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[13px] shrink-0"
                      style={{ backgroundColor: tag.color || DEFAULT_COLOR }}
                    >
                      <RenderFaIcon name={tag.icon || 'FaTag'} />
                    </span>
                    <span className="text-left">
                      <span className="block font-extrabold text-zinc-900 text-sm leading-tight">{tag.translated_name || tag.name}</span>
                      {tag.exclude_tag_ids?.length > 0 && (
                        <span className="block text-[10px] font-medium text-zinc-400">Auto (diet)</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </AppLayout>

      {/* ─── Modal ─────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-white w-full max-w-xl rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200 overflow-y-auto max-h-[90vh] hide-scrollbar">
            <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingTag ? 'Edit Tag' : 'New Tag'}</h2>
            <form onSubmit={handleSave} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Name</label>
                  <input type="text" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Vegetariano" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Group</label>
                  <input type="text" list="tag-groups" value={form.groupName} onChange={e => setForm({ ...form, groupName: e.target.value })} placeholder="e.g. Dieta" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                  <datalist id="tag-groups">
                    {Object.keys(groups).map(g => <option key={g} value={g} />)}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Color</label>
                <div className="flex items-center gap-3">
                  <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} className="w-14 h-14 rounded-2xl border-none cursor-pointer bg-zinc-50" />
                  <span className="text-sm font-mono text-zinc-500">{form.color}</span>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-4 px-1">Choose Icon</label>
                <div className="grid grid-cols-6 gap-3 bg-zinc-50 p-4 rounded-3xl">
                  {TAG_ICONS.map(ic => (
                    <button key={ic} type="button" onClick={() => setForm({ ...form, icon: ic })} className={`w-12 h-12 flex items-center justify-center rounded-xl transition-all ${form.icon === ic ? 'bg-primary text-white shadow-lg scale-110' : 'bg-white text-zinc-400 hover:text-primary'}`}>
                      <RenderFaIcon name={ic} className="text-lg" />
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-zinc-50/50 p-6 rounded-3xl border border-zinc-100">
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1 px-1">Auto-apply (diet tag)</label>
                <p className="text-xs text-zinc-400 mb-4 px-1">If any are checked, this tag is added automatically to a recipe unless it contains an ingredient carrying one of these.</p>
                <div className="flex flex-wrap gap-2">
                  {tags.filter(t => t.id !== editingTag?.id).map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleExclude(t.id)}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${form.excludeTagIds.includes(t.id) ? 'text-white border-transparent' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'}`}
                      style={form.excludeTagIds.includes(t.id) ? { backgroundColor: t.color || DEFAULT_COLOR } : undefined}
                    >
                      {t.translated_name || t.name}
                    </button>
                  ))}
                  {tags.filter(t => t.id !== editingTag?.id).length === 0 && (
                    <p className="text-xs text-zinc-400 italic">No other tags yet.</p>
                  )}
                </div>
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
                {editingTag && (
                  <button type="button" onClick={() => handleDelete(editingTag.id)} className="w-14 h-14 bg-red-50 text-red-500 rounded-2xl hover:bg-red-100 hover:text-red-700 transition-all flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-[24px]">delete</span>
                  </button>
                )}
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">
                  {editingTag ? 'Update Tag' : 'Add Tag'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
