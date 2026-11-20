import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { formatDurationWith } from '../lib/duration';
import { DISCOVER_SOURCES, type FeedSource } from '../lib/feedSources';
import { getSetting } from '../lib/settingsRegistry';
import { subscribeSettings } from '../lib/settingsCache';
import { searchSites, type SiteRecipe, type SiteSearchProgress } from '../services/siteSearch';
import { queryWords } from '../lib/siteSearch';

const MIN_QUERY = 3;

/** "Search the sites": one query sent to every site Discover follows, using
 *  each site's own search rather than its feed, so a search reaches the
 *  whole site and not just its newest posts. Only pages that publish a
 *  recipe are shown; "Import" sends one through the normal import flow.
 *  The query lives in the address (?q=), so Back returns to the results. */
export default function SiteSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [input, setInput] = useState(query);
  const [sources, setSources] = useState<FeedSource[]>(() => getSetting<FeedSource[]>(DISCOVER_SOURCES));
  const [only, setOnly] = useState<string | null>(null);
  const [progress, setProgress] = useState<SiteSearchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const token = useRef(0);

  useEffect(() => subscribeSettings(() => setSources(getSetting<FeedSource[]>(DISCOVER_SOURCES))), []);
  useEffect(() => { setInput(query); }, [query]);

  useEffect(() => {
    const q = query.trim();
    const mine = ++token.current;
    setOnly(null);
    if (q.length < MIN_QUERY || sources.length === 0) {
      setProgress(null);
      setRunning(false);
      return;
    }
    setRunning(true);
    void searchSites(sources, q, (p) => { if (mine === token.current) setProgress(p); }, () => mine === token.current)
      .then((final) => { if (mine === token.current) setProgress(final); })
      .finally(() => { if (mine === token.current) setRunning(false); });
    return () => { token.current++; };
  }, [query, sources]);

  const submit = () => {
    const q = input.trim();
    if (q.length < MIN_QUERY) return;
    setParams({ q }, { replace: q === query });
  };

  const results = (progress?.results ?? []).filter((r) => !only || r.sourceId === only);
  // Recipes naming every word searched first; those naming only some (a
  // "zuppa inglese" for "zuppa di cipolle") under their own heading.
  const wordCount = queryWords(query).length;
  const full = wordCount ? results.filter((r) => r.score >= wordCount) : results;
  const partial = wordCount ? results.filter((r) => r.score < wordCount) : [];
  const groups: Array<{ key: string; label: string | null; items: SiteRecipe[] }> = full.length
    ? [{ key: 'full', label: null, items: full }, ...(partial.length ? [{ key: 'partial', label: t('siteSearch.partial'), items: partial }] : [])]
    : [{ key: 'all', label: null, items: partial }];
  const statusOf = (id: string) => progress?.status[id];
  const failed = sources.filter((s) => statusOf(s.id)?.state === 'failed');
  const unsearchable = sources.filter((s) => statusOf(s.id)?.state === 'unsearchable');
  const pending = sources.filter((s) => statusOf(s.id)?.state === 'searching').length;

  return (
    <AppLayout>
      <div className="p-6 sm:p-12 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-3xl font-black text-zinc-900 dark:text-zinc-100">{t('siteSearch.title')}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium mt-1">{t('siteSearch.subtitle')}</p>
          </div>
          <Link
            to="/discover"
            className="shrink-0 flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            <span className="material-symbols-outlined text-[18px]">public</span>
            {t('siteSearch.toDiscover')}
          </Link>
        </div>

        {sources.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-zinc-200 dark:border-zinc-700 p-10 text-center">
            <p className="text-zinc-500 dark:text-zinc-400 font-medium">{t('discover.noSources')}</p>
            <Link to="/account?tab=ai" className="inline-block mt-4 font-bold text-primary hover:underline">{t('discover.manageSources')}</Link>
          </div>
        ) : (
          <>
            <form
              role="search"
              className="flex gap-2 mb-4"
              onSubmit={(e) => { e.preventDefault(); submit(); }}
            >
              <div className="relative min-w-0 flex-1">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-[20px]">search</span>
                <input
                  type="search"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t('siteSearch.placeholder')}
                  aria-label={t('siteSearch.placeholder')}
                  enterKeyHint="search"
                  className="w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-10 pr-4 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary"
                />
              </div>
              <button
                type="submit"
                disabled={input.trim().length < MIN_QUERY}
                className="shrink-0 rounded-2xl bg-primary px-5 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                {t('siteSearch.search')}
              </button>
            </form>

            {!query && (
              <p className="py-10 text-center text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t('siteSearch.intro', { count: sources.length })}
              </p>
            )}

            {query && (
              <>
                {/* One chip per site: what it is doing, how many recipes it gave. */}
                <div className="flex gap-2 overflow-x-auto pb-3 mb-3 -mx-1 px-1">
                  <button
                    type="button"
                    onClick={() => setOnly(null)}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-black transition-colors ${only === null ? 'bg-primary text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'}`}
                  >
                    {t('discover.all')} · {progress?.results.length ?? 0}
                  </button>
                  {sources.map((s) => {
                    const st = statusOf(s.id);
                    const count = progress?.results.filter((r) => r.sourceId === s.id).length ?? 0;
                    const idle = st?.state === 'unsearchable' || st?.state === 'failed';
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={count === 0}
                        onClick={() => setOnly(only === s.id ? null : s.id)}
                        className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-black transition-colors disabled:cursor-default ${
                          only === s.id ? 'bg-primary text-white' : idle ? 'bg-zinc-50 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 line-through decoration-zinc-300' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300'
                        }`}
                      >
                        {(!st || st.state === 'searching') && <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>}
                        {s.name}
                        {st?.state === 'done' && <span className="opacity-70">· {count}</span>}
                      </button>
                    );
                  })}
                </div>

                {running && (
                  <p className="mb-4 flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400" role="status">
                    <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                    {t('siteSearch.searching', { done: sources.length - pending, total: sources.length })}
                  </p>
                )}

                {failed.length > 0 && !running && (
                  <p className="mb-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs font-medium text-amber-800 dark:text-amber-200">
                    {t('siteSearch.failed', { names: failed.map((s) => s.name).join(', ') })}
                  </p>
                )}
                {unsearchable.length > 0 && !running && (
                  <p className="mb-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t('siteSearch.unsearchable', { names: unsearchable.map((s) => s.name).join(', ') })}{' '}
                    <Link to="/account?tab=ai" className="font-bold text-primary hover:underline">{t('siteSearch.setSearchUrl')}</Link>
                  </p>
                )}

                {!running && results.length === 0 && (
                  <p className="py-12 text-center text-zinc-500 dark:text-zinc-400 font-medium">{t('siteSearch.empty', { query })}</p>
                )}

                {groups.filter((g) => g.items.length).map((group) => (
                  <section key={group.key} className="mb-8">
                    {group.label && <h2 className="mb-4 text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{group.label}</h2>}
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 md:divide-y-0 md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-7">
                  {group.items.map((item) => (
                    <li
                      key={item.url}
                      className="group flex items-center gap-4 py-3 md:py-0 md:flex-col md:items-stretch md:gap-0 md:bg-white md:dark:bg-zinc-900 md:rounded-3xl md:overflow-hidden md:shadow-[0_2px_16px_rgba(0,0,0,0.05)] md:hover:shadow-[0_8px_40px_rgba(0,0,0,0.10)] md:transition-shadow animate-card-in"
                    >
                      <a href={item.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true" className="shrink-0 md:block md:w-full md:aspect-[4/3] md:overflow-hidden">
                        {item.image ? (
                          <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-16 w-16 rounded-xl object-cover bg-zinc-100 dark:bg-zinc-800 md:h-full md:w-full md:rounded-none" />
                        ) : (
                          <span className="h-16 w-16 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-300 dark:text-zinc-600 md:h-full md:w-full md:rounded-none">
                            <span className="material-symbols-outlined md:text-[48px]">restaurant</span>
                          </span>
                        )}
                      </a>
                      <div className="min-w-0 flex-1 md:flex md:flex-col md:p-6">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="block font-bold text-zinc-900 dark:text-zinc-100 hover:text-primary leading-snug break-words md:font-headline md:text-xl md:line-clamp-3">
                          {item.title}
                        </a>
                        <p className="mt-0.5 text-xs font-medium text-zinc-400 dark:text-zinc-500 md:mt-2 md:text-sm">
                          {[
                            item.sourceName,
                            item.totalMin ? formatDurationWith(t, item.totalMin, { short: true }) : null,
                            item.servings ? t('siteSearch.servings', { count: item.servings }) : null,
                          ].filter(Boolean).join(' · ')}
                        </p>
                        <div className="hidden md:flex items-center gap-2 mt-5 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                          <button
                            type="button"
                            onClick={() => navigate(`/import?url=${encodeURIComponent(item.url)}`)}
                            className="flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-primary bg-primary/5 hover:bg-primary/10"
                          >
                            <span className="material-symbols-outlined text-[20px]">download</span>
                            {t('discover.importToGallery')}
                          </button>
                          <a href={item.url} target="_blank" rel="noopener noreferrer" title={t('discover.openInBrowser')} aria-label={t('discover.openInBrowser')} className="rounded-xl p-2.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                            <span className="material-symbols-outlined text-[22px]">open_in_new</span>
                          </a>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1 md:hidden">
                        <button
                          type="button"
                          onClick={() => navigate(`/import?url=${encodeURIComponent(item.url)}`)}
                          title={t('discover.importToGallery')}
                          aria-label={t('discover.importToGallery')}
                          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black text-primary bg-primary/5 hover:bg-primary/10"
                        >
                          <span className="material-symbols-outlined text-[18px]">download</span>
                          <span className="hidden sm:inline">{t('discover.import')}</span>
                        </button>
                        <a href={item.url} target="_blank" rel="noopener noreferrer" title={t('discover.openInBrowser')} aria-label={t('discover.openInBrowser')} className="rounded-xl p-2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                          <span className="material-symbols-outlined text-[20px]">open_in_new</span>
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                  </section>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
