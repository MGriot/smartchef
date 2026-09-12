import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchSuggestion } from '../lib/fuzzyMatch';

/** Type-and-see catalog search for the import review step.
 *
 *  Replaces a box with a Search button next to it. That shape cost a round
 *  of "type, press, look, it's wrong, retype, press again" per ingredient,
 *  on a screen that can easily have twenty of them — and it auto-selected
 *  whatever came back first, so a wrong guess was silently committed rather
 *  than merely offered. Here the results land as you type and nothing is
 *  chosen until you click a row.
 *
 *  The box stays open after a pick (with the choice shown as selected), so
 *  correcting a mis-click is one more click rather than reopening the
 *  search and starting over. */
export default function CatalogSearchBox({
  query,
  onQueryChange,
  search,
  onPick,
  onClose,
  selectedId,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  /** Runs the actual lookup. Called debounced, never on an empty query. */
  search: (query: string) => Promise<MatchSuggestion[]>;
  onPick: (result: MatchSuggestion) => void;
  onClose: () => void;
  selectedId?: string;
}) {
  const { t } = useTranslation();
  const [results, setResults] = useState<MatchSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a slow early request landing after a fast later one and
  // painting stale results over them — the classic autocomplete race, and
  // one the previous press-to-search UI couldn't hit because it only ever
  // had one request in flight.
  const requestSeq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setBusy(false);
      return;
    }
    const seq = ++requestSeq.current;
    setBusy(true);
    // Long enough that a typed word is one request rather than six, short
    // enough that the list feels like it is keeping up.
    const timer = setTimeout(async () => {
      try {
        const found = await search(trimmed);
        if (seq === requestSeq.current) setResults(found);
      } catch {
        if (seq === requestSeq.current) setResults([]);
      } finally {
        if (seq === requestSeq.current) setBusy(false);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [query, search]);

  return (
    <div className="mt-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-2">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
          placeholder={t('import.typeToSearchExisting')}
          className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>

      {query.trim() && (
        <div className="mt-1.5 max-h-44 overflow-y-auto">
          {results === null ? (
            <p className="px-2 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">{t('common.loading')}</p>
          ) : results.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] italic text-zinc-400 dark:text-zinc-500">
              {busy ? t('common.loading') : t('import.searchNoResults')}
            </p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onPick(r)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${
                  r.id === selectedId
                    ? 'bg-primary/10 text-primary font-bold'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}
              >
                {r.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
