import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, TranslationRows } from '../components/Form';
import { LibraryToolbar } from '../components/LibraryViewControls';
import { useLibraryView } from '../hooks/useLibraryView';
import { sortLibraryItems } from '../lib/librarySort';

export default function LibraryUnits() {
  const [units, setUnits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingUnit, setEditingUnit] = useState<any>(null);
  const [form, setForm] = useState({ name: '', symbol: '', unitType: '', system: '', toBaseFactor: 1 });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);

  const contentLang = useStore((s) => s.contentLang);
  const { t } = useTranslation();
  const { view, setView, sort, setSort } = useLibraryView('units', 'list');

  // Units group by unit_type (weight, volume, ...), which is what the sort
  // menu's "Type" option orders by.
  const visibleUnits = useMemo(
    () => sortLibraryItems(units, sort, {
      label: (item: any) => item.translated_name || item.name || '',
      group: (item: any) => item.unit_type,
      createdAt: (item: any) => item.created_at,
    }, contentLang),
    [units, sort, contentLang],
  );

  const fetchUnits = () => {
    // Refresh in place after a save — see LibraryIngredients' fetchData.
    if (units.length === 0) setLoading(true);
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
        alert(t('library.shared.saveFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert(t('library.shared.networkErrorSaving'));
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('library.units.confirmDelete'))) return;
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
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">{t('library.units.eyebrow')}</p>
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">{t('library.units.heading')}</h1>
            </div>
            <button onClick={() => handleOpenModal()} className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95">
              <span className="material-symbols-outlined text-xl">add_circle</span>
              {t('library.units.addNew')}
            </button>
          </div>

          <LibraryToolbar
            value={view}
            onChange={setView}
            sortValue={sort}
            sortOptions={['name-asc', 'name-desc', 'group-asc', 'newest', 'oldest']}
            onSortChange={setSort}
            groupLabelKey="library.common.sortType"
          />

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
            {view === 'grid' ? (
              loading ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.units.loading')}</p>
              ) : visibleUnits.length === 0 ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.common.empty')}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {visibleUnits.map((u: any) => (
                    <div
                      key={u.id}
                      className="group relative bg-zinc-50/60 dark:bg-zinc-800/40 rounded-3xl p-5 border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 hover:shadow-sm transition-all text-center"
                    >
                      {/* The symbol is what a unit is recognised by, so it
                          leads the tile the way the photo leads a tool's. */}
                      <p className="text-3xl font-black text-zinc-900 dark:text-zinc-100 leading-none tracking-tight">{u.symbol}</p>
                      <p className="font-bold text-xs text-zinc-600 dark:text-zinc-300 mt-2 truncate" title={u.translated_name || u.name}>
                        {u.translated_name || u.name}
                      </p>
                      <div className="flex items-center justify-center gap-1.5 mt-2">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${u.system === 'metric' ? 'bg-primary/10 text-primary' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'}`}>
                          {u.system ? t(`library.units.systemsShort.${u.system}`, { defaultValue: u.system }) : t('library.units.notSet')}
                        </span>
                        <span className="text-[9px] font-black uppercase text-zinc-400 dark:text-zinc-500">{u.unit_type ? t(`library.units.types.${u.unit_type}`, { defaultValue: u.unit_type }) : ''}</span>
                      </div>
                      <div className="flex justify-center gap-1 mt-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onClick={() => handleOpenModal(u)} title={t('common.edit')} className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button onClick={() => handleDelete(u.id)} title={t('common.delete')} className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
             <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">{t('library.units.unit')}</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-center">{t('library.units.system')}</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{t('library.units.type')}</th>
                    <th className="text-right py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pr-4">{t('library.shared.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={4} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.units.loading')}</td></tr>
                  ) : visibleUnits.map((u: any) => (
                    <tr key={u.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
                      <td className="py-6 pl-4">
                        <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight">{u.translated_name || u.name}</p>
                        <p className="text-zinc-400 dark:text-zinc-500 text-[11px] font-black uppercase mt-1 tracking-tight">{u.symbol}</p>
                      </td>
                      <td className="py-6 text-center">
                         <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${u.system === 'metric' ? 'bg-primary/10 text-primary' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'}`}>
                          {u.system ? t(`library.units.systemsShort.${u.system}`, { defaultValue: u.system }) : t('library.units.notSet')}
                        </span>
                      </td>
                      <td className="py-6 capitalize font-bold text-xs text-zinc-600 dark:text-zinc-400">{u.unit_type ? t(`library.units.types.${u.unit_type}`, { defaultValue: u.unit_type }) : ''}</td>
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
            )}
          </section>
      </AppLayout>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingUnit ? t('library.units.editTitle') : t('library.units.newTitle')}
        subtitle={t('library.units.modalSubtitle')}
        footer={
          <>
            <ModalCancelButton onClick={() => setShowModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>{editingUnit ? t('library.units.update') : t('library.units.add')}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title={t('library.shared.sectionIdentity')}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={t('library.units.fullName')} className="sm:col-span-2">
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder={t('library.units.fullNamePlaceholder')}
                  className="sc-field"
                />
              </Field>
              <Field label={t('library.units.symbol')}>
                <input
                  type="text" required value={form.symbol}
                  onChange={e => setForm({ ...form, symbol: e.target.value })}
                  placeholder="ml"
                  className="sc-field"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title={t('library.units.measurement')}>
            <FieldRow>
              <Field label={t('library.units.type')}>
                <select
                  value={form.unitType}
                  onChange={e => setForm({ ...form, unitType: e.target.value })}
                  className="sc-field cursor-pointer"
                >
                  <option value="volume">{t('library.units.types.volume')}</option>
                  <option value="weight">{t('library.units.types.weight')}</option>
                  <option value="length">{t('library.units.types.length')}</option>
                  <option value="temperature">{t('library.units.types.temperature')}</option>
                  <option value="count">{t('library.units.types.count')}</option>
                </select>
              </Field>
              <Field label={t('library.units.measurementSystem')}>
                <select
                  value={form.system}
                  onChange={e => setForm({ ...form, system: e.target.value })}
                  className="sc-field cursor-pointer"
                >
                  <option value="metric">{t('library.units.systems.metric')}</option>
                  <option value="imperial">{t('library.units.systems.imperial')}</option>
                  <option value="custom">{t('library.units.systems.custom')}</option>
                </select>
              </Field>
            </FieldRow>
            <Field
              label={t('library.units.factor')}
              hint={t('library.units.factorHint')}
            >
              <input
                type="number" step="any" value={form.toBaseFactor}
                onChange={e => setForm({ ...form, toBaseFactor: Number(e.target.value) })}
                className="sc-field"
              />
            </Field>
          </FormSection>

          <FormSection
            title={t('library.shared.translations')}
            description={t('library.units.translationsHint')}
            action={<AddLangButton onClick={addTranslation} label={t('library.shared.addLang')} />}
          >
            <TranslationRows
              value={translations}
              onChange={setTranslations}
              emptyLabel={t('library.shared.noTranslations')}
              textPlaceholder={t('library.shared.translatedNamePlaceholder')}
            />
          </FormSection>
        </div>
      </Modal>
    </>
  );
}
