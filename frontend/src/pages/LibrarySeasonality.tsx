import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import RenderFaIcon from '../components/RenderFaIcon';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

interface SeasonalIngredient {
  id: string;
  name: string;
  translated_name?: string | null;
  icon: string | null;
  category_name?: string | null;
  seasonal_months: number[];
}

const MONTH_KEYS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Read-only browse view of every ingredient's seasonality, one month at a
 * time — editing itself happens per-ingredient in LibraryIngredients.tsx,
 * this is purely "what's in season this month" at a glance. A month
 * selector rather than a day-grid calendar (unlike CookHistory.tsx's
 * cook-log calendar) since seasonality data is monthly, not daily.
 */
export default function LibrarySeasonality() {
  const { t, i18n } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);
  const [ingredients, setIngredients] = useState<SeasonalIngredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/ingredients${contentLang ? `?lang=${contentLang}` : ''}`)
      .then(res => res.json())
      .then(json => {
        setIngredients(json.data || []);
        setLoading(false);
      });
  }, [contentLang]);

  const monthLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: 'long' });
    // Any known non-leap year — only the month component is used.
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2026, i, 1)));
  }, [i18n.language]);

  const withSeasonData = ingredients.filter(i => (i.seasonal_months || []).length > 0);
  const inSeasonNow = withSeasonData.filter(i => (i.seasonal_months || []).includes(selectedMonth));
  const outOfSeason = withSeasonData.filter(i => !(i.seasonal_months || []).includes(selectedMonth));

  return (
    <AppLayout librarySection="seasonality">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-black text-zinc-900 dark:text-zinc-100">{t('nav.seasonality')}</h1>
        </div>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mb-8">{t('seasonality.hint')}</p>

        {/* Month selector */}
        <div className="flex flex-wrap gap-2 mb-8">
          {MONTH_KEYS.map((key, i) => {
            const month = i + 1;
            const active = month === selectedMonth;
            return (
              <button
                key={key}
                onClick={() => setSelectedMonth(month)}
                className={`px-4 py-2.5 rounded-full text-sm font-bold capitalize transition-all ${
                  active ? 'bg-primary text-white shadow-sm shadow-primary/20' : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'
                }`}
              >
                {monthLabels[i]}
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('common.loading')}</p>
        ) : withSeasonData.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('seasonality.noData')}</p>
        ) : (
          <>
            <div className="mb-10">
              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
                {t('seasonality.inSeason', { month: monthLabels[selectedMonth - 1] })} — {inSeasonNow.length}
              </p>
              {inSeasonNow.length === 0 ? (
                <p className="text-sm text-zinc-300 dark:text-zinc-600 font-medium">{t('seasonality.noneInSeason')}</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {inSeasonNow.map(ing => (
                    <div key={ing.id} className="flex items-center gap-3 px-4 py-3 bg-primary/5 border border-primary/15 rounded-2xl">
                      <RenderFaIcon name={ing.icon || 'FaEgg'} className="text-primary text-lg shrink-0" />
                      <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 truncate">{ing.translated_name || ing.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {outOfSeason.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
                  {t('seasonality.outOfSeason')} — {outOfSeason.length}
                </p>
                <div className="flex flex-wrap gap-2">
                  {outOfSeason.map(ing => (
                    <div key={ing.id} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-50 dark:bg-zinc-900 rounded-full text-xs font-medium text-zinc-400 dark:text-zinc-500">
                      <RenderFaIcon name={ing.icon || 'FaEgg'} className="text-[13px]" />
                      {ing.translated_name || ing.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
