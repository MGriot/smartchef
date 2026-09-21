import { formatDurationWith } from '../lib/duration';
import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import CoverImage from '../components/CoverImage';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { Field } from '../components/Form';

const DIFFICULTY_KEY: Record<string, string> = {
  easy: 'gallery.difficultyEasy', medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced', expert: 'gallery.difficultyExpert',
};

interface CollectionRecipe {
  id: string;
  title: string;
  translated_title: string | null;
  cover_image_url: string | null;
  difficulty: string;
  prep_time_min: number | null;
  cook_time_min: number | null;
  rest_time_min: number | null;
}

interface Collection {
  id: string;
  name: string;
  description: string | null;
  recipes: CollectionRecipe[];
}

interface RecipeOption {
  id: string;
  title: string;
  translated_title?: string | null;
}

export default function CollectionDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const contentLang = useStore((s) => s.contentLang);

  const [collection, setCollection] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [allRecipes, setAllRecipes] = useState<RecipeOption[]>([]);
  const [addRecipeId, setAddRecipeId] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchCollection = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/collections/${id}`);
      if (!res.ok) { setCollection(null); return; }
      const json = await res.json();
      setCollection(json.data);
    } catch (err) {
      console.error('Failed to fetch collection:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCollection(); }, [id]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes${contentLang ? `?lang=${contentLang}` : ''}`);
        const json = await res.json();
        setAllRecipes(json.data || []);
      } catch (err) {
        console.error('Failed to fetch recipes:', err);
      }
    })();
  }, [contentLang]);

  const openEdit = () => {
    if (!collection) return;
    setEditName(collection.name);
    setEditDescription(collection.description || '');
    setEditing(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch(`/api/collections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName, description: editDescription || undefined }),
    });
    setEditing(false);
    fetchCollection();
  };

  const handleDeleteCollection = async () => {
    if (!window.confirm(t('collections.confirmDelete'))) return;
    await apiFetch(`/api/collections/${id}`, { method: 'DELETE' });
    navigate('/');
  };

  const handleAddRecipe = async () => {
    if (!addRecipeId) return;
    setAdding(true);
    try {
      await apiFetch(`/api/collections/${id}/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: addRecipeId }),
      });
      setAddRecipeId('');
      fetchCollection();
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveRecipe = async (recipeId: string) => {
    await apiFetch(`/api/collections/${id}/recipes/${recipeId}`, { method: 'DELETE' });
    fetchCollection();
  };

  const handleExportCollection = async () => {
    if (!collection) return;
    try {
      const res = await apiFetch(`/api/share/collections/${id}/export`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : t('collections.exportFailed'));
      const slug = collection.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}.smartchef.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Collection export failed:', err);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex justify-center items-center h-80">
          <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary"></div>
        </div>
      </AppLayout>
    );
  }

  if (!collection) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-80 text-center">
          <h3 className="text-2xl font-bold font-headline text-zinc-800 dark:text-zinc-200 mb-2">{t('collections.notFound')}</h3>
          <Link to="/" className="text-primary font-bold">{t('collections.backToGallery')}</Link>
        </div>
      </AppLayout>
    );
  }

  const memberIds = new Set(collection.recipes.map(r => r.id));
  const addableRecipes = allRecipes.filter(r => !memberIds.has(r.id));

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-[1400px] mx-auto">
        <div className="flex justify-between items-start mb-10">
          <div>
            <Link to="/" className="text-zinc-400 dark:text-zinc-500 hover:text-primary text-sm font-bold flex items-center gap-1 mb-4">
              <span className="material-symbols-outlined text-[18px]">arrow_back</span> {t('collections.gallery')}
            </Link>
            <h1 className="text-5xl font-extrabold tracking-tight font-headline text-on-surface mb-2">{collection.name}</h1>
            {collection.description && <p className="text-secondary text-lg max-w-xl">{collection.description}</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleExportCollection} title={t('collections.export')} className="w-11 h-11 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-all">
              <span className="material-symbols-outlined text-[20px]">ios_share</span>
            </button>
            <button onClick={openEdit} title={t('collections.edit')} className="w-11 h-11 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-all">
              <span className="material-symbols-outlined text-[20px]">edit</span>
            </button>
            <button onClick={handleDeleteCollection} title={t('collections.deleteCollection')} className="w-11 h-11 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-red-100 hover:text-red-500 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-all">
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>
        </div>

        {/* Add recipe */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] mb-10 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex-1">
            <Autocomplete
              value={addRecipeId}
              options={addableRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
              onSelect={(rid) => setAddRecipeId(rid)}
              onClear={() => setAddRecipeId('')}
              placeholder={t('collections.searchToAdd')}
              className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-900 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-sm font-medium"
            />
          </div>
          <button
            onClick={handleAddRecipe}
            disabled={!addRecipeId || adding}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-sm hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            {t('collections.addToCollection')}
          </button>
        </div>

        {collection.recipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-60 text-center">
            <span className="material-symbols-outlined text-6xl text-zinc-300 dark:text-zinc-600 mb-4">restaurant</span>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm">{t('collections.empty')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7">
            {collection.recipes.map(recipe => {
              // Includes waiting time, same as the recipe's own page.
              const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0) + (recipe.rest_time_min || 0);
              return (
                <div key={recipe.id} className="group relative bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300">
                  <button
                    onClick={() => handleRemoveRecipe(recipe.id)}
                    title={t('collections.removeRecipe')}
                    className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-zinc-900/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                  >
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                  <Link to={`/recipe/${recipe.id}`} className="block">
                    <div className="aspect-[4/3] overflow-hidden">
                      <CoverImage
                        src={recipe.cover_image_url}
                        alt={recipe.title}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                        fallbackSrc="https://images.unsplash.com/photo-1495195129352-aec325a55b65?q=80&w=800"
                      />
                    </div>
                    <div className="p-6">
                      <h3 className="text-xl font-bold font-headline text-zinc-900 dark:text-zinc-100 mb-3 group-hover:text-primary transition-colors duration-200">
                        {recipe.translated_title || recipe.title}
                      </h3>
                      <div className="flex items-center gap-5 text-zinc-500 dark:text-zinc-400 text-[13px] font-medium">
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>schedule</span>
                          {formatDurationWith(t, totalTime, { short: true })}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
                          {DIFFICULTY_KEY[recipe.difficulty] ? t(DIFFICULTY_KEY[recipe.difficulty]) : recipe.difficulty}
                        </div>
                      </div>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit modal */}
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        onSubmit={handleSaveEdit}
        size="sm"
        title={t('collections.edit')}
        footer={
          <>
            <ModalCancelButton onClick={() => setEditing(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton>{t('common.save')}</ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('collections.name')}>
            <input
              type="text" required value={editName}
              onChange={e => setEditName(e.target.value)}
              className="sc-field"
            />
          </Field>
          <Field label={t('collections.descriptionLabel')}>
            <textarea
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              className="sc-field h-24 resize-none font-medium"
            />
          </Field>
        </div>
      </Modal>
    </AppLayout>
  );
}
