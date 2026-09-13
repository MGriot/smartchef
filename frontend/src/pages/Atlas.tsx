import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import AtlasMap from '../components/AtlasMap';
import CoverImage from '../components/CoverImage';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';

interface TagDisplay {
  name: string;
  translated_name: string;
  color: string | null;
}

/** The subset of GET /api/recipes a map view needs. Both the server route
 *  and the local SQLite router select the whole row, so `regions` and
 *  `region_coords` come back on the list response in either mode. */
interface AtlasRecipe {
  id: string;
  title: string;
  translated_title?: string | null;
  cover_image_url: string;
  regions?: string[] | null;
  region_coords?: Record<string, { lat: number; lng: number }> | null;
  rating: number | null;
  times_cooked: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  tags_display?: TagDisplay[];
}

const CARD = 'bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 shadow-[0_1px_8px_rgba(0,0,0,0.04)]';

/** Not a region — the selection that means "the recipes with no region at
 *  all". The unmapped count was a number on a card with nothing behind it:
 *  it told you 2 recipes were missing from the map and gave you no way to
 *  find out which, so the one action it invites (go and tag them) meant
 *  hunting the whole library by hand. */
const UNMAPPED = '__unmapped__';

export default function Atlas() {
  const { t, i18n } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);
  const [recipes, setRecipes] = useState<AtlasRecipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (contentLang) params.set('lang', contentLang);
        const res = await apiFetch(`/api/recipes?${params.toString()}`);
        const json = await res.json();
        setRecipes(json.data || []);
      } catch (err) {
        console.error('Error fetching recipes for the atlas:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [contentLang]);

  // One pass over the library: a recipe tagged with three countries counts
  // once for each of them, so the counts sum to more than the recipe total.
  // That's the honest reading of "how many recipes touch this place", and
  // it's why the header reports mapped *recipes* separately.
  const { pins, coords, ranked, unmapped } = useMemo(() => {
    const byRegion: Record<string, AtlasRecipe[]> = {};
    const coords: Record<string, { lat: number; lng: number }> = {};
    let unmapped = 0;
    for (const r of recipes) {
      const regions = r.regions || [];
      if (regions.length === 0) {
        unmapped++;
        continue;
      }
      for (const region of regions) (byRegion[region] ||= []).push(r);
      for (const [k, v] of Object.entries(r.region_coords || {})) coords[k.toLowerCase()] = v;
    }
    // The map wants the recipes themselves (its pins open a card of covers);
    // the ranking list only wants the counts.
    const pins = Object.entries(byRegion).map(([key, rs]) => ({
      key,
      recipes: rs.map((r) => ({ id: r.id, title: r.translated_title || r.title, cover: r.cover_image_url })),
    }));
    const ranked = Object.entries(byRegion)
      .map(([key, rs]) => [key, rs.length] as [string, number])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { pins, coords, ranked, unmapped };
  }, [recipes]);

  const shown = useMemo(() => {
    if (selected === UNMAPPED) return recipes.filter((r) => (r.regions || []).length === 0);
    if (selected === null) return recipes.filter((r) => (r.regions || []).length > 0);
    return recipes.filter((r) => (r.regions || []).includes(selected));
  }, [recipes, selected]);

  // Aggregates for whatever is currently selected — the whole mapped library
  // when nothing is.
  const stats = useMemo(() => {
    const rated = shown.filter((r) => typeof r.rating === 'number' && r.rating! > 0);
    const tagTally: Record<string, { label: string; color: string | null; n: number }> = {};
    for (const r of shown) {
      for (const tag of r.tags_display || []) {
        const key = tag.name.toLowerCase();
        tagTally[key] = { label: tag.translated_name || tag.name, color: tag.color, n: (tagTally[key]?.n || 0) + 1 };
      }
    }
    return {
      recipes: shown.length,
      cooks: shown.reduce((sum, r) => sum + (r.times_cooked || 0), 0),
      avgRating: rated.length ? rated.reduce((s, r) => s + (r.rating || 0), 0) / rated.length : null,
      topTags: Object.values(tagTally).sort((a, b) => b.n - a.n).slice(0, 6),
    };
  }, [shown]);

  const label = (key: string) =>
    key === UNMAPPED ? t('atlas.unmapped')
    : isCountryCode(key) ? `${flagEmoji(key)} ${countryDisplayName(key, i18n.language)}`
    : key;

  const maxCount = ranked.length ? ranked[0][1] : 0;

  return (
    <AppLayout>
      <div className="px-8 lg:px-12 py-10 max-w-[1400px] mx-auto">
        <div className="mb-8">
          <h1 className="text-5xl font-extrabold tracking-tight font-headline text-on-surface mb-2">{t('atlas.title')}</h1>
          <p className="text-secondary text-lg max-w-2xl">{t('atlas.subtitle')}</p>
        </div>

        {/* Library-wide totals — these never change with the selection, so
            they stay above it as the frame of reference for the panel that
            does. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: t('atlas.mappedRecipes'), value: recipes.length - unmapped, icon: 'travel_explore', onClick: null },
            { label: t('atlas.regionsCovered'), value: ranked.length, icon: 'public', onClick: null },
            { label: t('atlas.totalCooks'), value: recipes.reduce((s, r) => s + (r.times_cooked || 0), 0), icon: 'skillet', onClick: null },
            {
              label: t('atlas.unmapped'),
              value: unmapped,
              icon: 'location_off',
              // The only KPI here with something to open: pressing it
              // selects the recipes that have no region, so they can be
              // looked at (and tagged) rather than just counted.
              onClick: unmapped > 0 ? () => setSelected((cur) => (cur === UNMAPPED ? null : UNMAPPED)) : null,
            },
          ].map((s) => {
            const active = s.onClick && selected === UNMAPPED;
            const body = (
              <>
                <span className={`material-symbols-outlined text-[28px] ${active ? 'text-primary' : 'text-primary/60'}`} style={{ fontVariationSettings: "'FILL' 1" }}>{s.icon}</span>
                <div className="text-left">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">{s.label}</p>
                  <p className={`text-2xl font-bold font-headline tabular-nums ${active ? 'text-primary' : 'text-zinc-800 dark:text-zinc-200'}`}>{s.value}</p>
                </div>
              </>
            );
            return s.onClick ? (
              <button
                key={s.label}
                onClick={s.onClick}
                aria-pressed={!!active}
                title={t('atlas.showUnmapped')}
                className={`${CARD} px-5 py-4 flex items-center gap-4 w-full transition-colors ${active ? 'border-primary/40 bg-primary/5' : 'hover:border-primary/30'}`}
              >
                {body}
              </button>
            ) : (
              <div key={s.label} className={`${CARD} px-5 py-4 flex items-center gap-4`}>{body}</div>
            );
          })}
        </div>

        {loading ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('atlas.loading')}</p>
        ) : ranked.length === 0 && selected !== UNMAPPED ? (
          <div className={`${CARD} p-10 text-center`}>
            <span className="material-symbols-outlined text-4xl text-zinc-300 dark:text-zinc-600">public_off</span>
            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400 max-w-md mx-auto">{t('atlas.emptyState')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              <div className="xl:col-span-8 min-w-0">
                <AtlasMap
                  regions={pins}
                  coords={coords}
                  selected={selected}
                  onSelect={setSelected}
                  locale={i18n.language}
                  showAllLabel={t('atlas.showOnlyThese')}
                  moreLabel={(n) => t('atlas.andMore', { count: n })}
                />
              </div>

              {/* Ranking — the map answers "where", this answers "how many",
                  and either one drives the selection. */}
              <div className={`xl:col-span-4 ${CARD} p-6 min-w-0`}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-headline font-bold text-lg">{t('atlas.ranking')}</h2>
                  {selected && (
                    <button
                      onClick={() => setSelected(null)}
                      className="text-xs font-bold text-primary hover:underline"
                    >
                      {t('atlas.clearSelection')}
                    </button>
                  )}
                </div>
                <div className="space-y-1 max-h-[430px] overflow-y-auto pr-1">
                  {ranked.map(([region, n]) => {
                    const isSelected = selected === region;
                    return (
                      <button
                        key={region}
                        onClick={() => setSelected(isSelected ? null : region)}
                        className={`w-full text-left px-3 py-2 rounded-xl transition-colors ${
                          isSelected ? 'bg-primary/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className={`text-sm truncate ${isSelected ? 'font-bold text-primary' : 'text-zinc-700 dark:text-zinc-300'}`}>
                            {label(region)}
                          </span>
                          <span className="text-sm font-bold tabular-nums text-zinc-500 dark:text-zinc-400 shrink-0">{n}</span>
                        </div>
                        <div className="mt-1.5 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                          <div
                            className={isSelected ? 'h-full bg-primary' : 'h-full bg-primary/40'}
                            style={{ width: `${Math.max(4, (n / maxCount) * 100)}%` }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Aggregates for the current selection */}
            <div className={`${CARD} mt-6 p-6 flex flex-wrap items-center gap-x-10 gap-y-4`}>
              <div className="flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">
                  {selected ? t('atlas.selection') : t('atlas.allRegions')}
                </span>
                {selected && (
                  <span className="px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center gap-2">
                    {label(selected)}
                    <button onClick={() => setSelected(null)} aria-label={t('atlas.clearSelection')} className="flex items-center">
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                {[
                  { label: t('atlas.recipes'), value: String(stats.recipes) },
                  { label: t('atlas.cooked'), value: String(stats.cooks) },
                  { label: t('atlas.avgRating'), value: stats.avgRating ? `${stats.avgRating.toFixed(1)} ★` : '—' },
                ].map((s) => (
                  <div key={s.label}>
                    <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">{s.label}</p>
                    <p className="text-lg font-bold font-headline text-zinc-800 dark:text-zinc-200 tabular-nums">{s.value}</p>
                  </div>
                ))}
              </div>
              {stats.topTags.length > 0 && (
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold mb-1.5">{t('atlas.topTags')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {stats.topTags.map((tag) => (
                      <span
                        key={tag.label}
                        className="px-2.5 py-1 rounded-full text-white text-[10px] font-bold uppercase tracking-[0.1em]"
                        style={{ backgroundColor: tag.color || '#3f3f46' }}
                      >
                        {tag.label} {tag.n}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* The recipes behind the numbers */}
            <div className="mt-8">
              {shown.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('atlas.noRecipes')}</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
                  {shown.map((r) => (
                    <Link
                      key={r.id}
                      /* Straight into the editor for the unmapped ones:
                         the reason to open that list at all is to give
                         these recipes a region. */
                      to={selected === UNMAPPED ? `/recipe/${r.id}?mode=edit` : `/recipe/${r.id}`}
                      className={`${CARD} overflow-hidden group`}
                    >
                      <div className="h-40 overflow-hidden">
                        <CoverImage
                          src={r.cover_image_url}
                          alt={r.translated_title || r.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      </div>
                      <div className="p-4">
                        <h3 className="font-headline font-bold text-sm text-zinc-800 dark:text-zinc-200 leading-snug line-clamp-2">
                          {r.translated_title || r.title}
                        </h3>
                        {selected === UNMAPPED && (
                          <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-primary">{t('atlas.addRegion')}</p>
                        )}
                        <div className="flex flex-wrap gap-1 mt-2">
                          {(r.regions || []).slice(0, 3).map((region) => (
                            <span key={region} className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500">
                              {label(region)}
                            </span>
                          ))}
                          {(r.regions || []).length > 3 && (
                            <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500">+{(r.regions || []).length - 3}</span>
                          )}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
