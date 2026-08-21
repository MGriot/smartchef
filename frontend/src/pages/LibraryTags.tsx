import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { translateTagGroup } from '../lib/tagGroups';

const TAG_ICONS = [
  'FaTag', 'FaLeaf', 'FaSeedling', 'FaDrumstickBite', 'FaFish', 'FaShrimp',
  'FaEgg', 'FaCheese', 'FaWheatAwn', 'FaTree', 'FaUtensils', 'FaBowlFood',
  'FaCarrot', 'FaIceCream', 'FaMugHot'
];

const DEFAULT_COLOR = '#3f3f46';

export default function LibraryTags() {
  const { t } = useTranslation();
  const [tags, setTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTag, setEditingTag] = useState<any>(null);
  const [form, setForm] = useState({ name: '', groupName: 'Altro', color: DEFAULT_COLOR, icon: 'FaTag', excludeTagIds: [] as string[], synonyms: [] as string[] });
  const [translations, setTranslations] = useState<{ lang: string; name: string }[]>([]);
  const contentLang = useStore((s) => s.contentLang);

  // Free-text recipe tags that were never added to the managed catalog —
  // see tags.local.ts's listCustomTagsInUse() / backend's GET /tags/custom.
  const [customTags, setCustomTags] = useState<{ name: string; count: number }[]>([]);
  const [addingCustom, setAddingCustom] = useState<string | null>(null);

  // Merge-into-a-catalog-tag modal — shared by both a custom (not-in-
  // catalog, name only) tag and a catalog (has a real id) tag, since the
  // "pick a target catalog tag" UI is identical either way.
  const [mergeSource, setMergeSource] = useState<{ id?: string; name: string } | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeQuery, setMergeQuery] = useState('');
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
        setMergeQuery('');
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

  const handleMergeGroup = async (targetGroup: string) => {
    if (!mergingGroup || !targetGroup.trim() || targetGroup.trim() === mergingGroup) {
      setMergingGroup(null);
      return;
    }
    setMergingGroupBusy(true);
    try {
      const res = await apiFetch('/api/tags/groups/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceGroup: mergingGroup, targetGroup: targetGroup.trim() }),
      });
      const result = await res.json();
      if (res.ok) {
        setMergingGroup(null);
        fetchTags();
      } else {
        alert(`Failed: ${JSON.stringify(result.error || result)}`);
      }
    } catch {
      alert('Network error while renaming group.');
    } finally {
      setMergingGroupBusy(false);
    }
  };

  const handleOpenModal = (tag: any = null) => {
    if (tag) {
      setEditingTag(tag);
      setForm({
        name: tag.name,
        groupName: tag.group_name || 'Altro',
        color: tag.color || DEFAULT_COLOR,
        icon: tag.icon || 'FaTag',
        excludeTagIds: tag.exclude_tag_ids || [],
        synonyms: tag.synonyms || [],
      });
      setTranslations(tag.translations || []);
    } else {
      setEditingTag(null);
      // Left blank (not pre-filled with 'Altro') so the "e.g. Dieta" placeholder
      // and the existing-groups datalist are actually visible — the backend
      // still falls back to 'Altro' if this is saved empty.
      setForm({ name: '', groupName: '', color: DEFAULT_COLOR, icon: 'FaTag', excludeTagIds: [], synonyms: [] });
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
              <div className="flex items-center gap-1.5 mb-3">
                <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{translateTagGroup(group, t)}</p>
                <button
                  type="button"
                  onClick={() => setMergingGroup(group)}
                  title="Rename or merge this group"
                  className="w-5 h-5 rounded-full flex items-center justify-center text-zinc-300 hover:text-primary hover:bg-zinc-100 transition-all"
                >
                  <span className="material-symbols-outlined text-[13px]">edit</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                {groupTags.map(tag => (
                  <div
                    key={tag.id}
                    className="group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-2xl border border-zinc-100 hover:border-zinc-200 hover:shadow-sm transition-all"
                  >
                    <button type="button" onClick={() => handleOpenModal(tag)} className="flex items-center gap-2">
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
                    <button
                      type="button"
                      onClick={() => { setMergeSource({ id: tag.id, name: tag.translated_name || tag.name }); setMergeTargetId(''); setMergeQuery(''); }}
                      title="Merge into another tag"
                      className="w-7 h-7 rounded-full flex items-center justify-center text-zinc-300 hover:text-primary hover:bg-zinc-100 transition-all shrink-0"
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
          <section className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 mt-8">
            <div className="mb-6">
              <h2 className="text-lg font-black text-zinc-900">Custom Tags (not in catalog)</h2>
              <p className="text-sm text-zinc-400 font-medium mt-1">
                Free-text tags typed directly onto a recipe that aren't part of the managed catalog above.
                Add one to the catalog to start managing it, or merge it into an existing tag.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {customTags.map(ct => (
                <div key={ct.name} className="flex items-center gap-2 pl-4 pr-2 py-2 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50">
                  <span className="text-sm font-bold text-zinc-600">{ct.name}</span>
                  <span className="text-[10px] font-black text-zinc-400">×{ct.count}</span>
                  <button
                    type="button"
                    onClick={() => handleAddCustomToCatalog(ct.name)}
                    disabled={addingCustom === ct.name}
                    title="Add to catalog"
                    className="w-8 h-8 rounded-full hover:bg-white flex items-center justify-center text-zinc-400 hover:text-primary transition-all disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-lg">{addingCustom === ct.name ? 'sync' : 'add_circle'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMergeSource({ name: ct.name }); setMergeTargetId(''); setMergeQuery(''); }}
                    title="Merge into an existing tag"
                    className="w-8 h-8 rounded-full hover:bg-white flex items-center justify-center text-zinc-400 hover:text-primary transition-all"
                  >
                    <span className="material-symbols-outlined text-lg">call_merge</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomTag(ct.name)}
                    title="Delete from every recipe"
                    className="w-8 h-8 rounded-full hover:bg-white flex items-center justify-center text-zinc-400 hover:text-red-500 transition-all"
                  >
                    <span className="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </AppLayout>

      {/* ─── Merge Tag ─────────────────────────────────────────────────── */}
      {mergeSource && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setMergeSource(null)} />
          <div className="relative bg-white w-full max-w-md rounded-[32px] p-8 shadow-2xl">
            <h2 className="text-2xl font-black text-zinc-900 mb-2">Merge Tag</h2>
            <p className="text-sm text-zinc-500 mb-6">
              Fold <strong className="text-zinc-700">{mergeSource.name}</strong> into an existing catalog tag.
              Every recipe carrying it is repointed automatically — nothing is lost.
            </p>
            <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Merge into</label>
            <div className="relative mb-6">
              <input
                type="text"
                value={mergeQuery}
                onChange={e => { setMergeQuery(e.target.value); setMergeTargetId(''); }}
                placeholder="Search for a tag…"
                autoComplete="off"
                className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold"
              />
              {mergeQuery.trim() && !mergeTargetId && (
                <div className="absolute z-10 mt-2 w-full max-h-56 overflow-y-auto bg-white rounded-2xl shadow-lg border border-zinc-100">
                  {tags
                    .filter(t => t.id !== mergeSource.id)
                    .filter(t => (t.translated_name || t.name).toLowerCase().includes(mergeQuery.trim().toLowerCase()))
                    .slice(0, 30)
                    .map(t => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => { setMergeTargetId(t.id); setMergeQuery(t.translated_name || t.name); }}
                        className="w-full text-left px-5 py-3 text-sm font-bold text-zinc-700 hover:bg-zinc-50 first:rounded-t-2xl last:rounded-b-2xl"
                      >
                        {t.translated_name || t.name}
                      </button>
                    ))}
                  {tags.filter(t => t.id !== mergeSource.id).filter(t => (t.translated_name || t.name).toLowerCase().includes(mergeQuery.trim().toLowerCase())).length === 0 && (
                    <p className="px-5 py-3 text-sm text-zinc-400 italic">No matching tags.</p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setMergeSource(null)}
                className="flex-1 py-3 rounded-2xl bg-zinc-100 text-zinc-600 font-bold hover:bg-zinc-200 transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleMerge}
                disabled={!mergeTargetId || merging}
                className="flex-1 py-3 rounded-2xl bg-primary text-white font-bold hover:bg-primary/90 transition-all disabled:opacity-50"
              >
                {merging ? 'Merging…' : 'Merge'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Rename / Merge Group ──────────────────────────────────────── */}
      {mergingGroup && (
        <RenameGroupModal
          currentGroup={mergingGroup}
          existingGroups={Object.keys(groups).filter(g => g !== mergingGroup)}
          busy={mergingGroupBusy}
          onCancel={() => setMergingGroup(null)}
          onConfirm={handleMergeGroup}
        />
      )}

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
                  <p className="text-[10px] text-zinc-400 mt-1.5 px-1">Type a new name to create a new group, or pick an existing one from the suggestions.</p>
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

/** Renaming a group and merging it into another one are the same
 *  operation (a bulk group_name reassignment — see tags.local.ts's
 *  mergeTagGroups()), so this is one control: type a brand-new name to
 *  rename the group, or pick an existing other group from the suggestions
 *  to fold into it instead. */
function RenameGroupModal({
  currentGroup, existingGroups, busy, onCancel, onConfirm,
}: {
  currentGroup: string; existingGroups: string[]; busy: boolean;
  onCancel: () => void; onConfirm: (newName: string) => void;
}) {
  const [name, setName] = useState(currentGroup);
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white w-full max-w-md rounded-[32px] p-8 shadow-2xl">
        <h2 className="text-2xl font-black text-zinc-900 mb-2">Rename or Merge Group</h2>
        <p className="text-sm text-zinc-500 mb-6">
          Every tag currently under <strong className="text-zinc-700">{currentGroup}</strong> moves to whatever
          you type here. Type a brand-new name to rename the group, or pick an existing one from the
          suggestions to merge the two groups together.
        </p>
        <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Group name</label>
        <input
          type="text"
          list="rename-group-suggestions"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold mb-6"
        />
        <datalist id="rename-group-suggestions">
          {existingGroups.map(g => <option key={g} value={g} />)}
        </datalist>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-3 rounded-2xl bg-zinc-100 text-zinc-600 font-bold hover:bg-zinc-200 transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(name)}
            disabled={!name.trim() || busy}
            className="flex-1 py-3 rounded-2xl bg-primary text-white font-bold hover:bg-primary/90 transition-all disabled:opacity-50"
          >
            {busy ? 'Saving…' : existingGroups.includes(name.trim()) ? 'Merge' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}
