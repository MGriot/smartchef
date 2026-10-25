import type React from 'react';
import { useTranslation } from 'react-i18next';
import AutoTextarea from './AutoTextarea';
import MarkdownHint from './MarkdownHint';
import RenderStepText, { type StepTextIngredientCtx, type StepTextTechniqueCtx, type StepTextToolCtx } from './RenderStepText';
import { entryFor, withField, type TrField, type TranslatableDraft } from '../lib/recipeTranslationDraft';

type Draft = TranslatableDraft & {
  ingredients?: Array<NonNullable<TranslatableDraft['ingredients']>[number] & { ingredientName?: string | null; subRecipeTitle?: string | null }>;
};

const INPUT = 'w-full border-none bg-zinc-50 dark:bg-zinc-800/60 rounded-xl p-3 text-sm resize-none focus:ring-2 focus:ring-primary/20';

const rowLabel = (row: object) => {
  const r = row as { ingredientName?: string | null; subRecipeTitle?: string | null };
  return r.ingredientName || r.subRecipeTitle || '';
};

/** One translatable field: its label, the original above, the translation
 *  below. At module level so typing doesn't remount (and blur) the input. */
function Field({ label, original, value, onValue, placeholder, multiline = true, preview, markdown = false }: {
  label: string; original: string | null | undefined; value: string | undefined; onValue: (v: string) => void;
  placeholder: string; multiline?: boolean; preview?: React.ReactNode; markdown?: boolean;
}) {
  const { t } = useTranslation();
  const missing = !!original?.trim() && !value?.trim();
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
        {missing && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">{t('recipeDetail.editLang.missing')}</span>
        )}
      </span>
      {original?.trim() && (
        <span className="mb-1.5 block rounded-lg border-l-2 border-zinc-200 dark:border-zinc-700 pl-3 text-xs italic text-zinc-400 dark:text-zinc-500">
          {preview ?? original}
        </span>
      )}
      {multiline ? (
        <AutoTextarea value={value ?? ''} onChange={(e) => onValue(e.target.value)} className={`${INPUT} min-h-[70px] max-h-[50vh] overflow-y-auto`} placeholder={placeholder} />
      ) : (
        <input type="text" value={value ?? ''} onChange={(e) => onValue(e.target.value)} className={INPUT} placeholder={placeholder} />
      )}
      {markdown && <MarkdownHint />}
    </label>
  );
}

/**
 * The editor in translation mode: every translatable field of the recipe,
 * each with the original above it, for ONE language. Amounts, units, tools
 * and times have no translation and aren't shown — they are the same in
 * every language and stay editable in the original.
 */
export default function RecipeTranslationPanel<T extends Draft>({
  draft, lang, langLabel, onChange, stepIngredients, stepTools, stepTechniques,
}: {
  draft: T;
  lang: string;
  langLabel: string;
  onChange: (next: T) => void;
  stepIngredients: StepTextIngredientCtx[];
  stepTools: StepTextToolCtx[];
  stepTechniques: StepTextTechniqueCtx[];
}) {
  const { t } = useTranslation();
  const card = 'bg-white dark:bg-zinc-900 rounded-3xl p-6 sm:p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)] space-y-6';
  const setRecipe = (field: TrField, v: string) => onChange(withField(draft, lang, field, v));
  const setStep = (n: number, field: TrField, v: string) =>
    onChange({ ...draft, steps: (draft.steps ?? []).map((s, i) => (i === n ? withField(s, lang, field, v) : s)) });
  const setIngredient = (n: number, v: string) =>
    onChange({ ...draft, ingredients: (draft.ingredients ?? []).map((row, i) => (i === n ? withField(row, lang, 'notes', v) : row)) });

  const recipeTr = entryFor(draft, lang);
  const ingredientRows = (draft.ingredients ?? []).map((row, n) => ({ row, n })).filter(({ row }) => row.notes?.trim() || entryFor(row, lang)?.notes);

  return (
    <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('recipeDetail.editLang.panelHint', { lang: langLabel })}</p>

      <section className={card}>
        <Field placeholder={langLabel} label={t('recipeDetail.recipeTitle')} original={draft.title} value={recipeTr?.title} onValue={(v) => setRecipe('title', v.replace(/\n/g, ' '))} multiline={false} />
        <Field placeholder={langLabel} label={t('recipeDetail.description')} original={draft.description} value={recipeTr?.description} onValue={(v) => setRecipe('description', v)} markdown />
      </section>

      {ingredientRows.length > 0 && (
        <section className={card}>
          <h3 className="font-headline font-bold text-lg">{t('recipeDetail.editLang.ingredientNotes')}</h3>
          {ingredientRows.map(({ row, n }) => (
            <Field
              placeholder={langLabel}
              key={n}
              label={rowLabel(row) || `#${n + 1}`}
              original={row.notes}
              value={entryFor(row, lang)?.notes}
              onValue={(v) => setIngredient(n, v)}
              multiline={false}
            />
          ))}
        </section>
      )}

      {(draft.steps ?? []).length > 0 && (
        <section className={card}>
          <h3 className="font-headline font-bold text-lg">{t('recipeDetail.steps')}</h3>
          {(draft.steps ?? []).map((step, n) => {
            const tr = entryFor(step, lang);
            return (
              <div key={n} className="space-y-3 border-t border-zinc-100 dark:border-zinc-800 pt-5 first:border-0 first:pt-0">
                <p className="text-xs font-black text-primary">{t('recipeDetail.stepNumber', { number: n + 1 })}</p>
                {(step.title?.trim() || tr?.title) && (
                  <Field placeholder={langLabel} label={t('common.title')} original={step.title} value={tr?.title} onValue={(v) => setStep(n, 'title', v)} multiline={false} />
                )}
                <Field
                  placeholder={langLabel}
                  label={t('recipeDetail.editLang.stepText')}
                  original={step.description}
                  preview={<RenderStepText text={step.description ?? ''} ingredients={stepIngredients} tools={stepTools} techniques={stepTechniques} />}
                  value={tr?.description}
                  onValue={(v) => setStep(n, 'description', v)}
                  markdown
                />
                {step.description?.includes('{{') && !tr?.description && (
                  <button type="button" onClick={() => setStep(n, 'description', step.description ?? '')} className="text-[11px] font-bold text-primary hover:underline">
                    {t('recipeDetail.editLang.copyOriginal')}
                  </button>
                )}
                {(step.notes?.trim() || tr?.notes) && (
                  <Field placeholder={langLabel} label={t('recipeDetail.chefsNote')} original={step.notes} value={tr?.notes} onValue={(v) => setStep(n, 'notes', v)} />
                )}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}
