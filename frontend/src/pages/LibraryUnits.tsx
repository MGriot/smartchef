import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, TranslationRows } from '../components/Form';

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
  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);

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
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">Units & Scales</h1>
            </div>
            <button onClick={() => handleOpenModal()} className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95">
              <span className="material-symbols-outlined text-xl">add_circle</span>
              Register Unit
            </button>
          </div>

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
             <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">Unit</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-center">System</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Type</th>
                    <th className="text-right py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={4} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">Loading units...</td></tr>
                  ) : units.map((u) => (
                    <tr key={u.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
                      <td className="py-6 pl-4">
                        <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight">{u.translated_name || u.name}</p>
                        <p className="text-zinc-400 dark:text-zinc-500 text-[11px] font-black uppercase mt-1 tracking-tight">{u.symbol}</p>
                      </td>
                      <td className="py-6 text-center">
                         <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${u.system === 'metric' ? 'bg-primary/10 text-primary' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'}`}>
                          {u.system || 'N/A'}
                        </span>
                      </td>
                      <td className="py-6 capitalize font-bold text-xs text-zinc-600 dark:text-zinc-400">{u.unit_type}</td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(u)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                               <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => handleDelete(u.id)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
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

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingUnit ? 'Edit Unit' : 'Define New Scale'}
        subtitle="Units convert against a base unit of the same type."
        footer={
          <>
            <ModalCancelButton onClick={() => setShowModal(false)}>Cancel</ModalCancelButton>
            <ModalSubmitButton>{editingUnit ? 'Update System' : 'Apply Scale'}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title="Identity">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Full Name" className="sm:col-span-2">
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Milliliter"
                  className="sc-field"
                />
              </Field>
              <Field label="Symbol">
                <input
                  type="text" required value={form.symbol}
                  onChange={e => setForm({ ...form, symbol: e.target.value })}
                  placeholder="ml"
                  className="sc-field"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Measurement">
            <FieldRow>
              <Field label="Type">
                <select
                  value={form.unitType}
                  onChange={e => setForm({ ...form, unitType: e.target.value })}
                  className="sc-field cursor-pointer"
                >
                  <option value="volume">Volume</option>
                  <option value="weight">Weight</option>
                  <option value="length">Length</option>
                  <option value="temperature">Temperature</option>
                  <option value="count">Count / Each</option>
                </select>
              </Field>
              <Field label="Measurement System">
                <select
                  value={form.system}
                  onChange={e => setForm({ ...form, system: e.target.value })}
                  className="sc-field cursor-pointer"
                >
                  <option value="metric">Metric (SI)</option>
                  <option value="imperial">Imperial / US</option>
                  <option value="custom">Artisanal / Custom</option>
                </select>
              </Field>
            </FieldRow>
            <Field
              label="Conversion Factor (to base)"
              hint="How many base units of this type one of this unit is worth — 1 for the base unit itself."
            >
              <input
                type="number" step="any" value={form.toBaseFactor}
                onChange={e => setForm({ ...form, toBaseFactor: Number(e.target.value) })}
                className="sc-field"
              />
            </Field>
          </FormSection>

          <FormSection
            title="Translations"
            description="A name per language; the symbol stays the same everywhere."
            action={<AddLangButton onClick={addTranslation} label="Add Lang" />}
          >
            <TranslationRows
              value={translations}
              onChange={setTranslations}
              emptyLabel="No translations added."
              textPlaceholder="Translated name"
            />
          </FormSection>
        </div>
      </Modal>
    </>
  );
}
