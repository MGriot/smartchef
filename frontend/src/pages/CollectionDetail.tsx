import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import CoverImage from '../components/CoverImage';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

interface CollectionRecipe {
  id: string;
  title: string;
  translated_title: string | null;
  cover_image_url: string | null;
  difficulty: string;
  prep_time_min: number | null;
  cook_time_min: number | null;
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
    if (!window.confirm('Delete this collection? Recipes themselves are not affected.')) return;
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
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : 'Export failed');
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
          <h3 className="text-2xl font-bold font-headline text-zinc-800 mb-2">Collection not found</h3>
          <Link to="/" className="text-primary font-bold">Back to Gallery</Link>
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
            <Link to="/" className="text-zinc-400 hover:text-primary text-sm font-bold flex items-center gap-1 mb-4">
              <span className="material-symbols-outlined text-[18px]">arrow_back</span> Gallery
            </Link>
            <h1 className="text-5xl font-extrabold tracking-tight font-headline text-on-surface mb-2">{collection.name}</h1>
            {collection.description && <p className="text-secondary text-lg max-w-xl">{collection.description}</p>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleExportCollection} title="Export Collection" className="w-11 h-11 rounded-full bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center text-zinc-500 transition-all">
              <span className="material-symbols-outlined text-[20px]">ios_share</span>
            </button>
            <button onClick={openEdit} className="w-11 h-11 rounded-full bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center text-zinc-500 transition-all">
              <span className="material-symbols-outlined text-[20px]">edit</span>
            </button>
            <button onClick={handleDeleteCollection} className="w-11 h-11 rounded-full bg-zinc-100 hover:bg-red-100 hover:text-red-500 flex items-center justify-center text-zinc-500 transition-all">
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>
        </div>

        {/* Add recipe */}
        <div className="bg-white rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] mb-10 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex-1">
            <Autocomplete
              value={addRecipeId}
              options={addableRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
              onSelect={(rid) => setAddRecipeId(rid)}
              onClear={() => setAddRecipeId('')}
              placeholder="Search a recipe to add…"
              className="w-full px-4 py-3 bg-zinc-50 rounded-xl border-none focus:ring-2 focus:ring-primary/20 text-sm font-medium"
            />
          </div>
          <button
            onClick={handleAddRecipe}
            disabled={!addRecipeId || adding}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-sm hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            Add to Collection
          </button>
        </div>

        {collection.recipes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-60 text-center">
            <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4">restaurant</span>
            <p className="text-zinc-500 text-sm">No recipes in this collection yet — add some above.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7">
            {collection.recipes.map(recipe => {
              const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0);
              return (
                <div key={recipe.id} className="group relative bg-white rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300">
                  <button
                    onClick={() => handleRemoveRecipe(recipe.id)}
                    title="Remove from collection"
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
                      <h3 className="text-xl font-bold font-headline text-zinc-900 mb-3 group-hover:text-primary transition-colors duration-200">
                        {recipe.translated_title || recipe.title}
                      </h3>
                      <div className="flex items-center gap-5 text-zinc-500 text-[13px] font-medium">
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>schedule</span>
                          {totalTime > 0 ? `${totalTime} min` : '—'}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>restaurant</span>
                          {recipe.difficulty}
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
      {editing && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setEditing(false)} />
          <div className="relative bg-white w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-3xl font-black text-zinc-900 mb-8">Edit Collection</h2>
            <form onSubmit={handleSaveEdit} className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Name</label>
                <input type="text" required value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
              </div>
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">Description</label>
                <textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} className="w-full h-24 px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium transition-all" />
              </div>
              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setEditing(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">Cancel</button>
                <button type="submit" className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
