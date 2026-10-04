// ════════════════════════════════════════════════════════════════════════
// SmartChef — Scaling a recipe's amounts to the reader's servings
//
// What used to be a set of closures inside RecipeDetail, lifted out so the
// printed report (pages/RecipeReport.tsx, lib/recipeReport.ts) says exactly
// what the screen says: the same scaling, the same metric/imperial
// restatement, the same per-step amounts for inline {{ing:N}} references,
// the same "how much is left" arithmetic. Two copies of this would drift,
// and a printed recipe whose numbers disagree with the screen is worse than
// no printout.
//
// Pure — no React, no i18n. The input types are structural so RecipeDetail's
// own interfaces fit without being moved.
// ════════════════════════════════════════════════════════════════════════

import { remainingBeforeStep, stepIngredientConsumption } from './stepRefs';
import { toSystem, type MeasurementSystem } from './unitConvert';

export interface ScalerIngredient {
  sortOrder: number;
  ingredientName?: string | null;
  subRecipeTitle?: string | null;
  quantity: number | null;
  quantityText?: string | null;
  unitSymbol?: string | null;
}

export interface ScalerStepIngredientRef {
  ingredientSortOrder: number;
  amountMode?: 'fraction' | 'absolute';
  portion: number;
  quantity?: number | null;
  unitSymbol?: string | null;
}

export interface ScalerStep {
  id: string;
  stepNumber: number;
  stepIngredients?: ScalerStepIngredientRef[] | null;
}

/** An ingredient as an inline step reference needs it — see
 *  components/RenderStepText.tsx. */
export interface StepTextIngredient {
  sortOrder: number;
  name: string;
  quantity: string;
  /** What THIS step uses, where the step says. */
  stepQuantity?: string;
}

/** One of a step's linked ingredients, with its share of the total. */
export interface StepIngredientUse {
  sortOrder: number;
  name: string;
  quantity: string;
  unitSymbol: string;
  portionPct: number;
  remainingAfter: string;
  totalUnitSymbol: string;
}

export interface RecipeScalerOptions {
  ingredients: ScalerIngredient[];
  steps: ScalerStep[];
  /** The servings the recipe's amounts are written for. Missing or zero
   *  means "don't scale". */
  baseServings: number | null | undefined;
  /** The servings the reader asked for. */
  servings: number;
  displaySystem: MeasurementSystem;
  /** Name for a step-linked ingredient row that has neither an ingredient
   *  nor a sub-recipe title (t('shopping.ingredientFallback')). */
  fallbackName: string;
}

export function createRecipeScaler(opts: RecipeScalerOptions) {
  const { ingredients, steps, baseServings, servings, displaySystem, fallbackName } = opts;

  const servingsScale = baseServings ? servings / baseServings : 1;

  const scaleNum = (qty: number | null): number | null => {
    if (qty === null) return null;
    return qty * servingsScale;
  };

  const scale = (qty: number | null): string => {
    const v = scaleNum(qty);
    if (v === null) return '';
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  };

  /** Scales to the current portion count AND restates in the chosen system.
   *
   *  toSystem() returns null for anything it must not touch — a countable
   *  unit ("2 pz"), a vague one ("q.b."), a spoon, or a unit already in the
   *  requested system — and the original is rendered unchanged in every one
   *  of those cases. A quantityText with no number ("a pinch") never even
   *  reaches it. */
  const formatAmount = (qty: number | null, unitSymbol?: string | null, quantityText?: string | null): string => {
    const v = scaleNum(qty);
    if (v === null) return quantityText || '';
    const fallback = `${v % 1 === 0 ? v : v.toFixed(1)}${unitSymbol ? ` ${unitSymbol}` : quantityText ? ` ${quantityText}` : ''}`;
    if (!unitSymbol) return fallback;
    const converted = toSystem(v, unitSymbol, displaySystem);
    return converted ? `${converted.value} ${converted.symbol}` : fallback;
  };

  /** Context for resolving {{ing:N}} inline refs in step text. */
  const stepTextIngredients: StepTextIngredient[] = ingredients.map(ing => ({
    sortOrder: ing.sortOrder,
    name: ing.ingredientName || ing.subRecipeTitle || 'ingredient',
    quantity: ing.quantity !== null ? formatAmount(ing.quantity, ing.unitSymbol, ing.quantityText) : '',
  }));

  /** The same context, narrowed to one step: an inline reference inside a
   *  step that says it uses 500 of the 620 g of flour should read "500 g",
   *  not the recipe's total. It used to read the total for every step,
   *  because the only context the renderer ever got was the recipe-wide
   *  one above — the amount picked when the reference was inserted went
   *  into stepIngredients and was then never shown anywhere in the text. */
  const stepTextIngredientsFor = (step: { stepIngredients?: ScalerStepIngredientRef[] | null }): StepTextIngredient[] => {
    const refs = step.stepIngredients || [];
    if (refs.length === 0) return stepTextIngredients;
    return stepTextIngredients.map(ctx => {
      const ref = refs.find(r => r.ingredientSortOrder === ctx.sortOrder);
      if (!ref) return ctx;
      const ing = ingredients.find(i => i.sortOrder === ctx.sortOrder);
      if (!ing) return ctx;
      if (ref.amountMode === 'absolute') {
        return {
          ...ctx,
          stepQuantity: ref.quantity != null
            ? formatAmount(ref.quantity, ref.unitSymbol || ing.unitSymbol)
            : undefined,
        };
      }
      const consumed = stepIngredientConsumption(ref, { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol });
      return { ...ctx, stepQuantity: consumed != null ? formatAmount(consumed, ing.unitSymbol) : undefined };
    });
  };

  /** Steps in the order they are cooked — the order "how much is left by
   *  now" has to be counted in. */
  const sortedSteps = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);

  /** A step's linked ingredients and their portion of the total. */
  const stepIngredientList = (step: ScalerStep): StepIngredientUse[] => {
    if (!step.stepIngredients?.length) return [];
    const stepIndex = Math.max(0, sortedSteps.findIndex(s => s.id === step.id));
    return step.stepIngredients.map(ref => {
      const ing = ingredients.find(i => i.sortOrder === ref.ingredientSortOrder);
      if (!ing) return null;
      const totals = { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol };
      // What the recipe still has of this ingredient once the steps before
      // this one have taken their share, and what is left after this one
      // does too. A recipe that pours 500 of its 620 g of flour into step 4
      // has 120 g for step 7, and kitchen mode is exactly where being told
      // that (rather than "620 g", the amount in the jar at the start)
      // decides whether the dish works.
      const before = remainingBeforeStep(sortedSteps, stepIndex, totals);
      const used = stepIngredientConsumption(ref, totals);
      const after = before != null && used != null ? Math.max(0, before - used) : null;
      if (ref.amountMode === 'absolute') {
        return {
          sortOrder: ing.sortOrder,
          name: ing.ingredientName || ing.subRecipeTitle || fallbackName,
          quantity: ref.quantity != null ? scale(ref.quantity) : '',
          unitSymbol: ref.unitSymbol || ing.unitSymbol || '',
          portionPct: 100,
          remainingAfter: after != null ? scale(after) : '',
          totalUnitSymbol: ing.unitSymbol || '',
        };
      }
      const portionQty = ing.quantity !== null ? ing.quantity * ref.portion : null;
      return {
        sortOrder: ing.sortOrder,
        name: ing.ingredientName || ing.subRecipeTitle || fallbackName,
        quantity: scale(portionQty),
        unitSymbol: ing.unitSymbol || '',
        portionPct: Math.round(ref.portion * 100),
        remainingAfter: after != null ? scale(after) : '',
        totalUnitSymbol: ing.unitSymbol || '',
      };
    }).filter((x): x is StepIngredientUse => x !== null);
  };

  return {
    servingsScale,
    scaleNum,
    scale,
    formatAmount,
    stepTextIngredients,
    stepTextIngredientsFor,
    sortedSteps,
    stepIngredientList,
  };
}

export type RecipeScaler = ReturnType<typeof createRecipeScaler>;
