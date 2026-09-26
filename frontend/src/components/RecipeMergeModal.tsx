import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import Autocomplete from './Autocomplete';
import { Field } from './Form';
import { apiFetch } from '../lib/api';
import { FieldConflict, SECTION_ORDER, sectionOf, type DisplayConflict, type SectionKey, type Side, type SideLabels } from './sync/ConflictResolver';
import type { MergeSide, RecipeMergePreview } from '../services/recipes.local';

/** Folds one recipe into another — the same recipe saved twice. First the
 *  recipe to keep is picked; then the two are compared field by field, and
 *  for every field that differs the user picks which version survives (see
 *  recipes.local.ts's getRecipeMergePreview/mergeRecipes). Collections,
 *  planned meals, the cook log and sub-recipe uses always move over.
 *
 *  In the comparison the kept recipe is the resolver's "local" side and the
 *  duplicate its "remote" side, so the sync conflict card's renderers —
 *  word-level text diffs, aligned steps and ingredients, tag chips —
 *  compare recipes without a second copy of any of them. */
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
  // Which of the two is deleted. Starts as the recipe the modal was opened
  // from; "swap" flips it.
  const [sourceId, setSourceId] = useState(recipeId);
  const [step, setStep] = useState<'pick' | 'compare'>('pick');
  const [preview, setPreview] = useState<RecipeMergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeSide>>({});
  const [showIdentical, setShowIdentical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetId('');
    setSourceId(recipeId);
    setStep('pick');
    setPreview(null);
    setError(null);
    apiFetch(`/api/recipes${lang ? `?lang=${lang}` : ''}`)
      .then((res) => res.json())
      .then((json) => setRecipes(json.data || []))
      .catch(() => setRecipes([]));
  }, [open, lang, recipeId]);

  // Memoized: Autocomplete re-syncs its text whenever the options change.
  const options = useMemo(
    () => recipes.filter((r) => r.id !== recipeId).map((r) => ({ id: r.id, label: r.translated_title || r.title })),
    [recipes, recipeId],
  );

  const keptId = sourceId === recipeId ? targetId : recipeId;

  const loadPreview = async (from: string, into: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/recipes/${from}/merge-preview?targetId=${encodeURIComponent(into)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.mergeFailed'));
      const data = json.data as RecipeMergePreview;
      setPreview(data);
      setChoices(Object.fromEntries(data.fields.filter((f) => !f.equal).map((f) => [f.fieldName, f.defaultSide])));
      setShowIdentical(false);
      setStep('compare');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipeDetail.mergeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const swap = () => {
    if (!preview) return;
    const nextSource = preview.target.id;
    setSourceId(nextSource);
    void loadPreview(nextSource, preview.source.id);
  };

  const merge = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/recipes/${preview.source.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: preview.target.id, choices }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.mergeFailed'));
      onMerged(preview.target.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipeDetail.mergeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const labels: SideLabels = {
    local: t('recipeDetail.mergeCompare.kept'),
    remote: t('recipeDetail.mergeCompare.duplicate'),
    localOnly: t('recipeDetail.mergeCompare.keptOnly'),
    remoteOnly: t('recipeDetail.mergeCompare.duplicateOnly'),
    useLocal: t('recipeDetail.mergeCompare.useKept'),
    useRemote: t('recipeDetail.mergeCompare.useDuplicate'),
  };

  const differing = preview?.fields.filter((f) => !f.equal) ?? [];
  const identical = preview?.fields.filter((f) => f.equal) ?? [];
  const bySection = new Map<SectionKey, typeof differing>();
  for (const f of differing) {
    const key = sectionOf(f.fieldName);
    bySection.set(key, [...(bySection.get(key) ?? []), f]);
  }
  const toConflict = (f: (typeof differing)[number]): DisplayConflict => ({
    id: f.fieldName,
    entityType: 'recipe',
    entityId: preview!.target.id,
    entityName: preview!.target.title,
    fieldName: f.fieldName,
    localValue: f.targetValue,
    remoteValue: f.sourceValue,
    localUpdatedAt: preview!.target.updated_at,
    remoteUpdatedAt: preview!.source.updated_at,
  } as DisplayConflict);
  const sideOf = (choice: MergeSide | undefined): Side | null => (choice === 'target' ? 'local' : choice === 'source' ? 'remote' : null);
  const pickAll = (side: MergeSide) => setChoices(Object.fromEntries(differing.map((f) => [f.fieldName, side])));

  if (step === 'pick') {
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
            <ModalSubmitButton type="button" onClick={() => loadPreview(sourceId, keptId)} disabled={!targetId || busy}>
              {busy ? t('common.loading') : t('recipeDetail.mergeCompare.compare')}
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

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="xl"
      zIndex={120}
      title={t('recipeDetail.mergeCompare.title')}
      subtitle={t('recipeDetail.mergeCompare.subtitle', { count: differing.length })}
      footer={
        <>
          <ModalCancelButton onClick={() => setStep('pick')}>{t('recipeDetail.mergeCompare.back')}</ModalCancelButton>
          <ModalSubmitButton type="button" onClick={merge} disabled={busy || !preview}>
            {busy ? t('library.shared.merging') : t('library.shared.merge')}
          </ModalSubmitButton>
        </>
      }
    >
      {preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="rounded-2xl border border-[#ffd7d5] dark:border-[#f851494d] bg-[#ffebe9] dark:bg-[#f8514926] px-4 py-3 min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#cf222e] dark:text-[#ff7b72]">− {labels.local}</p>
              <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 break-words">{preview.target.title}</p>
            </div>
            <button
              type="button"
              onClick={swap}
              disabled={busy}
              className="justify-self-center inline-flex items-center gap-1 px-3 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-black text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">swap_horiz</span>
              {t('recipeDetail.mergeCompare.swap')}
            </button>
            <div className="rounded-2xl border border-[#ccffd8] dark:border-[#3fb9504d] bg-[#e6ffec] dark:bg-[#2ea04326] px-4 py-3 min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#1a7f37] dark:text-[#56d364]">+ {labels.remote}</p>
              <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 break-words">{preview.source.title}</p>
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('recipeDetail.mergeCompare.explain')}</p>

          {differing.length === 0 ? (
            <p className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 p-4 text-sm font-bold text-zinc-600 dark:text-zinc-300">{t('recipeDetail.mergeCompare.allIdentical')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => pickAll('target')} className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-black text-zinc-700 dark:text-zinc-200">
                <span className="font-mono text-[#cf222e] dark:text-[#ff7b72]">−</span> {t('recipeDetail.mergeCompare.keepAllKept')}
              </button>
              <button type="button" onClick={() => pickAll('source')} className="px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-black text-zinc-700 dark:text-zinc-200">
                <span className="font-mono text-[#1a7f37] dark:text-[#56d364]">+</span> {t('recipeDetail.mergeCompare.keepAllDuplicate')}
              </button>
            </div>
          )}

          {SECTION_ORDER.filter((key) => bySection.has(key)).map((key) => (
            <section key={key} className="rounded-2xl bg-white dark:bg-zinc-950 border border-zinc-100 dark:border-zinc-800 p-4 space-y-5">
              <h3 className="text-sm font-black text-zinc-800 dark:text-zinc-100">{t(`account.conflicts.sections.${key}`)}</h3>
              {bySection.get(key)!.map((f) => (
                <FieldConflict
                  key={f.fieldName}
                  conflict={toConflict(f)}
                  labels={labels}
                  selected={sideOf(choices[f.fieldName])}
                  onResolve={(side) => setChoices((c) => ({ ...c, [f.fieldName]: side === 'local' ? 'target' : 'source' }))}
                >
                  {f.canKeepBoth && (
                    <button
                      type="button"
                      aria-pressed={choices[f.fieldName] === 'both'}
                      onClick={() => setChoices((c) => ({ ...c, [f.fieldName]: 'both' }))}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-black ${
                        choices[f.fieldName] === 'both'
                          ? 'bg-primary text-white'
                          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">{choices[f.fieldName] === 'both' ? 'check_circle' : 'call_merge'}</span>
                      {t('recipeDetail.mergeCompare.keepBoth')}
                    </button>
                  )}
                </FieldConflict>
              ))}
            </section>
          ))}

          {identical.length > 0 && (
            <div className="rounded-2xl bg-zinc-50 dark:bg-zinc-900 px-4 py-3">
              <button type="button" onClick={() => setShowIdentical((v) => !v)} className="flex w-full items-center justify-between text-xs font-bold text-zinc-500 dark:text-zinc-400">
                {t('recipeDetail.mergeCompare.identicalFields', { count: identical.length })}
                <span className="material-symbols-outlined text-[18px]">{showIdentical ? 'expand_less' : 'expand_more'}</span>
              </button>
              {showIdentical && (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {identical.map((f) => t(`account.conflicts.fields.${f.fieldName}`, { defaultValue: f.fieldName.replace(/_/g, ' ') })).join(' · ')}
                </p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
