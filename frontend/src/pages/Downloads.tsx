import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { formatRelativeTime } from '../lib/relativeTime';
import type { DownloadedRecipeSummary } from '../lib/offlineStore';

const formatWhen = (iso: string) => formatRelativeTime(iso, { days: true });

export default function Downloads() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [recipes, setRecipes] = useState<DownloadedRecipeSummary[] | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = () => {
    import('../lib/offlineStore').then(({ listDownloadedRecipes }) => listDownloadedRecipes()).then(setRecipes);
  };

  useEffect(() => { refresh(); }, []);

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      const { removeDownloadedRecipe } = await import('../lib/offlineStore');
      await removeDownloadedRecipe(id);
      refresh();
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <AppLayout>
      <div className="p-6 sm:p-12 max-w-3xl mx-auto">
        <div className="mb-10">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('common.back')}
          </button>
          <h1 className="text-4xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter">{t('downloads.heading')}</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-2">
            {t('downloads.subtitle')}
          </p>
        </div>

        {recipes === null && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
          </div>
        )}

        {recipes !== null && recipes.length === 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-10 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
            <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">
              {t('downloads.empty')}
            </p>
          </div>
        )}

        {recipes !== null && recipes.length > 0 && (
          <div className="space-y-3">
            {recipes.map((r) => (
              <div key={r.id} className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 shadow-sm overflow-hidden flex items-center gap-4 p-4">
                <button
                  type="button"
                  onClick={() => navigate(`/recipe/${r.id}`)}
                  className="flex items-center gap-4 flex-1 min-w-0 text-left"
                >
                  <div className="w-14 h-14 rounded-2xl bg-zinc-100 dark:bg-zinc-800 shrink-0 overflow-hidden flex items-center justify-center">
                    {r.coverImageUrl ? (
                      <img src={r.coverImageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="material-symbols-outlined text-zinc-300 dark:text-zinc-600">restaurant</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{r.title}</p>
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-0.5">{t('downloads.downloadedWhen', { when: formatWhen(r.downloadedAt) })}</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(r.id)}
                  disabled={removingId === r.id}
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-zinc-400 dark:text-zinc-500 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 shrink-0"
                  aria-label={t('downloads.remove')}
                  title={t('downloads.remove')}
                >
                  <span className="material-symbols-outlined text-[20px]">{removingId === r.id ? 'sync' : 'delete'}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
