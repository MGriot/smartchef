import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { apiFetch } from '../lib/api';
import {
  buildTidyProposals, changeFor, defaultSelection, proposalKinds, selectionKey,
  type NutrientKey, type TidyChangeKind, type TidyIngredient, type TidyProposal, type TidySuggestion,
} from '../lib/ingredientTidy';

interface Named { id: string; name: string; translated_name?: string | null }

type Aspect = 'naming' | 'classification' | 'nutrition' | 'synonyms';
const ASPECTS: Aspect[] = ['naming', 'classification', 'nutrition', 'synonyms'];
const ASPECTS_KEY = 'smartchef.ingredients.tidyAspects';

/** The model's names for each nutrient — the same ones the prompt uses
 *  (services/aiTasks.local.ts), sent so it sees what is on file today. */
const NUTRIENT_ALIAS: Record<NutrientKey, string> = {
  caloriesKcal: 'kcal', proteinG: 'protein', carbsG: 'carbs', fatG: 'fat', fiberG: 'fiber', sugarG: 'sugar', sodiumMg: 'sodium',
};
const NUTRIENT_COLUMN: Record<NutrientKey, keyof TidyIngredient> = {
  caloriesKcal: 'calories_kcal', proteinG: 'protein_g', carbsG: 'carbs_g', fatG: 'fat_g',
  fiberG: 'fiber_g', sugarG: 'sugar_g', sodiumMg: 'sodium_mg',
};
const NUTRIENT_LABEL: Record<NutrientKey, string> = {
  caloriesKcal: 'recipeDetail.calories', proteinG: 'recipeDetail.protein', carbsG: 'recipeDetail.carbs',
  fatG: 'recipeDetail.fat', fiberG: 'recipeDetail.fiber', sugarG: 'recipeDetail.sugar', sodiumMg: 'recipeDetail.sodium',
};
const NUTRIENT_UNIT: Record<NutrientKey, string> = {
  caloriesKcal: 'kcal', proteinG: 'g', carbsG: 'g', fatG: 'g', fiberG: 'g', sugarG: 'g', sodiumMg: 'mg',
};

function loadAspects(): Record<Aspect, boolean> {
  const all = { naming: true, classification: true, nutrition: true, synonyms: true };
  try {
    const raw = localStorage.getItem(ASPECTS_KEY);
    if (raw) return { ...all, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  return all;
}

/** "Tidy with AI": asks the configured AI to review each existing
 *  ingredient — its name and translations (correcting wrong ones, not just
 *  filling gaps), its category and tags, its nutrition per 100 g, its
 *  synonyms — shows every proposed change with its own checkbox, and
 *  applies only the ones left ticked. */
export default function IngredientTidyModal({
  open,
  onClose,
  ingredients,
  categories = [],
  tags = [],
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  ingredients: TidyIngredient[];
  categories?: Named[];
  tags?: Named[];
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'intro' | 'analysing' | 'review' | 'applying'>('intro');
  const [aspects, setAspects] = useState<Record<Aspect, boolean>>(loadAspects);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [proposals, setProposals] = useState<TidyProposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const label = (list: Named[], id: string | null | undefined) => {
    const hit = list.find((x) => x.id === id);
    return hit ? hit.translated_name || hit.name : t('library.ingredients.tidyNone');
  };
  const anyAspect = ASPECTS.some((a) => aspects[a]);

  const close = () => {
    if (phase === 'analysing' || phase === 'applying') return;
    setPhase('intro');
    setProposals([]);
    setError(null);
    onClose();
  };

  const setAspect = (aspect: Aspect, value: boolean) => {
    const next = { ...aspects, [aspect]: value };
    setAspects(next);
    try { localStorage.setItem(ASPECTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const analyse = async () => {
    setError(null);
    setPhase('analysing');
    setProgress({ done: 0, total: ingredients.length });
    const asked = ASPECTS.filter((a) => aspects[a]).length;
    // Rows per request — fewer the more is asked of each, so progress
    // keeps moving and a truncated answer only loses one batch.
    const batchSize = asked <= 1 ? 30 : 15;
    const categoryName = (id: string | null | undefined) => categories.find((c) => c.id === id)?.name ?? null;
    const suggestions: TidySuggestion[] = [];
    // A batch the provider still refuses after its own retries is skipped,
    // not fatal: the batches that did come back are reviewed, and a second
    // run picks up what was left.
    let skipped = 0;
    let lastError: Error | null = null;
    try {
      for (let i = 0; i < ingredients.length; i += batchSize) {
        const batch = ingredients.slice(i, i + batchSize);
        try {
          const res = await apiFetch('/api/ingredients/ai-tidy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              aspects,
              items: batch.map((ing) => ({
                key: ing.id,
                text: ing.name,
                known: Object.fromEntries((ing.translations ?? []).map((tr) => [tr.lang, tr.text])),
                category: categoryName(ing.category_id),
                tags: (ing.tags ?? []).map((tg) => tg.name ?? tags.find((x) => x.id === tg.id)?.name).filter(Boolean),
                nutrition: Object.fromEntries((Object.keys(NUTRIENT_ALIAS) as NutrientKey[]).map((k) => [NUTRIENT_ALIAS[k], ing[NUTRIENT_COLUMN[k]] ?? null])),
                synonyms: ing.synonyms ?? [],
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
        setProgress({ done: Math.min(i + batchSize, ingredients.length), total: ingredients.length });
      }
      if (suggestions.length === 0 && lastError) throw lastError;
      if (skipped > 0) setError(t('library.ingredients.tidySkipped', { count: skipped, error: lastError?.message ?? '' }));
      const found = buildTidyProposals(ingredients, suggestions);
      setProposals(found);
      setSelected(defaultSelection(found));
      setPhase('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.ingredients.tidyFailed'));
      setPhase('intro');
    }
  };

  const toApply = useMemo(
    () => proposals.map((p) => ({ p, body: changeFor(p, selected) })).filter((x): x is { p: TidyProposal; body: Record<string, unknown> } => !!x.body),
    [proposals, selected],
  );

  const apply = async () => {
    setPhase('applying');
    setProgress({ done: 0, total: toApply.length });
    setError(null);
    try {
      for (let i = 0; i < toApply.length; i++) {
        const { p, body } = toApply[i];
        const res = await apiFetch(`/api/ingredients/${p.id}/naming`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(typeof json.error === 'string' ? json.error : t('library.ingredients.tidyFailed'));
        }
        setProgress({ done: i + 1, total: toApply.length });
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

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /** Every change of one kind across the list, for the chips that tick or
   *  untick them all at once — 300 ingredients are not reviewed one box at
   *  a time. */
  const kindCounts = useMemo(() => {
    const counts = new Map<TidyChangeKind, number>();
    for (const p of proposals) for (const k of proposalKinds(p)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return counts;
  }, [proposals]);

  const toggleKind = (kind: TidyChangeKind) => {
    const keys = proposals.filter((p) => proposalKinds(p).includes(kind)).map((p) => selectionKey(p.id, kind));
    const allOn = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) { if (allOn) next.delete(k); else next.add(k); }
      return next;
    });
  };

  const describe = (p: TidyProposal, kind: TidyChangeKind): string => {
    switch (kind) {
      case 'name': return t('library.ingredients.tidyRename', { from: p.oldName, to: p.newName });
      case 'parent': return t('import.varietyOf', { name: p.parentName });
      case 'addTranslations': return `+ ${p.addTranslations.map((tr) => `${tr.lang.toUpperCase()} ${tr.text}`).join(' · ')}`;
      case 'fixTranslations': return p.fixTranslations.map((f) => t('library.ingredients.tidyFixTranslation', { lang: f.lang.toUpperCase(), from: f.from, to: f.to })).join(' · ');
      case 'category': return t('library.ingredients.tidyCategory', { from: label(categories, p.category?.fromId), to: label(categories, p.category?.id) });
      case 'addTags': return t('library.ingredients.tidyAddTags', { tags: p.addTagIds.map((id) => label(tags, id)).join(', ') });
      case 'removeTags': return t('library.ingredients.tidyRemoveTags', { tags: p.removeTagIds.map((id) => label(tags, id)).join(', ') });
      case 'nutrition': return `${t('library.ingredients.tidyNutrition')}: ${p.nutrition
        .map((n) => `${t(NUTRIENT_LABEL[n.key])} ${n.from === null ? '—' : n.from} → ${n.to} ${NUTRIENT_UNIT[n.key]}`)
        .join(' · ')}`;
      case 'synonyms': return t('library.ingredients.tidySynonyms', { list: p.addSynonyms.join(', ') });
    }
  };

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
            <button type="button" onClick={analyse} disabled={ingredients.length === 0 || !anyAspect} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {t('library.ingredients.tidyAnalyse', { count: ingredients.length })}
            </button>
          )}
          {(phase === 'review' || phase === 'applying') && (
            <button type="button" onClick={apply} disabled={busy || toApply.length === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {phase === 'applying'
                ? t('library.ingredients.tidyApplying', { done: progress.done, total: progress.total })
                : t('library.ingredients.tidyApply', { count: toApply.length })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {phase === 'intro' && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{t('library.ingredients.tidyIntro')}</p>
            <fieldset className="space-y-2">
              <legend className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">
                {t('library.ingredients.tidyAspects')}
              </legend>
              {ASPECTS.map((aspect) => (
                <label key={aspect} className="flex items-start gap-3 rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 cursor-pointer">
                  <input type="checkbox" className="mt-1 accent-primary" checked={aspects[aspect]} onChange={(e) => setAspect(aspect, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-zinc-800 dark:text-zinc-100">{t(`library.ingredients.tidyAspect.${aspect}`)}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{t(`library.ingredients.tidyAspectHint.${aspect}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
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
          <>
            {/* One chip per kind of change: tick or untick that kind across
                every ingredient at once. */}
            <div className="flex flex-wrap gap-2">
              {[...kindCounts.entries()].map(([kind, count]) => {
                const keys = proposals.filter((p) => proposalKinds(p).includes(kind)).map((p) => selectionKey(p.id, kind));
                const on = keys.filter((k) => selected.has(k)).length;
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={busy}
                    onClick={() => toggleKind(kind)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                      on === count ? 'border-primary/40 bg-primary/10 text-primary'
                        : on === 0 ? 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
                          : 'border-primary/30 text-primary'
                    }`}
                  >
                    {t(`library.ingredients.tidyKind.${kind}`)} {on}/{count}
                  </button>
                );
              })}
            </div>
            <ul className="space-y-2">
              {proposals.map((p) => (
                <li key={p.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 text-sm">
                  <p className="font-bold text-zinc-800 dark:text-zinc-100 break-words">{p.oldName}</p>
                  {p.duplicateOf && (
                    <p className="text-xs text-amber-700">{t('library.ingredients.tidyDuplicate', { name: p.duplicateOf.name })}</p>
                  )}
                  <div className="mt-1.5 space-y-1">
                    {proposalKinds(p).map((kind) => {
                      const key = selectionKey(p.id, kind);
                      const isFix = kind === 'fixTranslations' || kind === 'removeTags' || (kind === 'nutrition' && p.nutrition.some((n) => n.from !== null));
                      return (
                        <label key={kind} className="flex items-start gap-2.5 cursor-pointer">
                          <input type="checkbox" className="mt-0.5 accent-primary" checked={selected.has(key)} disabled={busy} onChange={() => toggle(key)} />
                          <span className={`min-w-0 text-xs break-words ${isFix ? 'text-amber-700 dark:text-amber-500' : 'text-zinc-600 dark:text-zinc-300'}`}>
                            {describe(p, kind)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
