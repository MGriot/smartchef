import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { apiFetch } from '../lib/api';
import { languageLabel } from '../lib/languages';
import { findDuplicateIngredients, type DuplicateCandidate } from '../lib/ingredientDuplicates';

/** "Merge duplicates": the same ingredient catalogued twice — "Sale" next
 *  to "Salt", or "Water" twice — found without any AI (see
 *  lib/ingredientDuplicates.ts), reviewed, and folded together with the
 *  same merge the per-ingredient Merge button uses. */
export default function DuplicateMergeModal({
  open,
  onClose,
  ingredients,
  lang,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  ingredients: DuplicateCandidate[];
  lang: string;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const proposals = useMemo(() => (open ? findDuplicateIngredients(ingredients, lang) : []), [open, ingredients, lang]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const chosen = selected ?? new Set(proposals.filter((p) => p.recommended).map((p) => p.sourceId));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setSelected(null);
    setError(null);
    onClose();
  };

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const apply = async () => {
    const todo = proposals.filter((p) => chosen.has(p.sourceId));
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: todo.length });
    try {
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i];
        const res = await apiFetch(`/api/ingredients/${p.sourceId}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: p.targetId }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(typeof json.error === 'string' ? json.error : t('library.ingredients.mergeFailed', { error: res.status }));
        }
        setProgress({ done: i + 1, total: todo.length });
      }
      setSelected(null);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onApplied();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      closeOnBackdrop={!busy}
      title={t('library.ingredients.dupTitle')}
      subtitle={t('library.ingredients.dupSubtitle')}
      footer={
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          {proposals.length > 0 && (
            <button type="button" onClick={apply} disabled={busy || chosen.size === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {busy
                ? t('library.ingredients.tidyApplying', { done: progress.done, total: progress.total })
                : t('library.ingredients.dupApply', { count: chosen.size })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {proposals.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('library.ingredients.dupNone')}</p>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{t('library.ingredients.dupIntro')}</p>
        )}
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.sourceId} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={chosen.has(p.sourceId)} disabled={busy} onChange={() => toggle(p.sourceId)} />
                <div className="min-w-0 text-sm">
                  <p className="font-bold text-zinc-800 dark:text-zinc-100 break-words">
                    {p.sourceName} <span className="text-zinc-400">→</span> {p.targetName}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {p.reason === 'same-name'
                      ? t('library.ingredients.dupSameName')
                      : t('library.ingredients.dupTranslation', { lang: languageLabel(p.lang ?? '') })}
                  </p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
