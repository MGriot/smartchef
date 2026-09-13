import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import { ResolvedImage } from '../components/CoverImage';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { TECHNIQUE_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalDeleteButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FormSection, IconPicker, TranslationRows } from '../components/Form';
import { LibraryToolbar } from '../components/LibraryViewControls';
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
  const [mergeSource, setMergeSource] = useState<any>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [merging, setMerging] = useState(false);

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

  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);

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
    if (!window.confirm("Delete this technique? It's removed from the catalogue and from every step referencing it — this can't be undone. To keep those references, merge it into another technique instead.")) return;
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

  const handleMerge = async () => {
    if (!mergeSource || !mergeTargetId) return;
    setMerging(true);
    try {
      const res = await apiFetch(`/api/techniques/${mergeSource.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: mergeTargetId }),
      });
      const result = await res.json();
      if (res.ok) {
        setMergeSource(null);
        setMergeTargetId('');
        fetchTechniques();
      } else {
        alert(`Merge failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch {
      alert('Network error while merging.');
    } finally {
      setMerging(false);
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
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">Techniques</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              Add New Technique
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
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">Loading items...</p>
              ) : visibleTechniques.length === 0 ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.common.empty')}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {visibleTechniques.map((technique: any) => (
                    <div
                      key={technique.id}
                      className="group relative bg-zinc-50/60 dark:bg-zinc-800/40 rounded-3xl p-4 border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 hover:shadow-sm transition-all"
                    >
                      <div className="aspect-square rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 flex items-center justify-center mb-3">
                        {technique.image_urls?.[0] ? (
                          <ResolvedImage src={technique.image_urls[0]} className="w-full h-full object-cover" />
                        ) : (
                          <RenderFaIcon name={technique.icon || 'TbFlame'} className="text-[32px] text-zinc-300 dark:text-zinc-600" />
                        )}
                      </div>
                      <p className="font-extrabold text-sm text-zinc-900 dark:text-zinc-100 leading-tight truncate" title={technique.translated_name || technique.name}>
                        {technique.translated_name || technique.name}
                      </p>
                      {technique.description && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1 line-clamp-2">{technique.description}</p>
                      )}
                      <div className="flex justify-center gap-1 mt-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onClick={() => handleOpenModal(technique)} title="Edit this technique" className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button onClick={() => { setMergeSource(technique); setMergeTargetId(''); }} title="Merge into another technique" className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                          <span className="material-symbols-outlined text-[18px]">call_merge</span>
                        </button>
                        <button onClick={() => handleDelete(technique.id)} title="Delete" className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
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
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">Technique</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={2} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">Loading items...</td></tr>
                  ) : visibleTechniques.map((technique: any) => (
                    <tr key={technique.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          {technique.image_urls?.[0] ? (
                            <ResolvedImage src={technique.image_urls[0]} className="w-12 h-12 rounded-2xl object-cover bg-zinc-100 dark:bg-zinc-800" />
                          ) : (
                            <div className="w-12 h-12 bg-zinc-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center text-xl text-zinc-400 dark:text-zinc-500">
                              <RenderFaIcon name={technique.icon || 'TbFlame'} className="text-[20px]" />
                            </div>
                          )}
                          <div>
                            <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight">{technique.translated_name || technique.name}</p>
                            <p className="text-zinc-400 dark:text-zinc-500 text-[11px] font-medium tracking-tighter mt-1">{technique.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(technique)} title="Edit this technique" className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => { setMergeSource(technique); setMergeTargetId(''); }} title="Merge into another technique" className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">call_merge</span>
                            </button>
                            <button onClick={() => handleDelete(technique.id)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
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

      {/* ─── Merge Technique ────────────────────────── */}
      <Modal
        open={!!mergeSource}
        onClose={() => setMergeSource(null)}
        size="sm"
        zIndex={120}
        title="Merge Technique"
        subtitle={mergeSource ? `Fold "${mergeSource.translated_name || mergeSource.name}" into another technique. Every step referencing it is repointed automatically — nothing is lost.` : undefined}
        footer={
          <>
            <ModalCancelButton onClick={() => setMergeSource(null)}>Cancel</ModalCancelButton>
            <ModalSubmitButton type="button" onClick={handleMerge} disabled={!mergeTargetId || merging}>
              {merging ? 'Merging…' : 'Merge'}
            </ModalSubmitButton>
          </>
        }
      >
        <Field label="Merge into" hint="Type to search the catalogue, then pick the technique to keep.">
          <Autocomplete
            options={mergeOptions}
            value={mergeTargetId || null}
            onSelect={(id) => setMergeTargetId(id)}
            onClear={() => setMergeTargetId('')}
            placeholder="Search for a technique…"
            className="sc-field"
          />
        </Field>
      </Modal>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingTechnique ? 'Edit Technique' : 'New Technique'}
        subtitle="A named cooking action recipe steps can link to."
        footer={
          <>
            {editingTechnique && <ModalDeleteButton onClick={() => handleDelete(editingTechnique.id)} label="Delete technique" />}
            <ModalCancelButton onClick={() => setShowModal(false)}>Cancel</ModalCancelButton>
            <ModalSubmitButton>{editingTechnique ? 'Update Technique' : 'Add Technique'}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title="Identity">
            <Field label="Technique Name">
              <input
                type="text" required value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Blanch"
                className="sc-field"
              />
            </Field>
            <Field label="Description">
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="What this technique means, when to use it..."
                className="sc-field h-24 resize-none font-medium"
              />
            </Field>
          </FormSection>

          <FormSection title="Appearance" description="The icon shows wherever the technique appears without a photo.">
            <Field label="Choose Icon">
              <IconPicker icons={TECHNIQUE_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
            <Field label="Reference Photos">
              <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({ ...form, imageUrls: urls })} />
            </Field>
          </FormSection>

          <FormSection
            title="Naming"
            description="Alternate names make the technique findable; translations give it a name per language."
            action={<AddLangButton onClick={addTranslation} label="Add Lang" />}
          >
            <Field label="Synonyms">
              <SynonymsEditor value={form.synonyms} onChange={synonyms => setForm({ ...form, synonyms })} />
            </Field>
            <Field label="Translations">
              <TranslationRows
                value={translations}
                onChange={setTranslations}
                emptyLabel="No translations added."
                textPlaceholder="Translated name"
              />
            </Field>
          </FormSection>
        </div>
      </Modal>
    </>
  );
}
