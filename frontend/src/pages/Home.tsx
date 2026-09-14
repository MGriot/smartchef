import React, { useState, useEffect, useRef } from 'react';
import { getSyncStatus, subscribeSyncStatus, hasEverCompletedSync } from '../lib/sync/syncStatus';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import RegionPicker from '../components/RegionPicker';
import CoverImage from '../components/CoverImage';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import Modal, { ModalCancelButton, ModalSubmitButton } from '../components/Modal';
import { Field } from '../components/Form';

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
  description?: string | null;
  translated_description?: string | null;
  cover_image_url: string;
  prep_time_min: number;
  cook_time_min: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  tags: string[];
  tags_display?: TagDisplay[];
  is_component: boolean;
  rating: number | null;
  times_cooked: number;
  creator_name?: string | null;
  creator_avatar_url?: string | null;
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

/* ── Gallery grid density ──────────────────────────────────────────────
   Only applies at/above the `sm` breakpoint; below it the grid is always a
   single column regardless (see isDesktopViewport). */
export const GRID_COL_CHOICES = [2, 3, 4, 5, 6, 7] as const;
export type GridCols = typeof GRID_COL_CHOICES[number];

/* ── Gallery card badges: Matrioska + up to 3 catalog tags (localized + colored), "+N" overflow ── */
type CardBadge = { label: string; bg?: string; text?: string; color?: string | null };
const MAX_CARD_TAG_BADGES = 3;
const getCardBadges = (recipe: Recipe): CardBadge[] => {
  const badges: CardBadge[] = [];
  if (recipe.is_component) {
    badges.push({ label: 'MATRIOSKA', bg: 'bg-orange-200/90', text: 'text-red-800' });
  }
  const tagsDisplay = recipe.tags_display;
  if (tagsDisplay && tagsDisplay.length > 0) {
    for (const tag of tagsDisplay.slice(0, MAX_CARD_TAG_BADGES)) {
      badges.push({ label: tag.translated_name.toUpperCase(), color: tag.color });
    }
    if (tagsDisplay.length > MAX_CARD_TAG_BADGES) {
      badges.push({ label: `+${tagsDisplay.length - MAX_CARD_TAG_BADGES}`, bg: 'bg-zinc-700/90', text: 'text-white' });
    }
  } else if (!recipe.is_component && recipe.tags?.[0]) {
    // Legacy free-text tag with no catalog match — still show something rather than nothing.
    badges.push({ label: recipe.tags[0].toUpperCase(), bg: 'bg-zinc-700/90', text: 'text-white' });
  }
  return badges;
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>([]);
  const [activeCategoryFilters, setActiveCategoryFilters] = useState<string[]>([]);
  const [activeRegionFilters, setActiveRegionFilters] = useState<string[]>([]);
  const [seasonalOnly, setSeasonalOnly] = useState(false);
  const [catalogTags, setCatalogTags] = useState<CatalogTag[]>([]);
  const [ingredientCategories, setIngredientCategories] = useState<IngredientCategory[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  // Seeded from a `?q=` URL param (e.g. a "used in recipes" link from an
  // ingredient) so the initial fetch doesn't wait on the debounce below.
  const initialQuery = new URLSearchParams(window.location.search).get('q') || '';
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const contentLang = useStore((s) => s.contentLang);

  // First-run setup now lets someone in as soon as their profile is known
  // (lib/sync/firstRunProbe.ts), so on a new device the library is still
  // downloading while this screen is already up. Without this the gallery
  // would sit empty and silent, then stay stale once the recipes landed.
  const [syncStatus, setSyncStatus] = useState(() => getSyncStatus());
  // null until known. Deliberately not seeded from `running`: App.tsx starts
  // the first sync AFTER first paint, so at mount nothing is running yet on
  // exactly the device this banner is for, and seeding from it would mean
  // the banner never appeared at all.
  const [everSynced, setEverSynced] = useState<boolean | null>(null);
  useEffect(() => {
    void hasEverCompletedSync().then(setEverSynced);
    return subscribeSyncStatus((next) => {
      setSyncStatus(next);
      // A completed cycle retires the banner for good on this device.
      if (!next.running) setEverSynced(true);
    });
  }, []);
  const stillFillingIn = syncStatus.running && everSynced === false;

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
  // 2-7. Past four columns the cards get narrow enough that the card's own
  // padding and type have to come down with them, or the title wraps to four
  // lines and the meta row overflows — see `dense` below.
  const [gridCols, setGridCols] = useState<GridCols>(() => {
    const stored = Number(localStorage.getItem('smartchef.galleryGridCols'));
    return (GRID_COL_CHOICES as readonly number[]).includes(stored) ? stored as GridCols : 3;
  });
  // Cards at 5+ columns are roughly half the width they are at 3, so they
  // drop to the compact treatment rather than keeping desktop padding.
  const dense = gridCols >= 5;
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
    setActiveRegionFilters([]);
    setSeasonalOnly(false);
    setSortBy('recently-edited');
  };
  const activeFilterCount = activeTagFilters.length + activeCategoryFilters.length + activeRegionFilters.length + (seasonalOnly ? 1 : 0) + (sortBy !== 'recently-edited' ? 1 : 0);

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
    // appliedRevision only moves when a sync wrote something, so this is a
    // refetch on real change rather than on every tick.
  }, [syncStatus.appliedRevision]);

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
        if (activeRegionFilters.length > 0) params.set('regions', activeRegionFilters.join(','));
        if (seasonalOnly) params.set('seasonalOnly', 'true');
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
  }, [contentLang, debouncedQuery, activeTagFilters, activeCategoryFilters, activeRegionFilters, seasonalOnly, sortBy, syncStatus.appliedRevision]);

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-[1400px] mx-auto">

          {stillFillingIn && (
            <div className="mb-6 flex items-center gap-3 rounded-2xl bg-primary/5 border border-primary/20 px-4 py-3">
              <span className="material-symbols-outlined text-primary animate-spin text-[20px]">progress_activity</span>
              <div>
                <p className="text-sm font-bold text-on-surface">Still downloading your library</p>
                <p className="text-xs text-secondary">
                  {recipes.length > 0
                    ? 'More recipes will appear here as they arrive.'
                    : 'Your recipes will appear here as they arrive — you can keep using the app meanwhile.'}
                </p>
              </div>
            </div>
          )}

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
          <div className="flex gap-2 mb-8 bg-zinc-100/70 dark:bg-zinc-800/70 p-1.5 rounded-full w-max">
            {(['recipes', 'collections'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-6 py-2 rounded-full font-bold text-sm capitalize transition-all ${
                  activeTab === tab ? 'bg-white dark:bg-zinc-900 text-primary shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
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
                  <span className="material-symbols-outlined text-6xl text-zinc-300 dark:text-zinc-600 mb-4 scale-110">collections_bookmark</span>
                  <h3 className="text-2xl font-bold font-headline text-zinc-800 dark:text-zinc-200 mb-2">{t('collections.noCollectionsYet')}</h3>
                  <p className="text-zinc-500 dark:text-zinc-400 text-sm max-w-xs mb-8">{t('collections.noCollectionsDescription')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7 animate-fade-in-up">
                  {collections.map(col => {
                    const covers = (col.cover_images || []).filter(Boolean).slice(0, 4);
                    return (
                      <Link
                        key={col.id}
                        to={`/collection/${col.id}`}
                        className="group relative bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300 hover:translate-y-[-4px]"
                      >
                        <div className="aspect-[4/3] grid grid-cols-2 gap-0.5 bg-zinc-100 dark:bg-zinc-800">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className="overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                              <CoverImage
                                src={covers[i]}
                                alt=""
                                iconSize={24}
                                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                              />
                            </div>
                          ))}
                        </div>
                        <div className="p-6">
                          <h3 className="text-xl font-bold font-headline text-zinc-900 dark:text-zinc-100 mb-1 group-hover:text-primary transition-colors duration-200">
                            {col.name}
                          </h3>
                          <p className="text-zinc-500 dark:text-zinc-400 text-[13px] font-medium">{t('collections.recipeCount', { count: Number(col.item_count) })}</p>
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
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 text-[20px]">
                search
              </span>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3.5 bg-zinc-100/80 dark:bg-zinc-800/80 rounded-full border-none text-sm font-body placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:ring-2 focus:ring-primary/25 focus:shadow-lg transition-all duration-200"
                placeholder={t('gallery.searchPlaceholder')}
                type="text"
              />
            </div>

            {/* Filters trigger */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowFilters(f => !f)}
                className={`flex items-center gap-2 px-5 py-3.5 rounded-full font-bold text-sm transition-all duration-200 ${
                  activeFilterCount > 0 ? 'bg-primary text-white shadow-sm' : 'bg-zinc-100/80 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60'
                }`}
              >
                <span className="material-symbols-outlined text-[20px]">tune</span>
                {t('gallery.filters')}
                {activeFilterCount > 0 && (
                  <span className="w-5 h-5 rounded-full bg-white/25 dark:bg-zinc-900/25 text-white text-[11px] font-black flex items-center justify-center">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {showFilters && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowFilters(false)} />
                  <div className="absolute right-0 top-14 z-50 w-[380px] max-h-[70vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-100 dark:border-zinc-800 p-6 space-y-5">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">{t('gallery.filters')}</p>
                      {activeFilterCount > 0 && (
                        <button onClick={clearAllFilters} className="text-[11px] font-bold text-primary uppercase hover:underline">
                          {t('gallery.clearAll')}
                        </button>
                      )}
                    </div>

                    <div>
                      <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('gallery.sortBy')}</p>
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
                              sortBy === opt.value ? 'bg-zinc-900 text-white border-transparent' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {Object.entries(tagGroups).map(([group, tags]) => (
                      <div key={group}>
                        <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{group || t('tagGroups.ungrouped')}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {tags.map(t => {
                            const active = activeTagFilters.includes(t.name);
                            return (
                              <button
                                key={t.id}
                                onClick={() => toggleTagFilter(t.name)}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                                  active ? 'text-white border-transparent' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
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
                      <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('gallery.ingredientCategory')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {ingredientCategories.map(c => {
                          const active = activeCategoryFilters.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              onClick={() => toggleCategoryFilter(c.id)}
                              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                                active ? 'text-white border-transparent' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                              }`}
                              style={active ? { backgroundColor: c.color || '#3f3f46' } : undefined}
                            >
                              {c.translated_name || c.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('recipeDetail.regions')}</p>
                      <RegionPicker value={activeRegionFilters} onChange={setActiveRegionFilters} />
                    </div>

                    <div>
                      <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">{t('nav.seasonality')}</p>
                      <button
                        onClick={() => setSeasonalOnly(v => !v)}
                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-xs font-bold border transition-all ${
                          seasonalOnly ? 'bg-primary text-white border-transparent' : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                        }`}
                      >
                        {t('gallery.seasonalOnly')}
                        <span className="material-symbols-outlined text-lg">{seasonalOnly ? 'check_circle' : 'radio_button_unchecked'}</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Bulk select toggle */}
            <button
              onClick={toggleSelectMode}
              className={`flex items-center gap-2 px-5 py-3.5 rounded-full font-bold text-sm transition-all duration-200 shrink-0 ${
                selectMode ? 'bg-primary text-white shadow-sm' : 'bg-zinc-100/80 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60'
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">checklist</span>
              {t('gallery.select')}
            </button>

            {/* Grid density */}
            <div className="flex items-center gap-0.5 bg-zinc-100/80 dark:bg-zinc-800/80 rounded-full p-1 shrink-0">
              {GRID_COL_CHOICES.map((n) => (
                <button
                  key={n}
                  onClick={() => setGridCols(n)}
                  title={`${n} columns`}
                  className={`w-7 h-7 rounded-full flex items-center justify-center font-black text-xs transition-all duration-200 ${
                    gridCols === n ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'
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
                  className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-full font-bold text-xs disabled:opacity-40 transition-all"
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
                <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('gallery.loadingRecipes')}</p>
              </div>
            </div>
          ) : recipes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-80 text-center animate-fade-in">
              <span className="material-symbols-outlined text-6xl text-zinc-300 dark:text-zinc-600 mb-4 scale-110">
                {debouncedQuery || activeFilterCount > 0 ? 'search_off' : 'menu_book'}
              </span>
              <h3 className="text-2xl font-bold font-headline text-zinc-800 dark:text-zinc-200 mb-2">
                {debouncedQuery || activeFilterCount > 0 ? t('gallery.noMatchingRecipes') : t('gallery.noRecipesYet')}
              </h3>
              <p className="text-zinc-500 dark:text-zinc-400 text-sm max-w-xs mb-8">
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
              className={`grid grid-cols-1 animate-fade-in-up ${dense ? 'gap-4' : 'gap-7'}`}
              style={isDesktopViewport ? { animationDelay: '0.1s', gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` } : { animationDelay: '0.1s' }}
            >
              {recipes.map((recipe) => {
                const badges = getCardBadges(recipe);
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
                    className={`group relative bg-white dark:bg-zinc-900 rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300 hover:translate-y-[-4px] ${selected ? 'ring-4 ring-primary' : ''}`}
                  >
                    {selectMode && (
                      <div className="absolute top-4 right-4 z-10 w-7 h-7 rounded-full bg-white dark:bg-zinc-900 shadow-md flex items-center justify-center">
                        {selected && <span className="material-symbols-outlined text-primary text-[20px]">check_circle</span>}
                        {!selected && <span className="w-4 h-4 rounded-full border-2 border-zinc-300 dark:border-zinc-600"></span>}
                      </div>
                    )}
                    {/* Image */}
                    <div className="aspect-[4/3] overflow-hidden relative">
                      <CoverImage
                        src={recipe.cover_image_url}
                        alt={recipe.title}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                      {/* Shimmer overlay on hover */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                      {/* Tag/Matrioska badges */}
                      {badges.length > 0 && (
                        <div className="absolute top-4 left-4 right-4 flex flex-wrap gap-1.5">
                          {badges.map((badge, i) => (
                            <span
                              key={i}
                              // No backdrop-blur here on purpose. Every badge
                              // sits on its own opaque colored pill, so the
                              // blur was invisible — but each one still forced
                              // its own compositing surface and a readback of
                              // the photo behind it. A gallery of 47 recipes
                              // carries ~150 of these, which is a real cost on
                              // a phone GPU and free on a desktop one.
                              className={`inline-flex items-center gap-1 px-3 py-1 ${badge.bg || ''} ${badge.text || 'text-white'} text-[10px] font-extrabold uppercase tracking-[0.12em] rounded-full shadow-sm`}
                              style={!badge.bg ? { backgroundColor: badge.color || '#3f3f46' } : undefined}
                            >
                              {badge.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className={dense ? 'p-4' : 'p-6'}>
                      <h3 className={`font-bold font-headline text-zinc-900 dark:text-zinc-100 mb-1 group-hover:text-primary transition-colors duration-200 ${dense ? 'text-sm leading-snug line-clamp-2' : 'text-xl'}`}>
                        {recipe.translated_title || recipe.title}
                      </h3>
                      {!dense && (recipe.translated_description || recipe.description) && (
                        <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-2 line-clamp-2">
                          {recipe.translated_description || recipe.description}
                        </p>
                      )}
                      {recipe.creator_name && (
                        <p className={`text-zinc-400 dark:text-zinc-500 font-medium ${dense ? 'text-[10px] mb-2 truncate' : 'text-xs mb-3'}`}>by {recipe.creator_name}</p>
                      )}
                      <div className={`flex items-center text-zinc-500 dark:text-zinc-400 font-medium flex-wrap ${dense ? 'gap-x-2 gap-y-0.5 text-[11px]' : 'gap-x-5 gap-y-1 text-[13px]'}`}>
                        <div className="flex items-center gap-1.5">
                          <span className={`material-symbols-outlined text-primary ${dense ? 'text-[14px]' : 'text-[18px]'}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                            schedule
                          </span>
                          {totalTime > 0 ? `${totalTime} min` : '—'}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`material-symbols-outlined text-primary ${dense ? 'text-[14px]' : 'text-[18px]'}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                            restaurant
                          </span>
                          <span className={dense ? 'truncate max-w-[3.5rem]' : ''}>{difficultyKey[recipe.difficulty] ? t(difficultyKey[recipe.difficulty]) : recipe.difficulty}</span>
                        </div>
                        {(recipe.times_cooked > 0 || (recipe.rating !== null && recipe.rating !== undefined)) && (
                          <div className={`flex items-center ${dense ? 'gap-2' : 'gap-3 ml-auto'}`}>
                            {recipe.times_cooked > 0 && (
                              <div className="flex items-center gap-1" title={t('gallery.cookedTimes', { count: recipe.times_cooked })}>
                                <span className={`material-symbols-outlined text-primary/60 ${dense ? 'text-[14px]' : 'text-[18px]'}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                                  skillet
                                </span>
                                {recipe.times_cooked}
                              </div>
                            )}
                            {recipe.rating !== null && recipe.rating !== undefined && (
                              <div className="flex items-center gap-1">
                                <span className={`material-symbols-outlined text-amber-400 ${dense ? 'text-[14px]' : 'text-[18px]'}`} style={{ fontVariationSettings: "'FILL' 1" }}>
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

      {/* ─── New Collection Modal ───────────────────────────── */}
      <Modal
        open={showCreateCollection}
        onClose={() => setShowCreateCollection(false)}
        onSubmit={handleCreateCollection}
        size="sm"
        title={t('collections.newCollection')}
        footer={
          <>
            <ModalCancelButton onClick={() => setShowCreateCollection(false)}>{t('common.cancel')}</ModalCancelButton>
            <ModalSubmitButton disabled={creatingCollection}>
              {creatingCollection ? t('collections.creating') : t('collections.create')}
            </ModalSubmitButton>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('collections.name')}>
            <input
              type="text" required value={newCollectionName}
              onChange={e => setNewCollectionName(e.target.value)}
              placeholder={t('collections.namePlaceholder')}
              className="sc-field"
            />
          </Field>
          <Field label={t('collections.description')}>
            <textarea
              value={newCollectionDescription}
              onChange={e => setNewCollectionDescription(e.target.value)}
              className="sc-field h-24 resize-none font-medium"
            />
          </Field>
        </div>
      </Modal>

      {/* ─── Mobile Bottom Nav ──────────────────────────────── */}
      {/* Opaque rather than translucent-and-blurred. This bar is `md:hidden`,
          so it only ever renders on a phone — and a full-width backdrop-filter
          pinned to the viewport has to re-blur whatever scrolled underneath it
          on every single frame, which is the most expensive thing on the
          gallery's scroll path and something the desktop build never pays at
          all. Solid at the same colors reads nearly identically and costs
          nothing. */}
      <footer className="md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-[#fafaf5] dark:bg-zinc-950 rounded-t-3xl border-t border-outline-variant/15 shadow-[0_-4px_20px_rgba(0,0,0,0.04)]">
        <Link className="flex flex-col items-center justify-center text-primary" to="/">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>home</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.home')}</span>
        </Link>
        <button
          type="button"
          className="flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-colors"
          onClick={() => {
            setActiveTab('recipes');
            setTimeout(() => {
              searchInputRef.current?.focus();
              searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 0);
          }}
        >
          <span className="material-symbols-outlined">search</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.search')}</span>
        </button>
        <Link className="flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 hover:text-primary transition-colors" to="/planner">
          <span className="material-symbols-outlined">calendar_month</span>
          <span className="text-[11px] font-bold mt-0.5">{t('bottomNav.planner')}</span>
        </Link>
      </footer>
    </AppLayout>
  );
};

export default Home;