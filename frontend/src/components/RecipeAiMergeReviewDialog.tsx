import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import {
  defaultTicked, itemKey, picksFor,
  type MergeAiGroup, type MergeAiItem, type MergeAiProposal, type MergeAiRecipe,
} from '../lib/recipeMergeAi';

export interface AiMergePicks { sourceId: string; ingredientIds: string[]; stepIds: string[] }

/** The review step of "Merge with AI" over several recipes. The model only
 *  advises (lib/recipeMergeAi.ts): every ingredient and step of the copies
 *  is listed here, the ones it called repeated or out of place start
 *  unticked with its reason, and nothing is carried over or discarded until
 *  the user has looked at the row. Rows left unticked go with the deleted
 *  copy, so the footer says how many that is. */
export default function RecipeAiMergeReviewDialog({
  open, onClose, loading, error, data, applying, onRetry, onApply,
}: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  data: { recipes: MergeAiRecipe[]; proposal: MergeAiProposal } | null;
  applying: boolean;
  onRetry: () => void;
  onApply: (picks: AiMergePicks[]) => void;
}) {
  const { t } = useTranslation();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (data) setTicked(defaultTicked(data.proposal.items));
  }, [data]);

  useEffect(() => {
    if (!open || !loading) { setElapsed(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [open, loading]);

  const items = data?.proposal.items ?? [];
  const flagged = items.filter((it) => it.action !== 'keep').length;
  const leftOut = items.filter((it) => !ticked.has(itemKey(it))).length;

  const byRecipe = useMemo(() => {
    const out: Array<{ index: number; title: string; rows: Record<MergeAiGroup, MergeAiItem[]> }> = [];
    for (let r = 1; r < (data?.recipes.length ?? 0); r++) {
      out.push({
        index: r,
        title: data!.recipes[r].title,
        rows: {
          ingredients: items.filter((it) => it.recipeIndex === r && it.group === 'ingredients'),
          steps: items.filter((it) => it.recipeIndex === r && it.group === 'steps'),
        },
      });
    }
    return out;
  }, [data, items]);

  const toggle = (it: MergeAiItem) => setTicked((prev) => {
    const next = new Set(prev);
    const key = itemKey(it);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const setAll = (on: boolean) => setTicked(on ? new Set(items.map(itemKey)) : new Set());

  const rowLabel = (it: MergeAiItem) => {
    if (it.action === 'duplicate') return t('recipeDetail.aiMergeMany.duplicateOf', { text: it.of?.text ?? '' });
    if (it.action === 'drop') return t('recipeDetail.aiMergeMany.looksOut');
    return null;
  };

  return (
    <Modal
      open={open}
      onClose={applying ? () => {} : onClose}
      size="xl"
      zIndex={130}
      title={t('recipeDetail.aiMergeMany.title')}
      subtitle={data ? t('recipeDetail.aiMergeMany.subtitle', { kept: data.recipes[0].title }) : undefined}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          {error && !loading && (
            <ModalSubmitButton type="button" onClick={onRetry}>{t('recipeDetail.aiMergeMany.retry')}</ModalSubmitButton>
          )}
          {data && (
            <ModalSubmitButton type="button" disabled={applying} onClick={() => onApply(picksFor(data.recipes, items, ticked))}>
              {applying ? t('library.shared.merging') : t('recipeDetail.aiMergeMany.apply', { count: items.length - leftOut })}
            </ModalSubmitButton>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {loading && (
          <p className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 p-4 text-sm font-bold text-zinc-600 dark:text-zinc-300">
            {t('recipeDetail.aiMergeMany.loading')}{elapsed >= 5 ? ` · ${elapsed}s` : ''}
          </p>
        )}
        {error && !loading && <p className="text-sm text-red-600 font-medium">{error}</p>}

        {data && (
          <>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeMany.explain')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setAll(true)} className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-black text-zinc-700 dark:text-zinc-200">
                {t('recipeDetail.aiMergeMany.selectAll')}
              </button>
              <button type="button" onClick={() => setAll(false)} className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-black text-zinc-700 dark:text-zinc-200">
                {t('recipeDetail.aiMergeMany.selectNone')}
              </button>
              <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400">
                {t('recipeDetail.aiMergeMany.counter', { kept: items.length - leftOut, total: items.length, flagged })}
              </span>
            </div>
            {data.proposal.warnings.map((w) => (
              <p key={w} className="rounded-xl bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-200">{w}</p>
            ))}

            {byRecipe.map((rec) => (
              <section key={rec.index} className="rounded-2xl bg-white dark:bg-zinc-950 border border-zinc-100 dark:border-zinc-800 p-4 space-y-4">
                <h3 className="text-sm font-black text-zinc-800 dark:text-zinc-100">{rec.title}</h3>
                {(['ingredients', 'steps'] as const).map((group) => rec.rows[group].length > 0 && (
                  <div key={group} className="space-y-1.5">
                    <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{t(`recipeDetail.aiMergeMany.${group}`)}</p>
                    {rec.rows[group].map((it) => {
                      const on = ticked.has(itemKey(it));
                      const note = rowLabel(it);
                      return (
                        <label
                          key={itemKey(it)}
                          className={`flex items-start gap-3 rounded-xl px-3 py-2 cursor-pointer ${
                            it.action === 'keep' ? 'bg-zinc-50 dark:bg-zinc-900' : 'bg-amber-50 dark:bg-amber-950/30'
                          }`}
                        >
                          <input type="checkbox" checked={on} onChange={() => toggle(it)} className="mt-1 h-4 w-4 shrink-0" />
                          <span className="min-w-0 text-sm text-zinc-800 dark:text-zinc-100">
                            <span className={on ? '' : 'line-through opacity-60'}>{it.text}</span>
                            {note && (
                              <span className="block text-xs font-bold text-amber-700 dark:text-amber-300 break-words">
                                {note}{it.reason ? ` — ${it.reason}` : ''}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </section>
            ))}
            {leftOut > 0 && (
              <p className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiMergeMany.leftOutNote', { count: leftOut })}</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
