import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_FEED_SOURCES, DISCOVER_SOURCES, MAX_FEED_SOURCES, feedSourceId, type FeedSource } from '../lib/feedSources';
import { getSetting } from '../lib/settingsRegistry';
import { subscribeSettings } from '../lib/settingsCache';
import { normalizeSearchTemplate } from '../lib/siteSearch';

/** Settings card for the Discover view: the sites whose recipe titles it lists.
 *  The list is a synced setting, so a change here reaches every device. */
export default function DiscoverSourcesCard() {
  const { t } = useTranslation();
  const [sources, setSources] = useState<FeedSource[]>(() => getSetting<FeedSource[]>(DISCOVER_SOURCES));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [searchError, setSearchError] = useState(false);

  useEffect(() => subscribeSettings(() => setSources(getSetting<FeedSource[]>(DISCOVER_SOURCES))), []);

  const save = (next: FeedSource[]) => {
    setSources(next);
    void import('../services/settings.local')
      .then(({ setSetting }) => setSetting(DISCOVER_SOURCES, next))
      .catch((err) => console.warn('SmartChef: saving the Discover sources failed:', err));
  };

  const add = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { resolveFeedSource } = await import('../services/feeds');
      const found = await resolveFeedSource(input);
      if (sources.some((s) => s.feedUrl === found.feedUrl)) {
        setError(t('account.discoverSources.duplicate'));
        return;
      }
      save([...sources, { id: feedSourceId(found.feedUrl), name: found.name, feedUrl: found.feedUrl }]);
      setInput('');
    } catch (err) {
      setError(err instanceof Error && err.message === 'no-feed' ? t('account.discoverSources.noFeed') : t('account.discoverSources.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-6 sm:p-10 shadow-sm border border-zinc-100 dark:border-zinc-800">
      <div className="mb-6">
        <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('account.discoverSources.heading')}</h2>
        <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-1">{t('account.discoverSources.subtitle')}</p>
      </div>

      {sources.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium mb-4">{t('account.discoverSources.none')}</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 mb-4">
          {sources.map((s) => (
            <li key={s.id} className="py-2.5">
              <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100 truncate">{s.name}</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{s.feedUrl}</p>
                {s.searchUrl && editing !== s.id && (
                  <p className="text-xs text-primary truncate">{t('account.discoverSources.searchUrlSet', { url: s.searchUrl })}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setEditing(editing === s.id ? null : s.id); setSearchDraft(s.searchUrl ?? ''); setSearchError(false); }}
                title={t('account.discoverSources.searchUrl')}
                aria-label={`${t('account.discoverSources.searchUrl')} ${s.name}`}
                aria-expanded={editing === s.id}
                className={`rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 ${s.searchUrl ? 'text-primary' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
              >
                <span className="material-symbols-outlined text-[20px]">travel_explore</span>
              </button>
              <button
                type="button"
                onClick={() => save(sources.filter((x) => x.id !== s.id))}
                title={t('account.discoverSources.remove')}
                aria-label={`${t('account.discoverSources.remove')} ${s.name}`}
                className="rounded-xl p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                <span className="material-symbols-outlined text-[20px]">delete</span>
              </button>
              </div>
              {/* How "Search the sites" asks this site: found on its own for
                  most sites, typed here for one whose search it cannot read. */}
              {editing === s.id && (
                <form
                  className="mt-2 space-y-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const raw = searchDraft.trim();
                    if (raw && !normalizeSearchTemplate(raw)) { setSearchError(true); return; }
                    save(sources.map((x) => {
                      if (x.id !== s.id) return x;
                      const { searchUrl: _old, ...rest } = x;
                      return raw ? { ...rest, searchUrl: raw } : rest;
                    }));
                    void import('../services/siteSearch').then(({ forgetSiteSearch }) => forgetSiteSearch(s.id));
                    setEditing(null);
                  }}
                >
                  <div className="flex gap-2">
                    <input
                      value={searchDraft}
                      onChange={(e) => { setSearchDraft(e.target.value); setSearchError(false); }}
                      placeholder="https://www.sito.it/cerca?q={q}"
                      inputMode="url"
                      autoCapitalize="none"
                      aria-label={t('account.discoverSources.searchUrl')}
                      className="min-w-0 flex-1 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary"
                    />
                    <button type="submit" className="shrink-0 rounded-2xl bg-primary px-4 py-2 text-sm font-black text-white">
                      {t('common.save')}
                    </button>
                  </div>
                  <p className={`text-xs ${searchError ? 'font-bold text-red-600' : 'text-zinc-400 dark:text-zinc-500'}`}>
                    {searchError ? t('account.discoverSources.searchUrlInvalid') : t('account.discoverSources.searchUrlHint')}
                  </p>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {sources.length < MAX_FEED_SOURCES && (
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void add(); }}
        >
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(null); }}
            placeholder={t('account.discoverSources.placeholder')}
            inputMode="url"
            autoCapitalize="none"
            className="min-w-0 flex-1 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-2.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-2xl bg-primary px-4 py-2.5 text-sm font-black text-white disabled:opacity-50"
          >
            {busy ? t('account.discoverSources.adding') : t('account.discoverSources.add')}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-xs font-bold text-red-600">{error}</p>}

      <button
        type="button"
        onClick={() => save(DEFAULT_FEED_SOURCES)}
        className="mt-4 text-xs font-bold text-primary hover:underline"
      >
        {t('account.discoverSources.reset')}
      </button>
    </div>
  );
}
