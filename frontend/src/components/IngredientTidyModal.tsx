import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { apiFetch } from '../lib/api';
import { buildTidyProposals, type TidyIngredient, type TidyProposal, type TidySuggestion } from '../lib/ingredientTidy';

/** Rows per AI request — small enough that progress moves visibly and a
 *  truncated answer only loses one batch. */
const BATCH = 30;

/** "Tidy names with AI": asks the configured AI how each existing
 *  ingredient should be named under the catalog convention (English base
 *  name, general → specific → variation parents, a name per language),
 *  shows the differences, and applies only the ones left ticked. */
export default function IngredientTidyModal({
  open,
  onClose,
  ingredients,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  ingredients: TidyIngredient[];
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'intro' | 'analysing' | 'review' | 'applying'>('intro');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [proposals, setProposals] = useState<TidyProposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (phase === 'analysing' || phase === 'applying') return;
    setPhase('intro');
    setProposals([]);
    setError(null);
    onClose();
  };

  const analyse = async () => {
    setError(null);
    setPhase('analysing');
    setProgress({ done: 0, total: ingredients.length });
    const suggestions: TidySuggestion[] = [];
    // A batch the provider still refuses after its own retries is skipped,
    // not fatal: the batches that did come back are reviewed, and a second
    // run picks up what was left.
    let skipped = 0;
    let lastError: Error | null = null;
    try {
      for (let i = 0; i < ingredients.length; i += BATCH) {
        const batch = ingredients.slice(i, i + BATCH);
        try {
          const res = await apiFetch('/api/ingredients/ai-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: batch.map((ing) => ({
                key: ing.id,
                text: ing.name,
                known: Object.fromEntries((ing.translations ?? []).map((tr) => [tr.lang, tr.text])),
              })),
            }),
            timeoutMs: 650_000,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('library.ingredients.tidyFailed'));
          suggestions.push(...(json.data as TidySuggestion[]));
        } catch (err) {
          skipped += batch.length;
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        setProgress({ done: Math.min(i + BATCH, ingredients.length), total: ingredients.length });
      }
      if (suggestions.length === 0 && lastError) throw lastError;
      if (skipped > 0) setError(t('library.ingredients.tidySkipped', { count: skipped, error: lastError?.message ?? '' }));
      const found = buildTidyProposals(ingredients, suggestions);
      setProposals(found);
      setSelected(new Set(found.filter((p) => !p.duplicateOf || p.parentId).map((p) => p.id)));
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.ingredients.tidyFailed'));
      setPhase('intro');
    }
  };

  const apply = async () => {
    const chosen = proposals.filter((p) => selected.has(p.id));
    setPhase('applying');
    setProgress({ done: 0, total: chosen.length });
    setError(null);
    try {
      for (let i = 0; i < chosen.length; i++) {
        const p = chosen[i];
        const res = await apiFetch(`/api/ingredients/${p.id}/naming`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: p.newName,
            parentIngredientId: p.parentId,
            translations: p.addTranslations,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(typeof json.error === 'string' ? json.error : t('library.ingredients.tidyFailed'));
        }
        setProgress({ done: i + 1, total: chosen.length });
      }
      onApplied();
      setPhase('intro');
      setProposals([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.ingredients.tidyFailed'));
      setPhase('review');
    }
  };

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const busy = phase === 'analysing' || phase === 'applying';

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      closeOnBackdrop={!busy}
      title={t('library.ingredients.tidyTitle')}
      subtitle={t('library.ingredients.tidySubtitle')}
      footer={
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          {phase === 'intro' && (
            <button type="button" onClick={analyse} disabled={ingredients.length === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {t('library.ingredients.tidyAnalyse', { count: ingredients.length })}
            </button>
          )}
          {(phase === 'review' || phase === 'applying') && (
            <button type="button" onClick={apply} disabled={busy || selected.size === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {phase === 'applying'
                ? t('library.ingredients.tidyApplying', { done: progress.done, total: progress.total })
                : t('library.ingredients.tidyApply', { count: selected.size })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {phase === 'intro' && (
          <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{t('library.ingredients.tidyIntro')}</p>
        )}
        {phase === 'analysing' && (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {t('library.ingredients.tidyAnalysing', { done: progress.done, total: progress.total })}
          </p>
        )}
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        {(phase === 'review' || phase === 'applying') && proposals.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('library.ingredients.tidyNothing')}</p>
        )}
        {(phase === 'review' || phase === 'applying') && proposals.length > 0 && (
          <ul className="space-y-2">
            {proposals.map((p) => (
              <li key={p.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={selected.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
                  <div className="min-w-0 text-sm">
                    <p className="font-bold text-zinc-800 dark:text-zinc-100 break-words">
                      {p.newName ? <>{p.oldName} <span className="text-zinc-400">→</span> {p.newName}</> : p.oldName}
                    </p>
                    {p.duplicateOf && (
                      <p className="text-xs text-amber-700">{t('library.ingredients.tidyDuplicate', { name: p.duplicateOf.name })}</p>
                    )}
                    {p.parentName && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('import.varietyOf', { name: p.parentName })}</p>
                    )}
                    {p.addTranslations.length > 0 && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 break-words">
                        + {p.addTranslations.map((tr) => `${tr.lang.toUpperCase()} ${tr.text}`).join(' · ')}
                      </p>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
