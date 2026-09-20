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
import { TOOL_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalDeleteButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, IconPicker, TranslationRows } from '../components/Form';
import { LibraryToolbar } from '../components/LibraryViewControls';
import { useLibraryView } from '../hooks/useLibraryView';
import { sortLibraryItems } from '../lib/librarySort';


export default function LibraryTools() {
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTool, setEditingTool] = useState<any>(null);
  // Fold a duplicate tool into another one — POST /tools/:id/merge repoints
  // every recipe and every individual step that referenced it, so nothing
  // loses its equipment.
  const [mergeSource, setMergeSource] = useState<any>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [merging, setMerging] = useState(false);
  const [form, setForm] = useState({ name: '', category: '', description: '', icon: 'TbToolsKitchen', imageUrls: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);
  const { t } = useTranslation();
  const { view, setView, sort, setSort } = useLibraryView('tools', 'list');

  // Sorted here rather than by refetching with an ORDER BY: the catalog is
  // already in memory and, in standalone mode, a refetch is a Capacitor
  // bridge round-trip. Keyed off contentLang too so the comparison follows
  // the language the names are actually being read in.
  const visibleTools = useMemo(
    () => sortLibraryItems(tools, sort, {
      label: (item: any) => item.translated_name || item.name || '',
      group: (item: any) => item.category,
      createdAt: (item: any) => item.created_at,
    }, contentLang),
    [tools, sort, contentLang],
  );

  const fetchTools = () => {
    // Refresh in place after a save — see LibraryIngredients' fetchData.
    if (tools.length === 0) setLoading(true);
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
        icon: tool.icon || 'TbToolsKitchen',
        imageUrls: tool.image_urls || [],
        synonyms: tool.synonyms || [],
      });
      setTranslations(tool.translations || []);
    } else {
      setEditingTool(null);
      setForm({ name: '', category: '', description: '', icon: 'TbToolsKitchen', imageUrls: [], synonyms: [] });
      setTranslations([]);
    }
    setShowModal(true);
  };

  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);

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
        alert(t('library.shared.saveFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('library.tools.confirmDelete'))) return;
    try {
      const res = await apiFetch(`/api/tools/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setShowModal(false);
        fetchTools();
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleMerge = async () => {
    if (!mergeSource || !mergeTargetId) return;
    setMerging(true);
    try {
      const res = await apiFetch(`/api/tools/${mergeSource.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: mergeTargetId }),
      });
      const result = await res.json();
      if (res.ok) {
        setMergeSource(null);
        setMergeTargetId('');
        fetchTools();
      } else {
        alert(t('library.shared.mergeFailed', { error: JSON.stringify(result.error || result) }));
      }
    } catch {
      alert(t('library.shared.networkErrorMerging'));
    } finally {
      setMerging(false);
    }
  };

  // Built once per tools/mergeSource change rather than inline in the JSX:
  // Autocomplete re-syncs its typed text whenever this array's identity
  // changes, so a fresh array on every keystroke would wipe the search box.
  const mergeOptions = useMemo(
    () => tools
      .filter((t) => t.id !== mergeSource?.id)
      .map((t) => ({ id: t.id, label: t.translated_name || t.name, sublabel: t.category || undefined })),
    [tools, mergeSource],
  );

  return (
    <>
      <AppLayout librarySection="tools">
          <div className="flex justify-between items-end mb-10">
            <div>
              <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">{t('library.shared.eyebrow')}</p>
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">{t('library.tools.heading')}</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              {t('library.tools.addNew')}
            </button>
          </div>

          <LibraryToolbar
            value={view}
            onChange={setView}
            sortValue={sort}
            sortOptions={['name-asc', 'name-desc', 'group-asc', 'newest', 'oldest']}
            onSortChange={setSort}
            groupLabelKey="library.common.sortCategory"
          />

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
            {view === 'grid' ? (
              loading ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.shared.loadingItems')}</p>
              ) : visibleTools.length === 0 ? (
                <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.common.empty')}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {visibleTools.map((tool: any) => (
                    <div
                      key={tool.id}
                      className="group relative bg-zinc-50/60 dark:bg-zinc-800/40 rounded-3xl p-4 border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 hover:shadow-sm transition-all"
                    >
                      <div className="aspect-square rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 flex items-center justify-center mb-3">
                        {tool.image_urls?.[0] ? (
                          <ResolvedImage src={tool.image_urls[0]} className="w-full h-full object-cover" />
                        ) : (
                          <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-[32px] text-zinc-300 dark:text-zinc-600" />
                        )}
                      </div>
                      <p className="font-extrabold text-sm text-zinc-900 dark:text-zinc-100 leading-tight truncate" title={tool.translated_name || tool.name}>
                        {tool.translated_name || tool.name}
                      </p>
                      <p className="text-[10px] font-black uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mt-1 truncate">
                        {tool.category || t('library.tools.general')}
                      </p>
                      {/* Same three actions as the table row, revealed on hover
                          so the tile stays readable as a catalog at a glance. */}
                      <div className="flex justify-center gap-1 mt-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onClick={() => handleOpenModal(tool)} title={t('library.tools.editThis')} className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button onClick={() => { setMergeSource(tool); setMergeTargetId(''); }} title={t('library.tools.mergeIntoAnother')} className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                          <span className="material-symbols-outlined text-[18px]">call_merge</span>
                        </button>
                        <button onClick={() => handleDelete(tool.id)} title={t('common.delete')} className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
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
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">{t('library.tools.toolDetails')}</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{t('library.shared.category')}</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-right pr-4">{t('library.shared.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={3} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">{t('library.shared.loadingItems')}</td></tr>
                  ) : visibleTools.map((tool: any) => (
                    <tr key={tool.id} className="group hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50 transition-colors">
                      <td className="py-6 pl-4">
                        <div className="flex items-center gap-4">
                          {tool.image_urls?.[0] ? (
                            <ResolvedImage src={tool.image_urls[0]} className="w-12 h-12 rounded-2xl object-cover bg-zinc-100 dark:bg-zinc-800" />
                          ) : (
                            <div className="w-12 h-12 bg-zinc-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center text-xl text-zinc-400 dark:text-zinc-500">
                              <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-[20px]" />
                            </div>
                          )}
                          <div>
                            <p className="font-extrabold text-zinc-900 dark:text-zinc-100 leading-tight">{tool.translated_name || tool.name}</p>
                            <p className="text-zinc-400 dark:text-zinc-500 text-[11px] font-medium tracking-tighter mt-1">{tool.description}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-6">
                        <span className="px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[10px] font-black uppercase rounded-md border border-zinc-200/50 dark:border-zinc-700/50">
                          {tool.category || t('library.tools.general')}
                        </span>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(tool)} title={t('library.tools.editThis')} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
                            </button>
                            <button onClick={() => { setMergeSource(tool); setMergeTargetId(''); }} title={t('library.tools.mergeIntoAnother')} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">call_merge</span>
                            </button>
                            <button onClick={() => handleDelete(tool.id)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-tertiary transition-all">
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

      {/* ─── Merge Tool ──────────────────────────────────────────────── */}
      <Modal
        open={!!mergeSource}
        onClose={() => setMergeSource(null)}
        size="sm"
        zIndex={120}
        title={t('library.tools.mergeTitle')}
        subtitle={mergeSource ? t('library.tools.mergeSubtitle', { name: mergeSource.translated_name || mergeSource.name }) : undefined}
        footer={
          <>
            <ModalCancelButton onClick={() => setMergeSource(null)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton type="button" onClick={handleMerge} disabled={!mergeTargetId || merging}>
              {merging ? t('library.shared.merging') : t('library.shared.merge')}
            </ModalSubmitButton>
          </>
        }
      >
        <Field label={t('library.shared.mergeIntoLabel')} hint={t('library.tools.mergeIntoHint')}>
          <Autocomplete
            options={mergeOptions}
            value={mergeTargetId || null}
            onSelect={(id) => setMergeTargetId(id)}
            onClear={() => setMergeTargetId('')}
            placeholder={t('library.tools.search')}
            className="sc-field"
          />
        </Field>
      </Modal>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingTool ? t('library.tools.editTitle') : t('library.tools.newTitle')}
        subtitle={editingTool ? t('library.tools.editSubtitle') : t('library.tools.newSubtitle')}
        footer={
          <>
            {editingTool && <ModalDeleteButton onClick={() => handleDelete(editingTool.id)} label={t('library.tools.deleteTool')} />}
            <ModalCancelButton onClick={() => setShowModal(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>{editingTool ? t('library.tools.update') : t('library.tools.register')}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title={t('library.shared.sectionIdentity')}>
            <FieldRow>
              <Field label={t('library.tools.name')}>
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder={t('library.tools.namePlaceholder')}
                  className="sc-field"
                />
              </Field>
              <Field label={t('library.shared.category')} hint={t('library.tools.categoryHint')}>
                <input
                  type="text" value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  placeholder={t('library.tools.categoryPlaceholder')}
                  className="sc-field"
                />
              </Field>
            </FieldRow>
            <Field label={t('library.tools.specs')}>
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder={t('library.tools.specsPlaceholder')}
                className="sc-field h-24 resize-none font-medium"
              />
            </Field>
          </FormSection>

          <FormSection title={t('library.shared.sectionAppearance')} description={t('library.tools.appearanceHint')}>
            <Field label={t('library.shared.chooseIcon')}>
              <IconPicker icons={TOOL_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
            <Field label={t('library.shared.referencePhotos')}>
              <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({ ...form, imageUrls: urls })} />
            </Field>
          </FormSection>

          <FormSection
            title={t('library.shared.sectionNaming')}
            description={t('library.tools.namingHint')}
            action={<AddLangButton onClick={addTranslation} label={t('library.shared.addLang')} />}
          >
            <Field label={t('library.shared.synonyms')}>
              <SynonymsEditor value={form.synonyms} onChange={synonyms => setForm({ ...form, synonyms })} />
            </Field>
            <Field label={t('library.shared.translations')}>
              <TranslationRows
                value={translations}
                onChange={setTranslations}
                emptyLabel={t('library.shared.noTranslations')}
                textPlaceholder={t('library.shared.translatedNamePlaceholder')}
              />
            </Field>
          </FormSection>

          {editingTool && (
            <p className="sc-hint font-mono">ID {editingTool.id}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
