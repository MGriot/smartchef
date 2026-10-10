import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { formatRelativeTime } from '../lib/relativeTime';
import { DISCOVER_SOURCES, type FeedSource } from '../lib/feedSources';
import { getSetting } from '../lib/settingsRegistry';
import { subscribeSettings } from '../lib/settingsCache';
import { loadDiscover, type DiscoverResult } from '../services/feeds';

const PAGE_SIZE = 40;

/** Recipe titles from the sites the user follows, like an RSS reader. A title
 *  opens the original page in the browser; "Import" sends the page through the
 *  normal import flow, which ends in the gallery. */
export default function Discover() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sources, setSources] = useState<FeedSource[]>(() => getSetting<FeedSource[]>(DISCOVER_SOURCES));
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [only, setOnly] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  // A source added or removed in Settings (or arriving by sync) shows up here.
  useEffect(() => subscribeSettings(() => setSources(getSetting<FeedSource[]>(DISCOVER_SOURCES))), []);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      setResult(await loadDiscover(sources, force));
    } finally {
      setLoading(false);
    }
  }, [sources]);

  useEffect(() => { void load(false); }, [load]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (result?.items ?? []).filter((i) => (!only || i.sourceId === only) && (!q || i.title.toLowerCase().includes(q)));
  }, [result, only, query]);

  const failed = sources.filter((s) => result?.errors[s.id]);

  return (
    <AppLayout>
      <div className="p-6 sm:p-12 max-w-4xl mx-auto">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-black text-zinc-900 dark:text-zinc-100">{t('discover.title')}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium mt-1">{t('discover.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="shrink-0 flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>refresh</span>
            {t('discover.refresh')}
          </button>
        </div>

        {sources.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-zinc-200 dark:border-zinc-700 p-10 text-center">
            <p className="text-zinc-500 dark:text-zinc-400 font-medium">{t('discover.noSources')}</p>
            <Link to="/account" className="inline-block mt-4 font-bold text-primary hover:underline">{t('discover.manageSources')}</Link>
          </div>
        ) : (
          <>
            <div className="relative mb-4">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-[20px]">search</span>
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE); }}
                placeholder={t('discover.search')}
                className="w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-10 pr-4 py-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary"
              />
            </div>

            <div className="flex gap-2 overflow-x-auto pb-3 mb-3 -mx-1 px-1">
              {[{ id: null as string | null, name: t('discover.all') }, ...sources].map((s) => (
                <button
                  key={s.id ?? 'all'}
                  type="button"
                  onClick={() => { setOnly(s.id); setShown(PAGE_SIZE); }}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-black transition-colors ${
                    only === s.id
                      ? 'bg-primary text-white'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {failed.length > 0 && !loading && (
              <p className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs font-medium text-amber-800 dark:text-amber-200">
                {t('discover.someFailed', { names: failed.map((s) => s.name).join(', ') })}
              </p>
            )}

            {loading && !result && (
              <div className="flex items-center justify-center gap-3 py-16 text-zinc-500 dark:text-zinc-400">
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                <span className="font-medium">{t('discover.loading')}</span>
              </div>
            )}

            {result && items.length === 0 && !loading && (
              <p className="py-12 text-center text-zinc-500 dark:text-zinc-400 font-medium">{t('discover.empty')}</p>
            )}

            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {items.slice(0, shown).map((item) => (
                <li key={`${item.sourceId}:${item.link}`} className="flex items-center gap-4 py-3">
                  {item.image ? (
                    <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-xl object-cover bg-zinc-100 dark:bg-zinc-800" />
                  ) : (
                    <span className="h-16 w-16 shrink-0 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-300 dark:text-zinc-600">
                      <span className="material-symbols-outlined">restaurant</span>
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block font-bold text-zinc-900 dark:text-zinc-100 hover:text-primary leading-snug break-words"
                    >
                      {item.title}
                    </a>
                    <p className="mt-0.5 text-xs font-medium text-zinc-400 dark:text-zinc-500">
                      {item.sourceName}{item.published ? ` · ${formatRelativeTime(item.published, { days: true })}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => navigate(`/import?url=${encodeURIComponent(item.link)}`)}
                      title={t('discover.importToGallery')}
                      aria-label={t('discover.importToGallery')}
                      className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black text-primary bg-primary/5 hover:bg-primary/10"
                    >
                      <span className="material-symbols-outlined text-[18px]">download</span>
                      <span className="hidden sm:inline">{t('discover.import')}</span>
                    </button>
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t('discover.openInBrowser')}
                      aria-label={t('discover.openInBrowser')}
                      className="rounded-xl p-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="material-symbols-outlined text-[20px]">open_in_new</span>
                    </a>
                  </div>
                </li>
              ))}
            </ul>

            {items.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE_SIZE)}
                className="mt-4 w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 py-3 text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                {t('discover.showMore')}
              </button>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
