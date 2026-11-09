import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import Autocomplete from './Autocomplete';
import { Field } from './Form';
import RecipeAiMergeReviewDialog, { type AiMergePicks } from './RecipeAiMergeReviewDialog';
import { apiFetch } from '../lib/api';
import type { MergeAiProposal, MergeAiRecipe } from '../lib/recipeMergeAi';
import { FieldConflict, SECTION_ORDER, sectionOf, type DisplayConflict, type SectionKey, type Side, type SideLabels } from './sync/ConflictResolver';
import type { MergeSide, RecipeMergePreview } from '../services/recipes.local';

type Choices = Record<string, MergeSide>;

/** Folds one or more saved copies of a recipe into the one to keep.
 *
 *  First the recipes are picked and the one to keep is chosen. Then either
 *  every copy is compared with the kept recipe field by field, one after the
 *  other, and for every field that differs the user picks which version
 *  survives (recipes.local.ts's getRecipeMergePreview/mergeRecipesMany) — or
 *  "Merge with AI" has the model flag which ingredients and steps repeat the
 *  kept recipe, and the user ticks each one (RecipeAiMergeReviewDialog). The
 *  AI only advises: nothing is dropped without being shown first.
 *  Collections, planned meals, the cook log and sub-recipe uses always move over.
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
  // Every recipe in the merge, the one the modal was opened from first.
  const [picked, setPicked] = useState<string[]>([recipeId]);
  const [keptId, setKeptId] = useState(recipeId);
  const [step, setStep] = useState<'pick' | 'compare'>('pick');
  const [previews, setPreviews] = useState<RecipeMergePreview[]>([]);
  const [current, setCurrent] = useState(0);
  // Per duplicate (by id): the field -> side picks.
  const [choices, setChoices] = useState<Record<string, Choices>>({});
  const [showIdentical, setShowIdentical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aiOpen, setAiOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiData, setAiData] = useState<{ recipes: MergeAiRecipe[]; proposal: MergeAiProposal } | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked([recipeId]);
    setKeptId(recipeId);
    setStep('pick');
    setPreviews([]);
    setChoices({});
    setCurrent(0);
    setError(null);
    setAiOpen(false);
    setAiData(null);
    setAiError(null);
    apiFetch(`/api/recipes${lang ? `?lang=${lang}` : ''}`)
      .then((res) => res.json())
      .then((json) => setRecipes(json.data || []))
      .catch(() => setRecipes([]));
  }, [open, lang, recipeId]);

  const titleOf = (id: string) => {
    const r = recipes.find((x) => x.id === id);
    return r ? r.translated_title || r.title : id === recipeId ? recipeTitle : id;
  };

  // Memoized: Autocomplete re-syncs its text whenever the options change.
  const options = useMemo(
    () => recipes.filter((r) => !picked.includes(r.id)).map((r) => ({ id: r.id, label: r.translated_title || r.title })),
    [recipes, picked],
  );

  const duplicates = picked.filter((id) => id !== keptId);

  const loadPreviews = async (kept: string, sources: string[], at = 0) => {
    setBusy(true);
    setError(null);
    try {
      const loaded = await Promise.all(sources.map(async (from) => {
        const res = await apiFetch(`/api/recipes/${from}/merge-preview?targetId=${encodeURIComponent(kept)}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.mergeFailed'));
        return json.data as RecipeMergePreview;
      }));
      setPreviews(loaded);
      setChoices(Object.fromEntries(loaded.map((p) => [
        p.source.id,
        Object.fromEntries(p.fields.filter((f) => !f.equal).map((f) => [f.fieldName, f.defaultSide])),
      ])));
      setCurrent(at);
      setShowIdentical(false);
      setStep('compare');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('recipeDetail.mergeFailed'));
    } finally {
      setBusy(false);
    }
  };

  // The duplicate on screen becomes the recipe to keep, and the kept one a duplicate.
  const swap = () => {
    const preview = previews[current];
    if (!preview) return;
    const nextKept = preview.source.id;
    setKeptId(nextKept);
    void loadPreviews(nextKept, picked.filter((id) => id !== nextKept), 0);
  };

  const postMerge = async (sources: Array<Record<string, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/recipes/${keptId}/merge-many`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources }),
        timeoutMs: 60_000,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.mergeFailed'));
      onMerged(keptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('recipeDetail.mergeFailed');
      setError(message);
      setAiError(message);
    } finally {
      setBusy(false);
    }
  };

  const merge = () => postMerge(previews.map((p) => ({ id: p.source.id, choices: choices[p.source.id] ?? {} })));

  const runAi = async () => {
    setAiOpen(true);
    setAiLoading(true);
    setAiError(null);
    setAiData(null);
    try {
      const res = await apiFetch('/api/recipes/ai-merge-many', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keptId, otherIds: duplicates, lang }),
        timeoutMs: 300_000,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('recipeDetail.aiMergeMany.failed'));
      setAiData(json.data);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('recipeDetail.aiMergeMany.failed'));
    } finally {
      setAiLoading(false);
    }
  };

  const applyAi = (picks: AiMergePicks[]) =>
    postMerge(picks.map((p) => ({ id: p.sourceId, picks: { ingredientIds: p.ingredientIds, stepIds: p.stepIds } })));

  const labels: SideLabels = {
    local: t('recipeDetail.mergeCompare.kept'),
    remote: t('recipeDetail.mergeCompare.duplicate'),
    localOnly: t('recipeDetail.mergeCompare.keptOnly'),
    remoteOnly: t('recipeDetail.mergeCompare.duplicateOnly'),
    useLocal: t('recipeDetail.mergeCompare.useKept'),
    useRemote: t('recipeDetail.mergeCompare.useDuplicate'),
  };

  const preview = previews[current] ?? null;
  const mine: Choices = (preview && choices[preview.source.id]) || {};
  const setMine = (update: (c: Choices) => Choices) =>
    preview && setChoices((all) => ({ ...all, [preview.source.id]: update(all[preview.source.id] ?? {}) }));
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
  const pickAll = (side: MergeSide) => setMine(() => Object.fromEntries(differing.map((f) => [f.fieldName, side])));
  const isLast = current >= previews.length - 1;

  if (step === 'pick') {
    return (
      <>
        <Modal
          open={open && !aiOpen}
          onClose={busy ? () => {} : onClose}
          size="sm"
          zIndex={120}
          title={t('recipeDetail.mergeTitle')}
          subtitle={t('recipeDetail.mergeSubtitle', { title: recipeTitle })}
          footer={
            <>
              <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
              <button
                type="button"
                onClick={runAi}
                disabled={duplicates.length === 0 || busy}
                className="inline-flex items-center gap-1 px-4 py-2 rounded-full bg-zinc-100 dark:bg-zinc-800 text-sm font-black text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">call_merge</span>
                {t('recipeDetail.mergeMulti.withAi')}
              </button>
              <ModalSubmitButton type="button" onClick={() => loadPreviews(keptId, duplicates)} disabled={duplicates.length === 0 || busy}>
                {busy ? t('common.loading') : t('recipeDetail.mergeCompare.compare')}
              </ModalSubmitButton>
            </>
          }
        >
          <div className="space-y-4">
            <Field label={t('recipeDetail.mergeMulti.addLabel')} hint={t('recipeDetail.mergeMulti.hint')}>
              <Autocomplete
                key={picked.length}
                options={options}
                value={null}
                onSelect={(rid) => setPicked((p) => (p.includes(rid) ? p : [...p, rid]))}
                onClear={() => {}}
                placeholder={t('shopping.searchRecipes')}
                className="sc-field"
              />
            </Field>
            <ul className="space-y-2">
              {picked.map((id) => (
                <li key={id} className="flex items-center gap-2 rounded-2xl bg-zinc-50 dark:bg-zinc-900 px-3 py-2">
                  <button
                    type="button"
                    aria-pressed={keptId === id}
                    onClick={() => setKeptId(id)}
                    className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                      keptId === id ? 'bg-primary text-white' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    }`}
                  >
                    {keptId === id ? t('recipeDetail.mergeMulti.keeping') : t('recipeDetail.mergeMulti.keepThis')}
                  </button>
                  <span className="min-w-0 flex-1 text-sm font-bold text-zinc-800 dark:text-zinc-100 break-words">{titleOf(id)}</span>
                  {id !== recipeId && (
                    <button
                      type="button"
                      aria-label={t('recipeDetail.mergeMulti.removeFromMerge')}
                      onClick={() => {
                        setPicked((p) => p.filter((x) => x !== id));
                        if (keptId === id) setKeptId(recipeId);
                      }}
                      className="shrink-0 text-zinc-400 hover:text-red-600 text-lg leading-none"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
          </div>
        </Modal>
        <RecipeAiMergeReviewDialog
          open={open && aiOpen}
          onClose={() => setAiOpen(false)}
          loading={aiLoading}
          error={aiError}
          data={aiData}
          applying={busy}
          onRetry={runAi}
          onApply={applyAi}
        />
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="xl"
      zIndex={120}
      title={t('recipeDetail.mergeCompare.title')}
      subtitle={
        previews.length > 1
          ? t('recipeDetail.mergeMulti.progress', { current: current + 1, total: previews.length })
          : t('recipeDetail.mergeCompare.subtitle', { count: differing.length })
      }
      footer={
        <>
          <ModalCancelButton onClick={() => (current > 0 ? (setCurrent(current - 1), setShowIdentical(false)) : setStep('pick'))}>
            {t('recipeDetail.mergeCompare.back')}
          </ModalCancelButton>
          {isLast ? (
            <ModalSubmitButton type="button" onClick={merge} disabled={busy || !preview}>
              {busy ? t('library.shared.merging') : t('library.shared.merge')}
            </ModalSubmitButton>
          ) : (
            <ModalSubmitButton type="button" onClick={() => (setCurrent(current + 1), setShowIdentical(false))} disabled={busy}>
              {t('recipeDetail.mergeMulti.next')}
            </ModalSubmitButton>
          )}
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
                  key={`${preview.source.id}:${f.fieldName}`}
                  conflict={toConflict(f)}
                  labels={labels}
                  selected={sideOf(mine[f.fieldName])}
                  onResolve={(side) => setMine((c) => ({ ...c, [f.fieldName]: side === 'local' ? 'target' : 'source' }))}
                >
                  {f.canKeepBoth && (
                    <button
                      type="button"
                      aria-pressed={mine[f.fieldName] === 'both'}
                      onClick={() => setMine((c) => ({ ...c, [f.fieldName]: 'both' }))}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-black ${
                        mine[f.fieldName] === 'both'
                          ? 'bg-primary text-white'
                          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">{mine[f.fieldName] === 'both' ? 'check_circle' : 'call_merge'}</span>
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
