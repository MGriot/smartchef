import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import type { CheckChange, CheckGroup, CheckResult } from '../lib/recipeCheck';
import { diffWords } from '../lib/wordDiff';

const GROUPS: CheckGroup[] = ['text', 'ingredients', 'steps', 'fields', 'tags', 'regions'];

/** One side of a git-style diff: a `-`/`+` gutter, the line tinted red or
 *  green, and the exact words that changed painted stronger. */
function DiffLine({ side, before, after }: { side: 'del' | 'add'; before: string; after: string }) {
  const parts = diffWords(before, after).filter((p) => p.type === 'same' || p.type === side);
  const del = side === 'del';
  return (
    <div className={`flex gap-2 px-3 py-1 font-mono text-[13px] leading-relaxed ${del ? 'bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200' : 'bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200'}`}>
      <span aria-hidden className={`select-none font-black ${del ? 'text-red-500' : 'text-green-600'}`}>{del ? '-' : '+'}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">
        {parts.map((p, k) => p.type === 'same'
          ? <span key={k}>{p.text}</span>
          : <mark key={k} className={`rounded-sm px-0.5 ${del ? 'bg-red-200 text-red-950 line-through decoration-red-500/60 dark:bg-red-800/60 dark:text-red-50' : 'bg-green-200 text-green-950 dark:bg-green-800/60 dark:text-green-50'}`}>{p.text}</mark>)}
      </span>
    </div>
  );
}

/** What a change does, as the lines of a diff. A fill has no old value, so it
 *  shows only the green line. */
function diffOf(c: CheckChange): { before: string | null; after: string } | null {
  switch (c.type) {
    case 'textFix': case 'ingredientQty': case 'stepDuration': case 'field': case 'yield':
      return { before: c.before === '—' ? null : c.before, after: c.after };
    default: return null;
  }
}

/** Review step of "Check with AI": every verified change with the recipe's
 *  own words that justify it, ticked by default, applied only on confirm. */
export default function RecipeAiReviewDialog({
  open, onClose, loading, error, result, onApply,
}: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  result: CheckResult | null;
  onApply: (changes: CheckChange[]) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPicked(new Set(result?.changes.map((c) => c.id) ?? []));
  }, [result]);

  const grouped = useMemo(
    () => GROUPS.map((g) => ({ group: g, items: (result?.changes ?? []).filter((c) => c.group === g) })).filter((g) => g.items.length > 0),
    [result],
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const setGroup = (items: CheckChange[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      items.forEach((c) => (on ? next.add(c.id) : next.delete(c.id)));
      return next;
    });

  const describe = (c: CheckChange): string => {
    switch (c.type) {
      case 'textFix': return c.index != null && c.target !== 'ingredientName'
        ? t(`recipeDetail.aiCheck.target.${c.target}`, { n: c.index + 1 })
        : c.target === 'ingredientName' ? t('recipeDetail.aiCheck.target.ingredientName', { n: (c.index ?? 0) + 1 }) : t(`recipeDetail.aiCheck.target.${c.target}`);
      case 'ingredientQty': return `${c.label} — ${t('recipeDetail.aiCheck.quantity')}`;
      case 'stepDuration': return t('recipeDetail.aiCheck.stepDuration', { n: c.index + 1 });
      case 'field': return t(`recipeDetail.aiCheck.field.${c.field}`);
      case 'yield': return t('recipeDetail.aiCheck.field.yield');
      case 'tag': return c.name;
      case 'region': return c.label;
    }
  };

  const chosen = (result?.changes ?? []).filter((c) => picked.has(c.id));
  const empty = !loading && !error && result !== null && result.changes.length === 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('recipeDetail.aiCheck.title')}
      subtitle={t('recipeDetail.aiCheck.subtitle')}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton
            type="button"
            disabled={loading || chosen.length === 0}
            onClick={() => onApply(chosen)}
          >
            {t('recipeDetail.aiCheck.apply', { count: chosen.length })}
          </ModalSubmitButton>
        </>
      }
    >
      {loading && (
        <div className="flex items-center gap-3 py-10 justify-center text-zinc-500 dark:text-zinc-400">
          <span className="material-symbols-outlined animate-spin">progress_activity</span>
          <span className="font-medium">{t('recipeDetail.aiCheck.checking')}</span>
        </div>
      )}
      {error && <p className="text-sm text-red-600 font-medium bg-red-50 rounded-xl px-4 py-3">{error}</p>}
      {empty && <p className="py-8 text-center text-zinc-500 dark:text-zinc-400">{t('recipeDetail.aiCheck.nothingToChange')}</p>}

      <div className="space-y-6">
        {grouped.map(({ group, items }) => (
          <section key={group}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                {t(`recipeDetail.aiCheck.group.${group}`)}
              </h3>
              <button
                type="button"
                className="text-[11px] font-bold text-primary hover:underline"
                onClick={() => setGroup(items, !items.every((c) => picked.has(c.id)))}
              >
                {items.every((c) => picked.has(c.id)) ? t('recipeDetail.aiCheck.selectNone') : t('recipeDetail.aiCheck.selectAll')}
              </button>
            </div>
            <ul className="space-y-2">
              {items.map((c) => (
                <li key={c.id}>
                  <label className="flex gap-3 rounded-2xl border border-zinc-100 dark:border-zinc-800 px-4 py-3 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-primary shrink-0" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="min-w-0">
                      <span className="block font-bold text-sm text-zinc-800 dark:text-zinc-100">
                        {describe(c)}
                        <span className="ml-2 align-middle text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                          {t(`recipeDetail.aiCheck.kind.${c.kind}`)}
                        </span>
                      </span>
                      {(() => {
                        const d = diffOf(c);
                        return d ? (
                          <span className="block mt-2 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
                            {d.before != null && <DiffLine side="del" before={d.before} after={d.after} />}
                            <DiffLine side="add" before={d.before ?? ''} after={d.after} />
                          </span>
                        ) : null;
                      })()}
                      {c.type !== 'textFix' && <span className="block mt-1 text-xs italic text-zinc-500 dark:text-zinc-400">“{c.evidence}”</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {result && (result.warnings.length > 0 || result.unmatched.length > 0) && (
          <section>
            <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">{t('recipeDetail.aiCheck.notes')}</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
              {result.unmatched.length > 0 && (
                <li>{t('recipeDetail.aiCheck.unmatched', { names: result.unmatched.join(', ') })}</li>
              )}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
