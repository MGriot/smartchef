import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import type { CheckChange, CheckGroup, CheckResult } from '../lib/recipeCheck';

const GROUPS: CheckGroup[] = ['ingredients', 'steps', 'fields', 'tags', 'regions'];

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

  const describe = (c: CheckChange): string => {
    switch (c.type) {
      case 'ingredientQty': return `${c.label}: ${c.before} → ${c.after}`;
      case 'stepDuration': return t('recipeDetail.aiCheck.stepDuration', { n: c.index + 1, before: c.before, after: c.after });
      case 'stepLinks': {
        const parts = [
          ...(c.added.ingredients.length ? [`${t('recipeDetail.aiCheck.ingredients')}: ${c.added.ingredients.join(', ')}`] : []),
          ...(c.added.tools.length ? [`${t('recipeDetail.aiCheck.tools')}: ${c.added.tools.join(', ')}`] : []),
          ...(c.added.techniques.length ? [`${t('recipeDetail.aiCheck.techniques')}: ${c.added.techniques.join(', ')}`] : []),
        ];
        return `${t('recipeDetail.aiCheck.step', { n: c.index + 1 })} — ${parts.join(' · ')}`;
      }
      case 'field': return `${t(`recipeDetail.aiCheck.field.${c.field}`)}: ${c.before} → ${c.after}`;
      case 'yield': return `${t('recipeDetail.aiCheck.field.yield')}: ${c.before} → ${c.after}`;
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
            <h3 className="text-xs font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">
              {t(`recipeDetail.aiCheck.group.${group}`)}
            </h3>
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
                      <span className="block mt-1 text-xs italic text-zinc-500 dark:text-zinc-400">“{c.evidence}”</span>
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
