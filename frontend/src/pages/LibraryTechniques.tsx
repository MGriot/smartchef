import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { TECHNIQUE_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalDeleteButton, ModalSubmitButton } from '../components/Modal';
import { Field, FormSection, IconPicker } from '../components/Form';
import { CatalogItemActions, CatalogMergeModal, CatalogNamingSection, CatalogThumb } from '../components/LibraryCatalog';
import { LibraryToolbar } from '../components/LibraryViewControls';
import { useCatalogMerge } from '../hooks/useCatalogMerge';
import { useLibraryView } from '../hooks/useLibraryView';
import { sortLibraryItems } from '../lib/librarySort';


export default function LibraryTechniques() {
  const [techniques, setTechniques] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTechnique, setEditingTechnique] = useState<any>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: 'TbFlame', imageUrls: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);
  const { t } = useTranslation();
  const { view, setView, sort, setSort } = useLibraryView('techniques', 'list');
  // Fold a duplicate technique into another one. The catalogue collects
  // these on its own — Smart Import creates a technique per parsed step
  // name, so an Italian recipe leaves "Bollitura" next to the "Boil" an
  // English one created.
  const { mergeSource, setMergeSource, mergeTargetId, setMergeTargetId, merging, startMerge, handleMerge } =
    useCatalogMerge<any>('/api/techniques', () => fetchTechniques());

  const fetchTechniques = () => {
    // Refresh in place after a save — see LibraryIngredients' fetchData.
    if (techniques.length === 0) setLoading(true);
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
        icon: technique.icon || 'TbFlame',
        imageUrls: technique.image_urls || [],
        synonyms: technique.synonyms || [],
      });
      setTranslations(technique.translations || []);
    } else {
      setEditingTechnique(null);
      setForm({ name: '', description: '', icon: 'TbFlame', imageUrls: [], synonyms: [] });
      setTranslations([]);
    }
    setShowModal(true);
  };

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
        alert(t('library.shared.saveFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('library.techniques.confirmDelete'))) return;
    try {
      const res = await apiFetch(`/api/techniques/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setShowModal(false);
        fetchTechniques();
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // Memoized: Autocomplete re-syncs its typed text whenever this array's
  // identity changes, so a fresh array each render would clear the box.
  // Techniques have no category column, so the sort menu below omits the
  // group ordering rather than offering one that would silently fall back
  // to alphabetical.
  const visibleTechniques = useMemo(
    () => sortLibraryItems(techniques, sort, {
      label: (item: any) => item.translated_name || item.name || '',
      createdAt: (item: any) => item.created_at,
    }, contentLang),
    [techniques, sort, contentLang],
  );

  const mergeOptions = useMemo(
    () => techniques
      .filter((t) => t.id !== mergeSource?.id)
      .map((t) => ({ id: t.id, label: t.translated_name || t.name })),
    [techniques, mergeSource],
  );

  return (
    <>
      <AppLayout librarySection="techniques">
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">{t('library.shared.eyebrow')}</p>
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">{t('library.techniques.heading')}</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              {t('library.techniques.addNew')}
            </button>
          </div>

          <LibraryToolbar
            value={view}
            onChange={setView}
            sortValue={sort}
            sortOptions={['name-asc', 'name-desc', 'newest', 'oldest']}
            onSortChange={setSort}
          />

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
            {view === 'grid' ? (
              loading ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.shared.loadingItems')}</p>
              ) : visibleTechniques.length === 0 ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.common.empty')}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {visibleTechniques.map((technique: any) => (
                    <div
                      key={technique.id}
                      className="group relative bg-zinc-50/60 dark:bg-zinc-800/40 rounded-3xl p-4 border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 hover:shadow-sm transition-all"
                    >
                      <CatalogThumb layout="tile" imageUrls={technique.image_urls} icon={technique.icon || 'TbFlame'} />
                      <p className="font-extrabold text-sm text-zinc-900 dark:text-zinc-100 leading-tight truncate" title={technique.translated_name || technique.name}>
                        {technique.translated_name || technique.name}
                      </p>
                      {technique.description && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1 line-clamp-2">{technique.description}</p>
                      )}
                      <CatalogItemActions
                        layout="tile"
                        editTitle={t('library.techniques.editThis')}
                        mergeTitle={t('library.techniques.mergeIntoAnother')}
                        onEdit={() => handleOpenModal(technique)}
                        onMerge={() => startMerge(technique)}
                        onDelete={() => handleDelete(technique.id)}
                      />
                    </div>
                  ))}
                </div>
              )
            ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">{t('library.techniques.column')}</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-right pr-4">{t('library.shared.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={2} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.shared.loadingItems')}</td></tr>
                  ) : visibleTechniques.map((technique: any) => (
                    <tr key={technique.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          <CatalogThumb layout="row" imageUrls={technique.image_urls} icon={technique.icon || 'TbFlame'} />
                          <div>
                            <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight">{technique.translated_name || technique.name}</p>
                            <p className="text-zinc-400 dark:text-zinc-500 text-[11px] font-medium tracking-tighter mt-1">{technique.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6 text-right pr-4">
                        <CatalogItemActions
                          layout="row"
                          editTitle={t('library.techniques.editThis')}
                          mergeTitle={t('library.techniques.mergeIntoAnother')}
                          onEdit={() => handleOpenModal(technique)}
                          onMerge={() => startMerge(technique)}
                          onDelete={() => handleDelete(technique.id)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </section>
      </AppLayout>

      {/* ─── Merge Technique ────────────────────────── */}
      <CatalogMergeModal
        open={!!mergeSource}
        onClose={() => setMergeSource(null)}
        title={t('library.techniques.mergeTitle')}
        subtitle={mergeSource ? t('library.techniques.mergeSubtitle', { name: mergeSource.translated_name || mergeSource.name }) : undefined}
        hint={t('library.techniques.mergeIntoHint')}
        placeholder={t('library.techniques.search')}
        options={mergeOptions}
        targetId={mergeTargetId}
        onTargetChange={setMergeTargetId}
        merging={merging}
        onMerge={handleMerge}
      />

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingTechnique ? t('library.techniques.editTitle') : t('library.techniques.newTitle')}
        subtitle={t('library.techniques.modalSubtitle')}
        footer={
          <>
            {editingTechnique && <ModalDeleteButton onClick={() => handleDelete(editingTechnique.id)} label={t('library.techniques.deleteTechnique')} />}
            <ModalCancelButton onClick={() => setShowModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>{editingTechnique ? t('library.techniques.update') : t('library.techniques.add')}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title={t('library.shared.sectionIdentity')}>
            <Field label={t('library.techniques.name')}>
              <input
                type="text" required value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={t('library.techniques.namePlaceholder')}
                className="sc-field"
              />
            </Field>
            <Field label={t('library.shared.description')}>
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder={t('library.techniques.descriptionPlaceholder')}
                className="sc-field h-24 resize-none font-medium"
              />
            </Field>
          </FormSection>

          <FormSection title={t('library.shared.sectionAppearance')} description={t('library.techniques.appearanceHint')}>
            <Field label={t('library.shared.chooseIcon')}>
              <IconPicker icons={TECHNIQUE_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
            <Field label={t('library.shared.referencePhotos')}>
              <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({ ...form, imageUrls: urls })} />
            </Field>
          </FormSection>

          <CatalogNamingSection
            description={t('library.techniques.namingHint')}
            synonyms={form.synonyms}
            onSynonymsChange={synonyms => setForm({ ...form, synonyms })}
            translations={translations}
            onTranslationsChange={setTranslations}
          />
        </div>
      </Modal>
    </>
  );
}
