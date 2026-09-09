import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type CookTimer,
  subscribeCookTimers,
  cancelCookTimer,
  remainingMs,
  formatRemaining,
} from '../lib/cookTimers';

/** Every running timer, pinned to the bottom of kitchen mode.
 *
 *  Several at once is the normal case, not the exception — a sauce, a
 *  roast and the pasta water all run together — so this is a row of chips
 *  rather than one prominent countdown. A finished timer turns and stays
 *  put until dismissed: if it vanished on its own you would have no way to
 *  tell "it rang while I was in the other room" from "I never started it". */
export default function CookTimerBar() {
  const { t } = useTranslation();
  const [timers, setTimers] = useState<CookTimer[]>([]);
  const [, forceTick] = useState(0);

  useEffect(() => subscribeCookTimers(setTimers), []);

  // The store emits twice a second while anything runs, which is what moves
  // these numbers; this only covers the moment between renders.
  useEffect(() => {
    if (timers.length === 0) return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [timers.length]);

  if (timers.length === 0) return null;
  const now = Date.now();

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 border-t border-zinc-700/60 bg-zinc-900/95 backdrop-blur-md px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
        {timers.map((timer) => {
          const left = remainingMs(timer, now);
          const rung = !!timer.rungAt;
          const pct = timer.totalMs > 0 ? Math.max(0, Math.min(100, (left / timer.totalMs) * 100)) : 0;
          return (
            <div
              key={timer.id}
              className={`relative flex min-w-[9rem] items-center gap-2.5 overflow-hidden rounded-xl border px-3 py-2 ${
                rung
                  ? 'border-amber-400/70 bg-amber-400/20 animate-pulse'
                  : 'border-zinc-700 bg-zinc-800/80'
              }`}
            >
              {/* Drains left-to-right — readable at a glance from across the
                  kitchen, where the digits are not. */}
              {!rung && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-500 ease-linear"
                  style={{ width: `${pct}%` }}
                />
              )}
              <span className={`material-symbols-outlined relative text-[18px] ${rung ? 'text-amber-300' : 'text-primary'}`}>
                {rung ? 'notifications_active' : 'timer'}
              </span>
              <span className="relative min-w-0 flex-1">
                <span className="block truncate text-[11px] font-bold uppercase tracking-wide text-zinc-400">
                  {timer.label}
                </span>
                <span className={`block text-sm font-black tabular-nums ${rung ? 'text-amber-200' : 'text-white'}`}>
                  {rung ? t('cookTimer.done') : formatRemaining(left)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => cancelCookTimer(timer.id)}
                aria-label={rung ? t('cookTimer.dismiss') : t('cookTimer.cancel')}
                title={rung ? t('cookTimer.dismiss') : t('cookTimer.cancel')}
                className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
