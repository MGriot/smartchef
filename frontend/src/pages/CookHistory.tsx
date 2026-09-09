import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import CoverImage from '../components/CoverImage';
import { apiFetch } from '../lib/api';

interface CookLogEntry {
  id: string;
  recipeId: string;
  recipeTitle: string;
  coverImageUrl: string | null;
  cookedAt: string;
  cookedByName: string | null;
}

const MAX_THUMBS_PER_DAY = 2;

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CookHistory() {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [entries, setEntries] = useState<CookLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    const from = toDateKey(month);
    const to = toDateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0));
    setLoading(true);
    apiFetch(`/api/cook-log?from=${from}&to=${to}`)
      .then((res) => res.json())
      .then((json) => setEntries(json.data || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [month]);

  const entriesByDay = useMemo(() => {
    const map = new Map<string, CookLogEntry[]>();
    for (const e of entries) {
      const key = toDateKey(new Date(e.cookedAt));
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [entries]);

  // Monday-first 6-row grid spanning from the Monday on/before the 1st to
  // the Sunday on/after the month's last day.
  const gridDays = useMemo(() => {
    const firstOfMonth = month;
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Monday
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - firstWeekday);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      days.push(d);
    }
    return days;
  }, [month]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    // A Monday-starting reference week (2024-01-01 is a Monday).
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }).format(month),
    [month, i18n.language]
  );

  const todayKey = toDateKey(new Date());
  const selectedEntries = selectedDay ? entriesByDay.get(selectedDay) || [] : [];

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-headline font-extrabold text-zinc-900 dark:text-zinc-100 capitalize">{monthLabel}</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="w-10 h-10 rounded-full bg-white dark:bg-zinc-900 shadow-sm border border-zinc-100 dark:border-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined">chevron_left</span>
            </button>
            <button
              onClick={() => setMonth(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); })}
              className="px-4 py-2 rounded-full bg-white dark:bg-zinc-900 shadow-sm border border-zinc-100 dark:border-zinc-800 text-xs font-bold text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors"
            >
              {t('history.today')}
            </button>
            <button
              onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="w-10 h-10 rounded-full bg-white dark:bg-zinc-900 shadow-sm border border-zinc-100 dark:border-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-2 mb-2">
          {weekdayLabels.map((label) => (
            <div key={label} className="text-center text-[10px] font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 py-1">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-2">
          {gridDays.map((day) => {
            const key = toDateKey(day);
            const dayEntries = entriesByDay.get(key) || [];
            const inMonth = day.getMonth() === month.getMonth();
            const isToday = key === todayKey;
            return (
              <button
                key={key}
                onClick={() => dayEntries.length > 0 && setSelectedDay(key)}
                disabled={dayEntries.length === 0}
                className={`aspect-square rounded-2xl p-2 flex flex-col items-start bg-white dark:bg-zinc-900 border transition-all text-left ${
                  inMonth ? 'border-zinc-100 dark:border-zinc-800' : 'border-transparent opacity-40'
                } ${isToday ? 'ring-2 ring-primary/40' : ''} ${dayEntries.length > 0 ? 'shadow-[0_1px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)] cursor-pointer' : 'cursor-default'}`}
              >
                <span className={`text-xs font-bold mb-1 ${isToday ? 'text-primary' : 'text-zinc-500 dark:text-zinc-400'}`}>{day.getDate()}</span>
                <div className="flex flex-wrap gap-1">
                  {dayEntries.slice(0, MAX_THUMBS_PER_DAY).map((e) => (
                    <CoverImage
                      key={e.id}
                      src={e.coverImageUrl}
                      alt=""
                      className="w-6 h-6 rounded-lg object-cover"
                      fallbackSrc="https://images.unsplash.com/photo-1495195129352-aec325a55b65?q=80&w=200"
                    />
                  ))}
                  {dayEntries.length > MAX_THUMBS_PER_DAY && (
                    <span className="w-6 h-6 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[9px] font-bold flex items-center justify-center">
                      +{dayEntries.length - MAX_THUMBS_PER_DAY}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {loading && <p className="text-center text-zinc-400 dark:text-zinc-500 text-sm mt-8">{t('common.loading')}</p>}
        {!loading && entries.length === 0 && (
          <p className="text-center text-zinc-400 dark:text-zinc-500 text-sm mt-8">{t('history.noEntriesThisMonth')}</p>
        )}
      </div>

      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" onClick={() => setSelectedDay(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl p-6 max-w-md w-full max-h-[70vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">
                {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full' }).format(new Date(`${selectedDay}T00:00:00`))}
              </h2>
              <button onClick={() => setSelectedDay(null)} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="space-y-2">
              {selectedEntries.map((e) => (
                <Link
                  key={e.id}
                  to={`/recipe/${e.recipeId}`}
                  className="flex items-center gap-3 px-3 py-2 bg-zinc-50 dark:bg-zinc-900 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  <CoverImage
                    src={e.coverImageUrl}
                    alt=""
                    className="w-10 h-10 rounded-lg object-cover shrink-0"
                    fallbackSrc="https://images.unsplash.com/photo-1495195129352-aec325a55b65?q=80&w=200"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{e.recipeTitle}</p>
                    {e.cookedByName && <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('history.cookedBy', { name: e.cookedByName })}</p>}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
