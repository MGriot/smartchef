import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import Autocomplete from './Autocomplete';
import { Field } from './Form';
import { apiFetch } from '../lib/api';

/** Folds this recipe into another one — the same recipe saved twice. The
 *  kept recipe's content stays as it is; collections, planned meals, the
 *  cook log and sub-recipe uses move over (see recipes.local.ts's
 *  mergeRecipes). */
export default function RecipeMergeModal({
  open,
  onClose,
  recipeId,
  recipeTitle,
  lang,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  recipeId: string;
  recipeTitle: string;
  lang: string;
  onMerged: (targetId: string) => void;
}) {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState<Array<{ id: string; title: string; translated_title?: string | null }>>([]);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetId('');
    setError(null);
    apiFetch(`/api/recipes${lang ? `?lang=${lang}` : ''}`)
      .then((res) => res.json())
      .then((json) => setRecipes(json.data || []))
      .catch(() => setRecipes([]));
  }, [open, lang]);

  // Memoized: Autocomplete re-syncs its text whenever the options change.
  const options = useMemo(
    () => recipes.filter((r) => r.id !== recipeId).map((r) => ({ id: r.id, label: r.translated_title || r.title })),
    [recipes, recipeId],
  );

  const merge = async () => {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/recipes/${recipeId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.mergeFailed'));
      onMerged(targetId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipeDetail.mergeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="sm"
      zIndex={120}
      title={t('recipeDetail.mergeTitle')}
      subtitle={t('recipeDetail.mergeSubtitle', { title: recipeTitle })}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton type="button" onClick={merge} disabled={!targetId || busy}>
            {busy ? t('library.shared.merging') : t('library.shared.merge')}
          </ModalSubmitButton>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('library.shared.mergeIntoLabel')} hint={t('recipeDetail.mergeHint')}>
          <Autocomplete
            options={options}
            value={targetId || null}
            onSelect={(rid) => setTargetId(rid)}
            onClear={() => setTargetId('')}
            placeholder={t('shopping.searchRecipes')}
            className="sc-field"
          />
        </Field>
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
      </div>
    </Modal>
  );
}
