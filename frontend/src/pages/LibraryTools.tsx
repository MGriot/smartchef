import React, { useState, useEffect } from 'react';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import ImageUrlsEditor from '../components/ImageUrlsEditor';
import { ResolvedImage } from '../components/CoverImage';
import SynonymsEditor from '../components/SynonymsEditor';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { TOOL_ICONS } from '../lib/icons';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { AddLangButton, Field, FieldRow, FormSection, IconPicker, TranslationRows } from '../components/Form';


export default function LibraryTools() {
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTool, setEditingTool] = useState<any>(null);
  const [form, setForm] = useState({ name: '', category: '', description: '', icon: 'TbToolsKitchen', imageUrls: [] as string[], synonyms: [] as string[] });
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
              <h1 className="text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">Kitchen Tools</h1>
            </div>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
            >
              <span className="material-symbols-outlined">add</span>
              Add New Tool
            </button>
          </div>

          <section className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pl-4">Tool Details</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Category</th>
                    <th className="text-left py-4 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {loading ? (
                    <tr><td colSpan={3} className="py-20 text-center text-zinc-400 dark:text-zinc-500 font-medium">Loading items...</td></tr>
                  ) : tools.map((tool) => (
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
                          {tool.category || 'GENERAL'}
                        </span>
                      </td>
                      <td className="py-6 text-right pr-4">
                         <div className="flex justify-end gap-2">
                            <button onClick={() => handleOpenModal(tool)} className="w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-all">
                              <span className="material-symbols-outlined text-xl">edit</span>
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
          </section>
      </AppLayout>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={handleSave}
        size="md"
        title={editingTool ? 'Edit Tool' : 'New Culinary Tool'}
        subtitle={editingTool ? 'Changes apply everywhere this tool is used.' : 'Register a piece of equipment recipes can reference.'}
        footer={
          <>
            <ModalCancelButton onClick={() => setShowModal(false)}>Cancel</ModalCancelButton>
            <ModalSubmitButton>{editingTool ? 'Update Asset' : 'Register Asset'}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-8">
          <FormSection title="Identity">
            <FieldRow>
              <Field label="Tool Name">
                <input
                  type="text" required value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Mandoline Slicer"
                  className="sc-field"
                />
              </Field>
              <Field label="Category" hint="Free text — e.g. Prep, Baking, Cooking.">
                <input
                  type="text" value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. Prep"
                  className="sc-field"
                />
              </Field>
            </FieldRow>
            <Field label="Technical Specs / Description">
              <textarea
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Maintenance requirements, serial numbers..."
                className="sc-field h-24 resize-none font-medium"
              />
            </Field>
          </FormSection>

          <FormSection title="Appearance" description="The icon shows wherever the tool appears without a photo.">
            <Field label="Choose Icon">
              <IconPicker icons={TOOL_ICONS} value={form.icon} onChange={icon => setForm({ ...form, icon })} />
            </Field>
            <Field label="Reference Photos">
              <ImageUrlsEditor urls={form.imageUrls} onChange={urls => setForm({ ...form, imageUrls: urls })} />
            </Field>
          </FormSection>

          <FormSection
            title="Naming"
            description="Alternate names make the tool findable; translations give it a name per language."
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

          {editingTool && (
            <p className="sc-hint font-mono">ID {editingTool.id}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
