import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import RenderFaIcon from '../components/RenderFaIcon';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { useTagGroupLabels } from '../hooks/useTagGroupLabels';
import { TAG_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalDeleteButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, IconPicker, TranslationRows } from '../components/Form';
import { LibraryToolbar } from '../components/LibraryViewControls';
import { useLibraryView } from '../hooks/useLibraryView';
import { sortLibraryItems } from '../lib/librarySort';


const DEFAULT_COLOR = '#3f3f46';

export default function LibraryTags() {
  const { t } = useTranslation();
  const [tags, setTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTag, setEditingTag] = useState<any>(null);
  const [form, setForm] = useState({ name: '', groupName: 'Altro', color: DEFAULT_COLOR, icon: 'TbTag', excludeTagIds: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);
  const { view, setView, sort, setSort } = useLibraryView('tags', 'grid');
  // Group headings: the user's own translation for the group first, then
  // the static lookup for the seeded groups — see hooks/useTagGroupLabels.
  const { label: groupLabel, translations: groupTranslations, reload: reloadGroupTranslations } = useTagGroupLabels();

  // Free-text recipe tags that were never added to the managed catalog —
  // see tags.local.ts's listCustomTagsInUse() / backend's GET /tags/custom.
  const [customTags, setCustomTags] = useState<{ name: string; count: number }[]>([]);
  const [addingCustom, setAddingCustom] = useState<string | null>(null);

  // Merge-into-a-catalog-tag modal — shared by both a custom (not-in-
  // catalog, name only) tag and a catalog (has a real id) tag, since the
  // "pick a target catalog tag" UI is identical either way.
  const [mergeSource, setMergeSource] = useState<{ id?: string; name: string } | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [merging, setMerging] = useState(false);

  // Merge-groups modal — reassigns every tag in one group to another.
  const [mergingGroup, setMergingGroup] = useState<string | null>(null);
  const [mergingGroupBusy, setMergingGroupBusy] = useState(false);

  const fetchTags = () => {
    setLoading(true);
    apiFetch(`/api/tags${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setTags(json.data || []);
        setLoading(false);
      });
  };

  const fetchCustomTags = () => {
    apiFetch('/api/tags/custom')
      .then(res => res.json())
      .then(json => setCustomTags(json.data || []))
      .catch(() => setCustomTags([]));
  };

  useEffect(() => {
    fetchTags();
    fetchCustomTags();
  }, [contentLang]);

  const handleAddCustomToCatalog = async (name: string) => {
    setAddingCustom(name);
    try {
      const res = await apiFetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, groupName: 'Altro' }),
      });
      if (res.ok) {
        fetchTags();
        fetchCustomTags();
      } else {
        const result = await res.json();
        alert(`Failed to add tag: ${JSON.stringify(result.error || result)}`);
      }
    } catch {
      alert('Network error while adding tag.');
    } finally {
      setAddingCustom(null);
    }
  };

  // Handles both a custom (name only) tag and a catalog (real id) tag —
  // mergeSource.id present means "merge two catalog tags" (POST
  // /tags/:id/merge), absent means "merge a free-text tag into a catalog
  // tag" (POST /tags/custom/merge). Same target picker either way.
  const handleMerge = async () => {
    if (!mergeSource || !mergeTargetId) return;
    setMerging(true);
    try {
      const url = mergeSource.id ? `/api/tags/${mergeSource.id}/merge` : '/api/tags/custom/merge';
      const body = mergeSource.id ? { targetId: mergeTargetId } : { name: mergeSource.name, targetTagId: mergeTargetId };
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (res.ok) {
        setMergeSource(null);
        setMergeTargetId('');
        fetchTags();
        fetchCustomTags();
      } else {
        alert(`Merge failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch {
      alert('Network error while merging.');
    } finally {
      setMerging(false);
    }
  };

  /** One dialog, two independent changes: the group's name (a bulk rename
   *  of tags.group_name, which is also how two groups get merged) and its
   *  translated labels. Either can be left alone — renaming without
   *  touching the translations, or translating without renaming, both have
   *  to work — so the rename is skipped when the name came back unchanged
   *  and the translations are saved against whatever name the group ends
   *  up with. Order matters: rename first, so the labels land on the new
   *  name rather than being carried across by the merge and then
   *  overwritten. */
  const handleMergeGroup = async (targetGroup: string, translations: { lang: string; name: string }[]) => {
    const nextGroup = targetGroup.trim();
    if (!mergingGroup || !nextGroup) {
      setMergingGroup(null);
      return;
    }
    setMergingGroupBusy(true);
    try {
      if (nextGroup !== mergingGroup) {
        const res = await apiFetch('/api/tags/groups/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceGroup: mergingGroup, targetGroup: nextGroup }),
        });
        if (!res.ok) {
          const result = await res.json();
          alert(`Failed: ${JSON.stringify(result.error || result)}`);
          return;
        }
      }
      const transRes = await apiFetch('/api/tags/groups/translations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupName: nextGroup,
          translations: translations.filter(tr => tr.lang.trim() && tr.name.trim()),
        }),
      });
      if (!transRes.ok) {
        const result = await transRes.json();
        alert(`Group renamed, but its translations could not be saved: ${JSON.stringify(result.error || result)}`);
      }
      setMergingGroup(null);
      fetchTags();
      reloadGroupTranslations();
    } catch {
      alert('Network error while saving the group.');
    } finally {
      setMergingGroupBusy(false);
    }
  };

  /** Dissolves a group: its tags become ungrouped and stay exactly where
   *  they were otherwise. Nothing is deleted, which is why this asks with
   *  the tag count in the question rather than the usual "are you sure". */
  const handleDeleteGroup = async () => {
    if (!mergingGroup) return;
    const count = (groups[mergingGroup] || []).length;
    if (!window.confirm(`Remove the group "${groupLabel(mergingGroup)}"? Its ${count} tag${count === 1 ? '' : 's'} stay, but become ungrouped.`)) return;
    setMergingGroupBusy(true);
    try {
      const res = await apiFetch('/api/tags/groups/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupName: mergingGroup }),
      });
      if (!res.ok) {
        const result = await res.json();
        alert(`Failed: ${JSON.stringify(result.error || result)}`);
        return;
      }
      setMergingGroup(null);
      fetchTags();
      reloadGroupTranslations();
    } catch {
      alert('Network error while removing the group.');
    } finally {
      setMergingGroupBusy(false);
    }
  };

  const handleOpenModal = (tag: any = null) => {
    if (tag) {
      setEditingTag(tag);
      setForm({
        name: tag.name,
        // ?? not || — '' is the ungrouped bucket and must round-trip, or
        // editing an ungrouped tag would silently re-file it under 'Altro'.
        groupName: tag.group_name ?? 'Altro',
        color: tag.color || DEFAULT_COLOR,
        icon: tag.icon || 'TbTag',
        excludeTagIds: tag.exclude_tag_ids || [],
        synonyms: tag.synonyms || [],
      });
      setTranslations(tag.translations || []);
    } else {
      setEditingTag(null);
      // Left blank (not pre-filled with 'Altro') so the "e.g. Dieta"
      // placeholder and the existing-groups datalist are actually visible.
      // Saving it blank now files the tag under Ungrouped rather than under
      // the 'Altro' catch-all — '' became a real group_name value when
      // groups got a Remove action to put their tags somewhere.
      setForm({ name: '', groupName: '', color: DEFAULT_COLOR, icon: 'TbTag', excludeTagIds: [], synonyms: [] });
      setTranslations([]);
    }
    setShowModal(true);
  };

  // Memoized rather than built inline in the JSX: Autocomplete re-syncs its
  // typed text whenever this array's identity changes, so a fresh array on
  // every render would clear the search box out from under the user.
  const mergeOptions = useMemo(
    () => tags
      .filter(tag => tag.id !== mergeSource?.id)
      .map(tag => ({ id: tag.id, label: tag.translated_name || tag.name, sublabel: tag.group_name || undefined })),
    [tags, mergeSource],
  );

  const addTranslation = () => setTranslations([...translations, { lang: '', name: '' }]);

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
    if (!window.confirm("Delete this tag? It's removed from the catalog and from every recipe currently carrying it — this can't be undone.")) return;
    try {
      const res = await apiFetch(`/api/tags/${id}`, { method: 'DELETE' });
      if (res.ok) fetchTags();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleDeleteCustomTag = async (name: string) => {
    if (!window.confirm(`Delete "${name}" from every recipe carrying it? This can't be undone.`)) return;
    try {
      const res = await apiFetch('/api/tags/custom/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) fetchCustomTags();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // Sorted once, then grouped from the sorted array — so the chosen order
  // holds *within* each group heading in grid view, and the flat list view
  // gets the same ordering with the grouping dropped. Building groups from
  // the sorted list also means group headings themselves appear in the order
  // their first tag does, which is what makes "Group" sort read correctly.
  const sortedTags = useMemo(
    () => sortLibraryItems(tags, sort, {
      label: (item: any) => item.translated_name || item.name || '',
      group: (item: any) => item.group_name,
      createdAt: (item: any) => item.created_at,
    }, contentLang),
    [tags, sort, contentLang],
  );

  const groups = useMemo(
    () => sortedTags.reduce<Record<string, any[]>>((acc, tag: any) => {
      (acc[tag.group_name] ||= []).push(tag);
      return acc;
    }, {}),
    [sortedTags],
  );

  return (
    <>
      <AppLayout librarySection="tags">
        <div className="flex justify-between items-end mb-10">
          <div>
            <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">The Atelier Management</p>
            <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">Tags</h1>
          </div>
          <button
            onClick={() => handleOpenModal()}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
          >
            <span className="material-symbols-outlined">add</span>
            New Tag
          </button>
        </div>

        <LibraryToolbar
          value={view}
          onChange={setView}
          sortValue={sort}
          sortOptions={['name-asc', 'name-desc', 'group-asc', 'newest', 'oldest']}
          onSortChange={setSort}
        />

        <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 space-y-8">
          {loading ? (
            <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">Loading tags...</p>
          ) : Object.keys(groups).length === 0 ? (
            <p className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">No tags yet — create your first one.</p>
          ) : view === 'list' ? (
            /* Flat, one tag per row, grouping dropped — the chip cloud is
               lovely for browsing a handful of groups and hopeless for
               finding one tag among fifty. The group is shown as a column
               instead of a heading so the chosen sort stays visible. */
            <div className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {sortedTags.map((tag: any) => (
                <div key={tag.id} className="group flex items-center gap-4 py-3">
                  <span
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[14px] shrink-0"
                    style={{ backgroundColor: tag.color || DEFAULT_COLOR }}
                  >
                    <RenderFaIcon name={tag.icon || 'TbTag'} />
                  </span>
                  <button type="button" onClick={() => handleOpenModal(tag)} className="flex-1 min-w-0 text-left">
                    <span className="block font-extrabold text-zinc-900 dark:text-zinc-100 text-sm leading-tight truncate">
                      {tag.translated_name || tag.name}
                    </span>
                    {tag.exclude_tag_ids?.length > 0 && (
                      <span className="block text-[10px] font-medium text-zinc-400 dark:text-zinc-500">Auto (diet)</span>
                    )}
                  </button>
                  <span className="px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[10px] font-black uppercase rounded-md shrink-0">
                    {groupLabel(tag.group_name)}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setMergeSource({ id: tag.id, name: tag.translated_name || tag.name }); setMergeTargetId(''); }}
                    title="Merge into another tag"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all shrink-0"
                  >
                    <span className="material-symbols-outlined text-[16px]">call_merge</span>
                  </button>
                </div>
              ))}
            </div>
          ) : Object.entries(groups).map(([group, groupTags]) => (
            <div key={group}>
              <div className="flex items-center gap-1.5 mb-3">
                <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                  {groupLabel(group)}
                </p>
                <button
                  type="button"
                  onClick={() => setMergingGroup(group)}
                  title={group ? 'Rename, merge or remove this group' : 'File these tags under a group'}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
                >
                  <span className="material-symbols-outlined text-[13px]">edit</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                {groupTags.map(tag => (
                  <div
                    key={tag.id}
                    className="group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800 hover:border-zinc-200 dark:hover:border-zinc-700 hover:shadow-sm transition-all"
                  >
                    <button type="button" onClick={() => handleOpenModal(tag)} className="flex items-center gap-2">
                      <span
                        className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[13px] shrink-0"
                        style={{ backgroundColor: tag.color || DEFAULT_COLOR }}
                      >
                        <RenderFaIcon name={tag.icon || 'TbTag'} />
                      </span>
                      <span className="text-left">
                        <span className="block font-extrabold text-zinc-900 dark:text-zinc-100 text-sm leading-tight">{tag.translated_name || tag.name}</span>
                        {tag.exclude_tag_ids?.length > 0 && (
                          <span className="block text-[10px] font-medium text-zinc-400 dark:text-zinc-500">Auto (diet)</span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMergeSource({ id: tag.id, name: tag.translated_name || tag.name }); setMergeTargetId(''); }}
                      title="Merge into another tag"
                      className="w-7 h-7 rounded-full flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:text-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all shrink-0"
                    >
                      <span className="material-symbols-outlined text-[15px]">call_merge</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        {customTags.length > 0 && (
          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 mt-8">
            <div className="mb-6">
              <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">Custom Tags (not in catalog)</h2>
              <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">
                Free-text tags typed directly onto a recipe that aren't part of the managed catalog above.
                Add one to the catalog to start managing it, or merge it into an existing tag.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {customTags.map(ct => (
                <div key={ct.name} className="flex items-center gap-2 pl-4 pr-2 py-2 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-900">
                  <span className="text-sm font-bold text-zinc-600 dark:text-zinc-400">{ct.name}</span>
                  <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500">×{ct.count}</span>
                  <button
                    type="button"
                    onClick={() => handleAddCustomToCatalog(ct.name)}
                    disabled={addingCustom === ct.name}
                    title="Add to catalog"
                    className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-lg">{addingCustom === ct.name ? 'sync' : 'add_circle'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMergeSource({ name: ct.name }); setMergeTargetId(''); }}
                    title="Merge into an existing tag"
                    className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all"
                  >
                    <span className="material-symbols-outlined text-lg">call_merge</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomTag(ct.name)}
                    title="Delete from every recipe"
                    className="w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-red-500 transition-all"
                  >
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </AppLayout>

      {/* ─── Merge Tag ───────────────────────────────────── */}
      <Modal
        open={!!mergeSource}
        onClose={() => setMergeSource(null)}
        size="sm"
        zIndex={120}
        title="Merge Tag"
        subtitle={mergeSource ? `Fold "${mergeSource.name}" into an existing catalog tag. Every recipe carrying it is repointed automatically — nothing is lost.` : undefined}
        footer={
          <>
            <ModalCancelButton onClick={() => setMergeSource(null)}>Cancel</ModalCancelButton>
            <ModalSubmitButton type="button" onClick={handleMerge} disabled={!mergeTargetId || merging}>
              {merging ? 'Merging…' : 'Merge'}
            </ModalSubmitButton>
          </>
        }
      >
        {/* Was a hand-rolled input + filtered list. It kept its typed text in
            the *page's* state, so every keystroke re-rendered the whole tag
            catalog behind the dialog — and the list only appeared while no
            target was picked, so correcting a choice meant clearing the box
            first. Autocomplete is the same control the rest of the app
            searches its catalogs with: the text stays inside it (the page
            no longer re-renders as you type), arrow keys and Enter work,
            and a suggestion's onMouseDown keeps focus in the field. */}
        <Field label="Merge into" hint="Type to search the catalog, then pick the tag to keep.">
          <Autocomplete
            options={mergeOptions}
            value={mergeTargetId || null}
            onSelect={(id) => setMergeTargetId(id)}
            onClear={() => setMergeTargetId('')}
            placeholder="Search for a tag…"
            className="sc-field"
          />
        </Field>
      </Modal>

      {/* ─── Rename / Merge Group ──────────────────────────────────────── */}
      {mergingGroup && (
        <RenameGroupModal
          currentGroup={mergingGroup}
          existingGroups={Object.keys(groups).filter(g => g !== mergingGroup && g !== '')}
          onDelete={mergingGroup ? handleDeleteGroup : undefined}
          initialTranslations={groupTranslations[mergingGroup] ?? []}
          busy={mergingGroupBusy}
          onCancel={() => setMergingGroup(null)}
          onConfirm={handleMergeGroup}
        />
      )}

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingTag ? 'Edit Tag' : 'New Tag'}
        subtitle="Tags group recipes and drive the gallery's filters."
        footer={
          <>
            {editingTag && <ModalDeleteButton onClick={() => handleDelete(editingTag.id)} label="Delete tag" />}
            <ModalCancelButton onClick={() => setShowModal(false)}>Cancel</ModalCancelButton>
            <ModalSubmitButton>{editingTag ? 'Update Tag' : 'Add Tag'}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title="Identity">
            <FieldRow>
              <Field label="Name">
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Vegetariano"
                  className="sc-field"
                />
              </Field>
              <Field label="Group" hint="Type a new name to create a group, or pick an existing one from the suggestions.">
                <input
                  type="text" list="tag-groups" value={form.groupName}
                  onChange={e => setForm({ ...form, groupName: e.target.value })}
                  placeholder="e.g. Dieta"
                  className="sc-field"
                />
                <datalist id="tag-groups">
                  {Object.keys(groups).map(g => <option key={g} value={g} />)}
                </datalist>
              </Field>
            </FieldRow>
          </FormSection>

          <FormSection title="Appearance">
            <Field label="Color">
              <div className="flex items-center gap-3">
                <input
                  type="color" value={form.color}
                  onChange={e => setForm({ ...form, color: e.target.value })}
                  className="h-12 w-16 shrink-0 cursor-pointer rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-transparent p-1"
                />
                <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">{form.color}</span>
              </div>
            </Field>
            <Field label="Choose Icon">
              <IconPicker icons={TAG_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
          </FormSection>

          <FormSection
            title="Auto-apply"
            description="If any are checked, this tag is added automatically to a recipe unless it contains an ingredient carrying one of these."
          >
            <div className="sc-panel flex flex-wrap gap-2 p-4">
              {tags.filter(t => t.id !== editingTag?.id).map(t => {
                const on = form.excludeTagIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleExclude(t.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-all ${
                      on
                        ? 'border-transparent text-white'
                        : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'
                    }`}
                    style={on ? { backgroundColor: t.color || DEFAULT_COLOR } : undefined}
                  >
                    {t.translated_name || t.name}
                  </button>
                );
              })}
              {tags.filter(t => t.id !== editingTag?.id).length === 0 && (
                <p className="sc-hint italic">No other tags yet.</p>
              )}
            </div>
          </FormSection>

          <FormSection
            title="Naming"
            description="Alternate names make the tag findable; translations give it a name per language."
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

/** Renaming a group, merging it into another one, and giving it a label
 *  per language are all one dialog, because the first two are the same
 *  operation (a bulk group_name reassignment — see tags.local.ts's
 *  mergeTagGroups()) and the third is keyed by the name the first two
 *  decide. Type a brand-new name to rename the group, or pick an existing
 *  other group from the suggestions to fold into it instead; either way
 *  the translations below are saved against whatever name it ends up with.
 *
 *  A tag group has no row of its own to hang translations off — group_name
 *  is free text on the tag — so before this there was no way to translate
 *  one at all: the four seeded groups had a static lookup in
 *  lib/tagGroups.ts and every group anyone typed themselves showed the
 *  same text in every language. */
function RenameGroupModal({
  currentGroup, existingGroups, initialTranslations, busy, onCancel, onConfirm, onDelete,
}: {
  currentGroup: string; existingGroups: string[];
  initialTranslations: Array<{ lang: string; name: string }>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (newName: string, translations: Array<{ lang: string; name: string }>) => void;
  /** Dissolves the group, leaving its tags ungrouped. Absent for the
   *  ungrouped bucket itself, which has no group to remove. */
  onDelete?: () => void;
}) {
  const [name, setName] = useState(currentGroup);
  const [translations, setTranslations] = useState(initialTranslations);
  const renaming = name.trim() !== currentGroup;
  const merging = existingGroups.includes(name.trim());
  return (
    <Modal
      open
      onClose={onCancel}
      size="sm"
      zIndex={120}
      title="Group"
      subtitle={currentGroup
        ? `Rename "${currentGroup}", fold it into another group, remove it, or give it a name per language.`
        : 'File these ungrouped tags under a group by typing its name.'}
      footer={
        <>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="mr-auto px-4 py-2 rounded-full text-sm font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors disabled:opacity-50"
            >
              Remove group
            </button>
          )}
          <ModalCancelButton onClick={onCancel}>Cancel</ModalCancelButton>
          <ModalSubmitButton type="button" onClick={() => onConfirm(name, translations)} disabled={!name.trim() || busy}>
            {busy ? 'Saving…' : merging ? 'Merge' : renaming ? 'Rename' : 'Save'}
          </ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-8">
        <FormSection
          title="Name"
          description="Every tag currently under this group moves to whatever you type here. A brand-new name renames the group; an existing one folds the two together. Removing the group instead leaves its tags in place, ungrouped."
        >
          <Field label="Group name">
            <input
              type="text"
              list="rename-group-suggestions"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              className="sc-field"
            />
            <datalist id="rename-group-suggestions">
              {existingGroups.map(g => <option key={g} value={g} />)}
            </datalist>
          </Field>
        </FormSection>

        <FormSection
          title="Naming"
          description="What this group's heading reads as in each language, wherever tags are grouped."
          action={<AddLangButton onClick={() => setTranslations([...translations, { lang: '', name: '' }])} label="Add Lang" />}
        >
          <Field label="Translations">
            <TranslationRows
              value={translations}
              onChange={setTranslations}
              emptyLabel="No translations added — the heading reads the same in every language."
              textPlaceholder="Translated group name"
            />
          </Field>
        </FormSection>
      </div>
    </Modal>
  );
}
