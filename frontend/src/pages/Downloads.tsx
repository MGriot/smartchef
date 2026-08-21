import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../components/AppLayout';
import type { DownloadedRecipeSummary } from '../lib/offlineStore';

function formatWhen(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
}

export default function Downloads() {
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
            className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-600 text-sm font-bold mb-6 transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            Back
          </button>
          <h1 className="text-4xl font-black text-zinc-900 tracking-tighter">Offline Downloads</h1>
          <p className="text-sm text-zinc-400 font-medium mt-2">
            Recipes downloaded individually for offline viewing — separate from the automatic whole-library cache. Removing one here only frees local storage; it stays on the server.
          </p>
        </div>

        {recipes === null && (
          <div className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 text-center">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
          </div>
        )}

        {recipes !== null && recipes.length === 0 && (
          <div className="bg-white rounded-[40px] p-10 shadow-sm border border-zinc-100 text-center">
            <p className="text-sm text-zinc-400 font-medium">
              No recipes downloaded yet — open a recipe and tap the download icon in its header to make it available offline.
            </p>
          </div>
        )}

        {recipes !== null && recipes.length > 0 && (
          <div className="space-y-3">
            {recipes.map((r) => (
              <div key={r.id} className="bg-white rounded-3xl border border-zinc-100 shadow-sm overflow-hidden flex items-center gap-4 p-4">
                <button
                  type="button"
                  onClick={() => navigate(`/recipe/${r.id}`)}
                  className="flex items-center gap-4 flex-1 min-w-0 text-left"
                >
                  <div className="w-14 h-14 rounded-2xl bg-zinc-100 shrink-0 overflow-hidden flex items-center justify-center">
                    {r.coverImageUrl ? (
                      <img src={r.coverImageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="material-symbols-outlined text-zinc-300">restaurant</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-zinc-900 truncate">{r.title}</p>
                    <p className="text-xs text-zinc-400 font-medium mt-0.5">Downloaded {formatWhen(r.downloadedAt)}</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(r.id)}
                  disabled={removingId === r.id}
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 shrink-0"
                  aria-label="Remove download"
                  title="Remove download"
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
