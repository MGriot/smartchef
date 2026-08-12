import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

/* ── Types ─────────────────────────────────────────────────── */
interface TagDisplay {
  name: string;
  translated_name: string;
  color: string | null;
}

interface Recipe {
  id: string;
  title: string;
  translated_title?: string | null;
  cover_image_url: string;
  prep_time_min: number;
  cook_time_min: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  tags: string[];
  tags_display?: TagDisplay[];
  is_component: boolean;
  rating: number | null;
  times_cooked: number;
}

interface CatalogTag {
  id: string;
  name: string;
  group_name: string;
  translated_name?: string | null;
  color?: string | null;
}

interface IngredientCategory {
  id: string;
  name: string;
  translated_name?: string | null;
  color?: string | null;
  icon?: string | null;
}

/* ── Gallery card badge: catalog tag (localized + colored) or Matrioska ── */
const getCardBadge = (recipe: Recipe): { label: string; bg?: string; text?: string; color?: string | null } | null => {
  if (recipe.is_component) {
    return { label: 'MATRIOSKA', bg: 'bg-orange-200/90', text: 'text-red-800' };
  }
  const first = recipe.tags_display?.[0];
  if (!first) return null;
  return { label: first.translated_name.toUpperCase(), color: first.color };
};

/* ── Difficulty label map (keys resolved via t() in the component) ── */
const difficultyKey: Record<string, string> = {
  easy: 'gallery.difficultyEasy',
  medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced',
  expert: 'gallery.difficultyExpert',
};

/* ── Collections ───────────────────────────────────────────── */
interface Collection {
  id: string;
  name: string;
  description: string | null;
  item_count: string | number;
  cover_images: (string | null)[];
}

/* ═══════════════════════════════════════════════════════════ */
/*  HOME – "Modern Culinary" Bento Gallery                   */
/* ═══════════════════════════════════════════════════════════ */
const Home: React.FC = () => {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [activeCategoryFilters, setActiveCategoryFilters] = useState<string[]>([]);
  const [catalogTags, setCatalogTags] = useState<CatalogTag[]>([]);
  const [ingredientCategories, setIngredientCategories] = useState<IngredientCategory[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const contentLang = useStore((s) => s.contentLang);

  useEffect(() => {
    const langQuery = contentLang ? `?lang=${contentLang}` : '';
    apiFetch(`/api/tags${langQuery}`)
      .then(res => res.json())
      .then(json => setCatalogTags(json.data || []))
      .catch(() => setCatalogTags([]));
    apiFetch(`/api/ingredients/categories${langQuery}`)
      .then(res => res.json())
      .then(json => setIngredientCategories(json.data || []))
      .catch(() => setIngredientCategories([]));
  }, [contentLang]);

  const toggleTagFilter = (name: string) => {
    setActiveTagFilters(f => f.includes(name) ? f.filter(x => x !== name) : [...f, name]);
  };
  const toggleCategoryFilter = (id: string) => {
    setActiveCategoryFilters(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id]);
  };
  const [sortBy, setSortBy] = useState<'recently-edited' | 'newest' | 'oldest' | 'alphabetical'>('recently-edited');
  const [gridCols, setGridCols] = useState<2 | 3 | 4>(() => {
    const stored = Number(localStorage.getItem('smartchef.galleryGridCols'));
    return stored === 2 || stored === 3 || stored === 4 ? stored : 3;
  });
  useEffect(() => {
    localStorage.setItem('smartchef.galleryGridCols', String(gridCols));
  }, [gridCols]);
  // Below the `sm` breakpoint the grid always stays single-column (cards
  // would get crushed otherwise) — gridCols only takes effect at/above it.
  const [isDesktopViewport, setIsDesktopViewport] = useState(() => window.matchMedia('(min-width: 640px)').matches);
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 640px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktopViewport(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  const clearAllFilters = () => {
    setActiveTagFilters([]);
    setActiveCategoryFilters([]);
    setSortBy('recently-edited');
  };
  const activeFilterCount = activeTagFilters.length + activeCategoryFilters.length + (sortBy !== 'recently-edited' ? 1 : 0);

  const tagGroups = catalogTags.reduce<Record<string, CatalogTag[]>>((acc, t) => {
    (acc[t.group_name] ||= []).push(t);
    return acc;
  }, {});

  const [activeTab, setActiveTab] = useState<'recipes' | 'collections'>('recipes');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loadingCollections, setLoadingCollections] = useState(true);
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionDescription, setNewCollectionDescription] = useState('');
  const [creatingCollection, setCreatingCollection] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  };

  const toggleSelected = (recipeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recipeId)) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
  };

  const handleExportSelected = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const res = await apiFetch('/api/share/recipes/export-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeIds: Array.from(selectedIds) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : 'Export failed');
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recipes-${selectedIds.size}.smartchef.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Bulk export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const fetchCollections = async () => {
    setLoadingCollections(true);
    try {
      const res = await apiFetch('/api/collections');
      const json = await res.json();
      setCollections(json.data || []);
    } catch (err) {
      console.error('Error fetching collections:', err);
    } finally {
      setLoadingCollections(false);
    }
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  const handleCreateCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingCollection(true);
    try {
      const res = await apiFetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCollectionName, description: newCollectionDescription || undefined }),
      });
      if (res.ok) {
        setShowCreateCollection(false);
        setNewCollectionName('');
        setNewCollectionDescription('');
        fetchCollections();
      }
    } catch (err) {
      console.error('Error creating collection:', err);
    } finally {
      setCreatingCollection(false);
    }
  };

  // Debounce the search box so it doesn't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (contentLang) params.set('lang', contentLang);
        if (debouncedQuery) params.set('q', debouncedQuery);
        if (activeTagFilters.length > 0) params.set('tags', activeTagFilters.join(','));
        if (activeCategoryFilters.length > 0) params.set('ingredientCategories', activeCategoryFilters.join(','));
        params.set('sort', sortBy);
        const res = await apiFetch(`/api/recipes?${params.toString()}`);
        const json = await res.json();
        setRecipes(json.data || []);
      } catch (err) {
        console.error('Error fetching recipes:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [contentLang, debouncedQuery, activeTagFilters, activeCategoryFilters, sortBy]);

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-[1400px] mx-auto">

          {/* Hero heading */}
          <div className="mb-10 animate-fade-in-up">
            <h1 className="text-5xl font-extrabold tracking-tight font-headline text-on-surface mb-2">
              {t('gallery.title')}
            </h1>
            <p className="text-secondary text-lg max-w-xl">
              {t('gallery.subtitle')}
            </p>
          </div>

          {/* Recipes / Collections tab switcher */}
          <div className="flex gap-2 mb-8 bg-zinc-100/70 p-1.5 rounded-full w-max">
            {(['recipes', 'collections'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-6 py-2 rounded-full font-bold text-sm capitalize transition-all ${
                  activeTab === tab ? 'bg-white text-primary shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {tab === 'recipes' ? t('gallery.tabRecipes') : t('gallery.tabCollections')}
              </button>
            ))}
          </div>

          {activeTab === 'collections' ? (
            <>
              <div className="flex justify-end mb-6">
                <button
                  onClick={() => setShowCreateCollection(true)}
                  className="flex items-center gap-2 px-6 py-3 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
                >
                  <span className="material-symbols-outlined">add</span>
                  {t('collections.newCollection')}
                </button>
              </div>

              {loadingCollections ? (
                <div className="flex justify-center items-center h-80">
                  <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary"></div>
                </div>
              ) : collections.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-80 text-center animate-fade-in">
                  <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4 scale-110">collections_bookmark</span>
                  <h3 className="text-2xl font-bold font-headline text-zinc-800 mb-2">{t('collections.noCollectionsYet')}</h3>
                  <p className="text-zinc-500 text-sm max-w-xs mb-8">{t('collections.noCollectionsDescription')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7 animate-fade-in-up">
                  {collections.map(col => {
                    const covers = (col.cover_images || []).filter(Boolean).slice(0, 4);
                    return (
                      <Link
                        key={col.id}
                        to={`/collection/${col.id}`}
                        className="group relative bg-white rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300 hover:translate-y-[-4px]"
                      >
                        <div className="aspect-[4/3] grid grid-cols-2 gap-0.5 bg-zinc-100">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className="overflow-hidden bg-zinc-100">
                              {covers[i] ? (
                                <img alt="" className="w-full h-full object-cover" src={covers[i]!} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-zinc-300">
                                  <span className="material-symbols-outlined text-2xl">restaurant</span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="p-6">
                          <h3 className="text-xl font-bold font-headline text-zinc-900 mb-1 group-hover:text-primary transition-colors duration-200">
                            {col.name}
                          </h3>
                          <p className="text-zinc-500 text-[13px] font-medium">{t('collections.recipeCount', { count: Number(col.item_count) })}</p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
          <>
          {/* Search & Filter */}
          <div className="flex flex-wrap gap-3 items-center mb-6">
            {/* Search — searches title, description, and ingredients */}
            <div className="relative flex-1 max-w-xl">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 text-[20px]">
                search
              </span>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3.5 bg-zinc-100/80 rounded-full border-none text-sm font-body placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-primary/25 focus:shadow-lg transition-all duration-200"
                placeholder={t('gallery.searchPlaceholder')}
                type="text"
              />
            </div>

            {/* Filters trigger */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowFilters(f => !f)}
                className={`flex items-center gap-2 px-5 py-3.5 rounded-full font-bold text-sm transition-all duration-200 ${
                  activeFilterCount > 0 ? 'bg-primary text-white shadow-sm' : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/60'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">tune</span>
                {t('gallery.filters')}
                {activeFilterCount > 0 && (
                  <span className="w-5 h-5 rounded-full bg-white/25 text-white text-[11px] font-black flex items-center justify-center">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {showFilters && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowFilters(false)} />
                  <div className="absolute right-0 top-14 z-50 w-[380px] max-h-[70vh] overflow-y-auto bg-white rounded-3xl shadow-2xl border border-zinc-100 p-6 space-y-5">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-black text-zinc-900">{t('gallery.filters')}</p>
                      {activeFilterCount > 0 && (
                        <button onClick={clearAllFilters} className="text-[11px] font-bold text-primary uppercase hover:underline">
                          {t('gallery.clearAll')}
                        </button>
                      )}
                    </div>

                    <div>
                      <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">{t('gallery.sortBy')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          { value: 'recently-edited', label: t('gallery.sortRecentlyEdited') },
                          { value: 'newest', label: t('gallery.sortNewest') },
                          { value: 'oldest', label: t('gallery.sortOldest') },
                          { value: 'alphabetical', label: t('gallery.sortAlphabetical') },
                        ] as const).map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setSortBy(opt.value)}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                              sortBy === opt.value ? 'bg-zinc-900 text-white border-transparent' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {Object.entries(tagGroups).map(([group, tags]) => (
                      <div key={group}>
                        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">{group}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {tags.map(t => {
                            const active = activeTagFilters.includes(t.name);
                            return (
                              <button
                                key={t.id}
                                onClick={() => toggleTagFilter(t.name)}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                                  active ? 'text-white border-transparent' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'
                                }`}
                                style={active ? { backgroundColor: t.color || '#3f3f46' } : undefined}
                              >
                                {t.translated_name || t.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    <div>
                      <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-2">{t('gallery.ingredientCategory')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {ingredientCategories.map(c => {
                          const active = activeCategoryFilters.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              onClick={() => toggleCategoryFilter(c.id)}
                              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                                active ? 'text-white border-transparent' : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-300'
                              }`}
                              style={active ? { backgroundColor: c.color || '#3f3f46' } : undefined}
                            >
                              {c.translated_name || c.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Bulk select toggle */}
            <button
              onClick={toggleSelectMode}
              className={`flex items-center gap-2 px-5 py-3.5 rounded-full font-bold text-sm transition-all duration-200 shrink-0 ${
                selectMode ? 'bg-primary text-white shadow-sm' : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/60'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">checklist</span>
              {t('gallery.select')}
            </button>

            {/* Grid density */}
            <div className="flex items-center gap-0.5 bg-zinc-100/80 rounded-full p-1 shrink-0">
              {([2, 3, 4] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setGridCols(n)}
                  title={`${n} columns`}
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-black text-xs transition-all duration-200 ${
                    gridCols === n ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {selectMode && (
            <div className="flex items-center justify-between mb-6 px-6 py-3.5 bg-zinc-900 text-white rounded-2xl">
              <p className="text-sm font-bold">{t('gallery.selectedCount', { count: selectedIds.size })}</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleExportSelected}
                  disabled={selectedIds.size === 0 || exporting}
                  className="flex items-center gap-1.5 px-4 py-2 bg-white text-zinc-900 rounded-full font-bold text-xs disabled:opacity-40 transition-all"
                >
                  <span className="material-symbols-outlined text-[16px]">{exporting ? 'sync' : 'ios_share'}</span>
                  {exporting ? t('gallery.exporting') : t('gallery.exportSelected')}
                </button>
                <button onClick={toggleSelectMode} className="text-white/70 hover:text-white text-xs font-bold">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* ─── Recipe Grid (Bento-style) ──────────────────────── */}
          {loading ? (
            <div className="flex justify-center items-center h-80">
              <div className="flex flex-col items-center gap-4">
                <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary"></div>
                <p className="text-sm text-zinc-400 font-medium">{t('gallery.loadingRecipes')}</p>
              </div>
            </div>
          ) : recipes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-80 text-center animate-fade-in">
              <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4 scale-110">
                {debouncedQuery || activeFilterCount > 0 ? 'search_off' : 'menu_book'}
              </span>
              <h3 className="text-2xl font-bold font-headline text-zinc-800 mb-2">
                {debouncedQuery || activeFilterCount > 0 ? t('gallery.noMatchingRecipes') : t('gallery.noRecipesYet')}
              </h3>
              <p className="text-zinc-500 text-sm max-w-xs mb-8">
                {debouncedQuery || activeFilterCount > 0
                  ? t('gallery.tryDifferentSearch')
                  : t('gallery.startJourney')}
              </p>
              <Link
                to="/recipe/new"
                className="flex items-center gap-2 px-8 py-3.5 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined">add</span>
                {t('gallery.createFirstRecipe')}
              </Link>
            </div>
          ) : (
            <div
              className="grid grid-cols-1 gap-7 animate-fade-in-up"
              style={isDesktopViewport ? { animationDelay: '0.1s', gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` } : { animationDelay: '0.1s' }}
            >
              {recipes.map((recipe) => {
                const badge = getCardBadge(recipe);
                const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0);

                const selected = selectedIds.has(recipe.id);

                return (
                  <Link
                    key={recipe.id}
                    to={`/recipe/${recipe.id}`}
                    onClick={(e) => {
                      if (selectMode) {
                        e.preventDefault();
                        toggleSelected(recipe.id);
                      }
                    }}
                    className={`group relative bg-white rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300 hover:translate-y-[-4px] ${selected ? 'ring-4 ring-primary' : ''}`}
                  >
                    {selectMode && (
                      <div className="absolute top-4 right-4 z-10 w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center">
                        {selected && <span className="material-symbols-outlined text-primary text-[20px]">check_circle</span>}
                        {!selected && <span className="w-4 h-4 rounded-full border-2 border-zinc-300"></span>}
                      </div>
                    )}
                    {/* Image */}
                    <div className="aspect-[4/3] overflow-hidden relative">
                      <img
                        alt={recipe.title}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                        src={recipe.cover_image_url || 'https://images.unsplash.com/photo-1495195129352-aec325a55b65?q=80&w=800'}
                      />
                      {/* Shimmer overlay on hover */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                      {/* Tag/Matrioska badge */}
                      {badge && (
                        <div className="absolute top-4 left-4">
                          <span
                            className={`inline-flex items-center gap-1 px-3 py-1 ${badge.bg || ''} ${badge.text || 'text-white'} text-[10px] font-extrabold uppercase tracking-[0.12em] rounded-full shadow-sm backdrop-blur-sm`}
                            style={!badge.bg ? { backgroundColor: badge.color || '#3f3f46' } : undefined}
                          >
                            {badge.label}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="p-6">
                      <h3 className="text-xl font-bold font-headline text-zinc-900 mb-3 group-hover:text-primary transition-colors duration-200">
                        {recipe.translated_title || recipe.title}
                      </h3>
                      <div className="flex items-center gap-5 text-zinc-500 text-[13px] font-medium">
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                            schedule
                          </span>
                          {totalTime > 0 ? `${totalTime} min` : '—'}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                            restaurant
                          </span>
                          {difficultyKey[recipe.difficulty] ? t(difficultyKey[recipe.difficulty]) : recipe.difficulty}
                        </div>
                        {(recipe.times_cooked > 0 || (recipe.rating !== null && recipe.rating !== undefined)) && (
                          <div className="flex items-center gap-3 ml-auto">
                            {recipe.times_cooked > 0 && (
                              <div className="flex items-center gap-1" title={t('gallery.cookedTimes', { count: recipe.times_cooked })}>
                                <span className="material-symbols-outlined text-primary/60 text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                                  skillet
                                </span>
                                {recipe.times_cooked}
                              </div>
                            )}
                            {recipe.rating !== null && recipe.rating !== undefined && (
                              <div className="flex items-center gap-1">
                                <span className="material-symbols-outlined text-amber-400 text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                                  star
                                </span>
                                {recipe.rating}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
          </>
          )}
      </div>

      {/* ─── New Collection Modal ─────────────────────────────── */}
      {showCreateCollection && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm" onClick={() => setShowCreateCollection(false)} />
          <div className="relative bg-white w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-3xl font-black text-zinc-900 mb-8">{t('collections.newCollection')}</h2>
            <form onSubmit={handleCreateCollection} className="space-y-6">
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">{t('collections.name')}</label>
                <input type="text" required value={newCollectionName} onChange={e => setNewCollectionName(e.target.value)} placeholder={t('collections.namePlaceholder')} className="w-full px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-bold transition-all" />
              </div>
              <div>
                <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2 px-1">{t('collections.description')}</label>
                <textarea value={newCollectionDescription} onChange={e => setNewCollectionDescription(e.target.value)} className="w-full h-24 px-6 py-4 bg-zinc-50 rounded-2xl border-none focus:ring-2 focus:ring-primary/20 text-zinc-900 font-medium transition-all" />
              </div>
              <div className="flex gap-4 pt-4">
                <button type="button" onClick={() => setShowCreateCollection(false)} className="flex-1 py-4 bg-zinc-100 text-zinc-600 rounded-2xl font-black hover:bg-zinc-200 transition-all">{t('common.cancel')}</button>
                <button type="submit" disabled={creatingCollection} className="flex-[2] py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50">
                  {creatingCollection ? t('collections.creating') : t('collections.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Mobile Bottom Nav ──────────────────────────────── */}
      <footer className="md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-[#fafaf5]/90 backdrop-blur-xl rounded-t-3xl border-t border-outline-variant/15 shadow-[0_-4px_20px_rgba(0,0,0,0.04)]">
        <Link className="flex flex-col items-center justify-center text-primary" to="/">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>home</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.home')}</span>
        </Link>
        <Link className="flex flex-col items-center justify-center text-zinc-400 hover:text-primary transition-colors" to="#">
          <span className="material-symbols-outlined">search</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.search')}</span>
        </Link>
        <Link className="flex flex-col items-center justify-center text-zinc-400 hover:text-primary transition-colors" to="/planner">
          <span className="material-symbols-outlined">calendar_month</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.planner')}</span>
        </Link>
      </footer>
    </AppLayout>
  );
};

export default Home;