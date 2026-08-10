import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';

/* ── Types ─────────────────────────────────────────────────── */
interface Recipe {
  id: string;
  title: string;
  translated_title?: string | null;
  cover_image_url: string;
  prep_time_min: number;
  cook_time_min: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  tags: string[];
  is_component: boolean;
}

/* ── Smart-tag color helper ───────────────────────────────── */
const getSmartTagStyle = (recipe: Recipe): { label: string; bg: string; text: string } | null => {
  if (recipe.is_component) {
    return { label: 'MATRIOSKA', bg: 'bg-orange-200/90', text: 'text-red-800' };
  }
  const first = recipe.tags?.[0]?.toLowerCase();
  if (!first) return null;
  if (first.includes('sauce') || first.includes('base'))
    return { label: 'SAUCE PREP', bg: 'bg-amber-200/90', text: 'text-amber-900' };
  if (first.includes('dessert') || first.includes('dolce'))
    return { label: 'DESSERT', bg: 'bg-pink-200/90', text: 'text-pink-900' };
  if (first.includes('pasta') || first.includes('primo'))
    return { label: 'PRIMO', bg: 'bg-sky-200/90', text: 'text-sky-900' };
  return { label: first.toUpperCase(), bg: 'bg-zinc-200/90', text: 'text-zinc-800' };
};

/* ── Difficulty label map ─────────────────────────────────── */
const difficultyLabel: Record<string, string> = {
  easy: 'Easy',
  medium: 'Intermediate',
  hard: 'Advanced',
  expert: 'Expert',
};

/* ── Filter chips ─────────────────────────────────────────── */
const filterChips = ['All', 'Breakfast', 'Lunch', 'Dinner', 'Dessert'];

/* ═══════════════════════════════════════════════════════════ */
/*  HOME – "Modern Culinary" Bento Gallery                   */
/* ═══════════════════════════════════════════════════════════ */
const Home: React.FC = () => {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const contentLang = useStore((s) => s.contentLang);

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
        if (activeFilter !== 'All') params.set('tag', activeFilter.toLowerCase());
        const res = await fetch(`/api/recipes?${params.toString()}`);
        const json = await res.json();
        setRecipes(json.data || []);
      } catch (err) {
        console.error('Error fetching recipes:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [contentLang, debouncedQuery, activeFilter]);

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-[1400px] mx-auto">

          {/* Hero heading */}
          <div className="mb-10 animate-fade-in-up">
            <h1 className="text-5xl font-extrabold tracking-tight font-headline text-on-surface mb-2">
              Recipe Gallery
            </h1>
            <p className="text-secondary text-lg max-w-xl">
              Curate your digital kitchen with professional-grade inspirations.
            </p>
          </div>

          {/* Search & Filter */}
          <div className="flex flex-col md:flex-row gap-5 items-start md:items-center justify-between mb-10">
            {/* Search */}
            <div className="relative w-full md:w-96">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 text-[20px]">
                search
              </span>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-3.5 bg-zinc-100/80 rounded-full border-none text-sm font-body placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-primary/25 focus:shadow-lg transition-all duration-200"
                placeholder="Search your atelier..."
                type="text"
              />
            </div>

            {/* Filter chips */}
            <div className="flex gap-2.5 overflow-x-auto scrollbar-hide pb-1">
              {filterChips.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveFilter(cat)}
                  className={`px-5 py-2 rounded-full font-bold text-sm whitespace-nowrap transition-all duration-200 ${
                    activeFilter === cat
                      ? 'bg-primary text-white shadow-sm'
                      : 'bg-zinc-200/60 text-zinc-600 hover:bg-zinc-300/60'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* ─── Recipe Grid (Bento-style) ──────────────────────── */}
          {loading ? (
            <div className="flex justify-center items-center h-80">
              <div className="flex flex-col items-center gap-4">
                <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary"></div>
                <p className="text-sm text-zinc-400 font-medium">Loading recipes…</p>
              </div>
            </div>
          ) : recipes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-80 text-center animate-fade-in">
              <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4 scale-110">
                {debouncedQuery || activeFilter !== 'All' ? 'search_off' : 'menu_book'}
              </span>
              <h3 className="text-2xl font-bold font-headline text-zinc-800 mb-2">
                {debouncedQuery || activeFilter !== 'All' ? 'No matching recipes' : 'No recipes yet'}
              </h3>
              <p className="text-zinc-500 text-sm max-w-xs mb-8">
                {debouncedQuery || activeFilter !== 'All'
                  ? 'Try a different search term or filter.'
                  : 'Start your culinary journey by creating your first masterpiece in the atelier.'}
              </p>
              <Link
                to="/recipe/new"
                className="flex items-center gap-2 px-8 py-3.5 bg-primary text-white rounded-full font-bold shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined">add</span>
                Create Your First Recipe
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
              {recipes.map((recipe) => {
                const tag = getSmartTagStyle(recipe);
                const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0);

                return (
                  <Link
                    key={recipe.id}
                    to={`/recipe/${recipe.id}`}
                    className="group relative bg-white rounded-3xl overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] transition-all duration-300 hover:translate-y-[-4px]"
                  >
                    {/* Image */}
                    <div className="aspect-[4/3] overflow-hidden relative">
                      <img
                        alt={recipe.title}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                        src={recipe.cover_image_url || 'https://images.unsplash.com/photo-1495195129352-aec325a55b65?q=80&w=800'}
                      />
                      {/* Shimmer overlay on hover */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                      {/* Smart Tag pill */}
                      {tag && (
                        <div className="absolute top-4 left-4">
                          <span className={`inline-flex items-center gap-1 px-3 py-1 ${tag.bg} ${tag.text} text-[10px] font-extrabold uppercase tracking-[0.12em] rounded-full shadow-sm backdrop-blur-sm`}>
                            {tag.label}
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
                          {difficultyLabel[recipe.difficulty] || recipe.difficulty}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
      </div>

      {/* ─── Mobile Bottom Nav ──────────────────────────────── */}
      <footer className="md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-[#fafaf5]/90 backdrop-blur-xl rounded-t-3xl border-t border-outline-variant/15 shadow-[0_-4px_20px_rgba(0,0,0,0.04)]">
        <Link className="flex flex-col items-center justify-center text-primary" to="/">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>home</span>
          <span className="text-[11px] font-bold mt-0.5">Home</span>
        </Link>
        <Link className="flex flex-col items-center justify-center text-zinc-400 hover:text-primary transition-colors" to="#">
          <span className="material-symbols-outlined">search</span>
          <span className="text-[11px] font-bold mt-0.5">Search</span>
        </Link>
        <Link className="flex flex-col items-center justify-center text-zinc-400 hover:text-primary transition-colors" to="/planner">
          <span className="material-symbols-outlined">calendar_month</span>
          <span className="text-[11px] font-bold mt-0.5">Planner</span>
        </Link>
      </footer>
    </AppLayout>
  );
};

export default Home;