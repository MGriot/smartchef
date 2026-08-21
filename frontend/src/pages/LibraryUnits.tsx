import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

export default function LibraryUnits() {
  const [units, setUnits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUnit, setEditingUnit] = useState<any>(null);
  const [form, setForm] = useState({ name: '', symbol: '', unitType: '', system: '', toBaseFactor: 1 });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);

  const contentLang = useStore((s) => s.contentLang);

  const fetchUnits = () => {
    setLoading(true);
    apiFetch(`/api/units${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setUnits(json.data || []);
        setLoading(false);
      })
      .catch(err => {
        console.error('Fetch failed:', err);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchUnits();
  }, [contentLang]);

  const handleOpenModal = (u: any = null) => {
    if (u) {
      setEditingUnit(u);
      setForm({
        name: u.name,
        symbol: u.symbol,
        unitType: u.unit_type || 'volume',
        system: u.system || 'metric',
        toBaseFactor: Number(u.to_base_factor) || 1
      });
      setTranslations(u.translations || []);
    } else {
      setEditingUnit(null);
      setForm({ name: '', symbol: '', unitType: 'volume', system: 'metric', toBaseFactor: 1 });
      setTranslations([]);
    }
    setShowModal(true);
  };

  // Translation helpers
  const handleTranslationChange = (idx: number, field: 'lang' | 'name', value: string) => {
    const newT = [...translations];
    newT[idx][field] = field === 'lang' ? value.toLowerCase() : value;
    setTranslations(newT);
  };
  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);
  const removeTranslation = (idx: number) => setTranslations(translations.filter((_, i) => i !== idx));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingUnit ? `/api/units/${editingUnit.id}` : '/api/units';
    const method = editingUnit ? 'PUT' : 'POST';

    // Ensure conversion factor is a number
    const payload = {
      ...form,
      toBaseFactor: Number(form.toBaseFactor),
      translations: translations.filter(t => t.lang.trim() && t.name.trim()),
    };

    try {
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (res.ok) {
        setShowModal(false);
        fetchUnits();
      } else {
        alert(`Save failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert('Network error while saving units.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this unit?')) return;
    try {
      const res = await apiFetch(`/api/units/${id}`, { method: 'DELETE' });
      if (res.ok) fetchUnits();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <>
      <AppLayout librarySection="units">
          <div className="flex justify-between items-end mb-10">
             <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">SmartChef Atelier</p>
              <h1 className="text-6xl font-black text-zinc-900 tracking-tight leading-none">Units & Scales</h1>
            </div>
            <button onClick={() => handleOpenModal()} className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95">
              <span className="material-symbols-outlined text-xl">add_circle</span>
              Register Unit
            </button>
          </div>

          <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100">
             <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pl-4">Unit</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest text-center">System</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Type</th>
                    <th className="text-right py-4 text-[10px] font-bold text-zinc-400 uppercase tracking-widest pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50">
                  {loading ? (
                    <tr><td colSpan={4} className="py-20 text-center text-zinc-400 font-medium">Loading units...</td></tr>
                  ) : units.map((u) => (
                    <tr key={u.id} className="group hover:bg-zinc-50/50 transition-colors">
                      <td className="py-6 pl-4">
                        <p className="font-extrabold text-zinc-900 leading-tight">{u.translated_name || u.name}</p>
                        <p className="text-zinc-400 text-[11px] font-black uppercase mt-1 tracking-tight">{u.symbol}</p>
                      </td>
                      <td className="py-6 text-center">
                         <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${u.system === 'metric' ? 'bg-primary/10 text-primary' : 'bg-zinc-100 text-zinc-400'}`}>
                          {u.system || 'N/A'}
                        </span>
                      </td>
                      <td className="py-6 capitalize font-bold text-xs text-zinc-600">{u.unit_type}</td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(u)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-primary transition-all">
                               <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => handleDelete(u.id)} className="w-10 h-10 rounded-full hover:bg-white hover:shadow-sm flex items-center justify-center text-zinc-400 hover:text-tertiary transition-all">
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

      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
           <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
           <div className="relative bg-white w-full max-w-xl rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
              <h2 className="text-3xl font-black text-zinc-900 mb-8">{editingUnit ? 'Edit Unit' : 'Define New Scale'}</h2>
              <form onSubmit={handleSave} className="space-y-6">
                 <div className="grid grid-cols-3 gap-6">
                    <div className="col-span-2">
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Full Name</label>
                       <input type="text" required value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="e.g. Milliliter" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                    </div>
                    <div>
                       <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Symbol</label>
                       <input type="text" required value={form.symbol} onChange={e => setForm({...form, symbol: e.target.value})} placeholder="ml" className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                    </div>
                 </div>
                 <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Type</label>
                      <select value={form.unitType} onChange={e => setForm({...form, unitType: e.target.value})} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all appearance-none">
                         <option value="volume">Volume</option>
                         <option value="weight">Weight</option>
                         <option value="length">Length</option>
                         <option value="temperature">Temperature</option>
                         <option value="count">Count / Each</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Measurement System</label>
                      <select value={form.system} onChange={e => setForm({...form, system: e.target.value})} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all appearance-none">
                         <option value="metric">Metric (SI)</option>
                         <option value="imperial">Imperial / US</option>
                         <option value="custom">Artisanal / Custom</option>
                      </select>
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

                 <div>
                    <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Conversion Factor (to base)</label>
                    <input type="number" step="any" value={form.toBaseFactor} onChange={e => setForm({...form, toBaseFactor: Number(e.target.value)})} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
                 </div>
                 <div className="flex gap-4 pt-4">
                    <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                    <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">
                      {editingUnit ? 'Update System' : 'Apply Scale'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </>
  );
}
