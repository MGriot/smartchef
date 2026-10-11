import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import type { CheckChange, CheckGroup, CheckResult } from '../lib/recipeCheck';
import type { MismatchSide } from '../lib/recipeMismatchFix';
import { diffWords } from '../lib/wordDiff';

const GROUPS: CheckGroup[] = ['text', 'ingredients', 'steps', 'links', 'fields', 'tags', 'regions'];

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
    case 'textFix': case 'ingredientQty': case 'stepDuration': case 'field': case 'yield': case 'stepRewrite':
      return { before: c.before === '—' ? null : c.before, after: c.after };
    case 'ingredientAdd': return c.after ? { before: null, after: `${c.name} — ${c.after}` } : { before: null, after: c.name };
    default: return null;
  }
}

/** Review step of "Check with AI": every verified change with the recipe's
 *  own words that justify it, ticked by default, applied only on confirm. */
export default function RecipeAiReviewDialog({
  open, onClose, loading, error, result, onApply, onResolveMismatch, onDismissMismatch,
}: {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  result: CheckResult | null;
  onApply: (changes: CheckChange[]) => void;
  /** The user chose which side of an ingredient/steps mismatch to believe.
   *  Resolves with how many verified changes came back (0 = nothing to do). */
  onResolveMismatch?: (side: MismatchSide) => Promise<number>;
  onDismissMismatch?: () => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [resolving, setResolving] = useState(false);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  // Changes the dialog has already offered. A new result ticks everything; a
  // result that only gained changes (the mismatch fix) ticks just the new
  // ones, so what the user unticked stays unticked.
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const ids = result?.changes.map((c) => c.id) ?? [];
    if (!result) { seen.current = new Set(); setPicked(new Set()); setResolveNote(null); return; }
    const fresh = ids.filter((i) => !seen.current.has(i));
    fresh.forEach((i) => seen.current.add(i));
    setPicked((prev) => new Set([...[...prev].filter((i) => ids.includes(i)), ...fresh]));
  }, [result]);

  const resolve = async (side: MismatchSide) => {
    if (!onResolveMismatch) return;
    setResolving(true);
    setResolveNote(null);
    try {
      const count = await onResolveMismatch(side);
      if (count === 0) setResolveNote(t('recipeDetail.aiCheck.mismatch.nothing'));
    } catch (err) {
      setResolveNote(err instanceof Error ? err.message : t('recipeDetail.aiCheck.mismatch.error'));
    } finally {
      setResolving(false);
    }
  };

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
      case 'link': return t('recipeDetail.aiCheck.link', { n: c.index + 1, from: c.from, label: c.label });
      case 'ingredientAdd': return t('recipeDetail.aiCheck.ingredientAdd', { name: c.name });
      case 'ingredientRemove': return t('recipeDetail.aiCheck.ingredientRemove', { label: c.label });
      case 'stepRewrite': return t('recipeDetail.aiCheck.stepRewrite', { n: c.index + 1 });
      case 'stepRemove': return t('recipeDetail.aiCheck.stepRemove', { n: c.index + 1 });
    }
  };

  const chosen = (result?.changes ?? []).filter((c) => picked.has(c.id));
  const empty = !loading && !error && result !== null && result.changes.length === 0 && !result.mismatch;

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
        {result?.mismatch && (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30 px-4 py-4 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-black text-amber-900 dark:text-amber-200">
              <span aria-hidden className="material-symbols-outlined text-[18px]">difference</span>
              {t('recipeDetail.aiCheck.mismatch.title')}
            </h3>
            {result.mismatch.summary && <p className="text-sm text-amber-900/90 dark:text-amber-100/90">{result.mismatch.summary}</p>}
            <div className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <p className="text-[11px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-300">{t('recipeDetail.aiCheck.mismatch.stepsSay')}</p>
                <ul className="mt-1 list-disc pl-5 space-y-0.5 text-zinc-700 dark:text-zinc-200">
                  {result.mismatch.unlisted.map((u) => <li key={u.name}>{u.name}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-300">{t('recipeDetail.aiCheck.mismatch.listUnused')}</p>
                {result.mismatch.unused.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 space-y-0.5 text-zinc-700 dark:text-zinc-200">
                    {result.mismatch.unused.map((u) => <li key={u.index}>{u.label}</li>)}
                  </ul>
                ) : <p className="mt-1 text-zinc-500 dark:text-zinc-400">—</p>}
              </div>
            </div>
            <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{t('recipeDetail.aiCheck.mismatch.question')}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={resolving} onClick={() => resolve('steps')}
                className="flex-1 min-w-[12rem] rounded-xl bg-primary text-white px-4 py-2.5 text-left disabled:opacity-60">
                <span className="block text-sm font-black">{t('recipeDetail.aiCheck.mismatch.followSteps')}</span>
                <span className="block text-xs opacity-90">{t('recipeDetail.aiCheck.mismatch.followStepsHint')}</span>
              </button>
              <button type="button" disabled={resolving} onClick={() => resolve('ingredients')}
                className="flex-1 min-w-[12rem] rounded-xl bg-primary text-white px-4 py-2.5 text-left disabled:opacity-60">
                <span className="block text-sm font-black">{t('recipeDetail.aiCheck.mismatch.followIngredients')}</span>
                <span className="block text-xs opacity-90">{t('recipeDetail.aiCheck.mismatch.followIngredientsHint')}</span>
              </button>
              <button type="button" disabled={resolving} onClick={() => onDismissMismatch?.()}
                className="rounded-xl border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 text-sm font-bold text-zinc-700 dark:text-zinc-200 disabled:opacity-60">
                {t('recipeDetail.aiCheck.mismatch.ignore')}
              </button>
            </div>
            {resolving && (
              <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
                {t('recipeDetail.aiCheck.mismatch.resolving')}
              </p>
            )}
            {resolveNote && <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{resolveNote}</p>}
          </section>
        )}
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
                        {c.type === 'ingredientAdd' && c.estimated && (
                          <span className="ml-1 align-middle text-[10px] font-black uppercase tracking-wider rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                            {t('recipeDetail.aiCheck.estimated')}
                          </span>
                        )}
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
                      {c.type !== 'textFix' && c.evidence && <span className="block mt-1 text-xs italic text-zinc-500 dark:text-zinc-400">“{c.evidence}”</span>}
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
