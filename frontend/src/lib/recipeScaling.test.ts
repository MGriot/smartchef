import { describe, it, expect } from 'vitest';
import { createRecipeScaler, type ScalerIngredient, type ScalerStep } from './recipeScaling';
import { toSystem } from './unitConvert';

// Lifted out of RecipeDetail so the printed report can use the very same
// arithmetic. These pin the behaviour the page had, so the move (and any
// later change) cannot quietly make paper and screen disagree.

const flour: ScalerIngredient = { sortOrder: 1, ingredientName: 'flour', quantity: 600, unitSymbol: 'g' };
const eggs: ScalerIngredient = { sortOrder: 2, ingredientName: 'eggs', quantity: 3, unitSymbol: 'pz' };
const salt: ScalerIngredient = { sortOrder: 3, ingredientName: 'salt', quantity: null, quantityText: 'a pinch' };
const cream: ScalerIngredient = { sortOrder: 4, subRecipeTitle: 'pastry cream', quantity: 300, unitSymbol: 'g' };

const steps: ScalerStep[] = [
  { id: 's2', stepNumber: 2, stepIngredients: [{ ingredientSortOrder: 1, portion: 0.5 }] },
  { id: 's1', stepNumber: 1, stepIngredients: [{ ingredientSortOrder: 1, amountMode: 'absolute', portion: 1, quantity: 100, unitSymbol: 'g' }] },
  { id: 's3', stepNumber: 3, stepIngredients: [{ ingredientSortOrder: 4, portion: 1 }, { ingredientSortOrder: 99, portion: 1 }] },
];

const scalerAt = (servings: number, displaySystem: 'metric' | 'imperial' = 'metric', baseServings: number | null = 4) =>
  createRecipeScaler({
    ingredients: [flour, eggs, salt, cream],
    steps,
    baseServings,
    servings,
    displaySystem,
    fallbackName: 'Ingredient',
  });

describe('createRecipeScaler — weight hint from density', () => {
  const milk: ScalerIngredient = { sortOrder: 5, ingredientName: 'milk', quantity: 1, unitSymbol: 'cup', densityGPerMl: 1.03 };
  const scaler = (servings: number, displaySystem: 'metric' | 'imperial' = 'metric') =>
    createRecipeScaler({ ingredients: [milk], steps: [], baseServings: 4, servings, displaySystem, fallbackName: 'x' });

  it('shows grams under a volume amount, scaled with it', () => {
    expect(scaler(4).weightHint(1, 'cup', 1.03)).toBe('≈ 244 g');
    expect(scaler(8).weightHint(1, 'cup', 1.03)).toBe('≈ 487 g');
  });

  it('switches to ounces for imperial readers', () => {
    expect(scaler(4, 'imperial').weightHint(1, 'cup', 1.03)).toBe('≈ 8.6 oz');
  });

  it('shows nothing for weights, pieces or unknown density', () => {
    expect(scaler(4).weightHint(200, 'g', 1)).toBeNull();
    expect(scaler(4).weightHint(1, 'cup', null)).toBeNull();
    expect(scaler(4).weightHint(null, 'cup', 1)).toBeNull();
  });
});

describe('createRecipeScaler — amounts', () => {
  it('scales by servings ÷ base servings', () => {
    const s = scalerAt(8);
    expect(s.servingsScale).toBe(2);
    expect(s.scaleNum(600)).toBe(1200);
    expect(s.formatAmount(600, 'g')).toBe('1200 g');
  });

  it('picks the display form after scaling: fractions for pieces and cups, decimals for grams', () => {
    const s = scalerAt(3);
    expect(s.scale(3)).toBe('2 ¼');
    expect(s.scale(4)).toBe('3');
    expect(s.formatAmount(3, 'pz')).toBe('2 ¼ pz');
    expect(s.formatAmount(3, 'g')).toBe('2.25 g');
    expect(s.scale(3.2)).toBe('2.4');
  });

  it('restates in the reader\'s system where a conversion exists', () => {
    const s = scalerAt(4, 'imperial');
    const expected = toSystem(600, 'g', 'imperial')!;
    expect(s.formatAmount(600, 'g')).toBe(`${expected.value} ${expected.symbol}`);
  });

  it('leaves countable units and text-only amounts as written', () => {
    const s = scalerAt(4, 'imperial');
    expect(s.formatAmount(3, 'pz')).toBe('3 pz');
    expect(s.formatAmount(null, null, 'a pinch')).toBe('a pinch');
    expect(s.formatAmount(2, null, 'cloves')).toBe('2 cloves');
  });

  it('does not scale when the base servings are unknown', () => {
    const s = scalerAt(8, 'metric', null);
    expect(s.servingsScale).toBe(1);
    expect(s.formatAmount(600, 'g')).toBe('600 g');
  });
});

describe('createRecipeScaler — step text context', () => {
  it('carries each ingredient\'s scaled total', () => {
    const s = scalerAt(8);
    expect(s.stepTextIngredients.find(i => i.sortOrder === 1)).toEqual({ sortOrder: 1, name: 'flour', quantity: '1200 g' });
    expect(s.stepTextIngredients.find(i => i.sortOrder === 3)?.quantity).toBe('');
    expect(s.stepTextIngredients.find(i => i.sortOrder === 4)?.name).toBe('pastry cream');
  });

  it('narrows to what the step uses: a fraction of the total', () => {
    const s = scalerAt(8);
    const ctx = s.stepTextIngredientsFor(steps[0]);
    expect(ctx.find(i => i.sortOrder === 1)?.stepQuantity).toBe('600 g');
    // Untouched ingredients keep the recipe total and no step amount.
    expect(ctx.find(i => i.sortOrder === 2)?.stepQuantity).toBeUndefined();
  });

  it('narrows to what the step uses: an exact amount', () => {
    const s = scalerAt(8);
    expect(s.stepTextIngredientsFor(steps[1]).find(i => i.sortOrder === 1)?.stepQuantity).toBe('200 g');
  });

  it('returns the recipe-wide context for a step that links nothing', () => {
    const s = scalerAt(4);
    expect(s.stepTextIngredientsFor({ stepIngredients: [] })).toBe(s.stepTextIngredients);
  });
});

describe('createRecipeScaler — a step\'s ingredient list', () => {
  it('counts what is left in cooking order, not list order', () => {
    const s = scalerAt(4);
    // Step 1 (listed second) takes an exact 100 g first; step 2 takes half
    // of the 600 g total, which leaves 200 g after it.
    const [use] = s.stepIngredientList(steps[0]);
    expect(use).toMatchObject({ name: 'flour', quantity: '300', unitSymbol: 'g', portionPct: 50, remainingAfter: '200' });
    expect(s.stepIngredientList(steps[1])[0]).toMatchObject({ quantity: '100', portionPct: 100, remainingAfter: '500' });
  });

  it('names a sub-recipe row by its title and drops refs to missing rows', () => {
    const s = scalerAt(4);
    const uses = s.stepIngredientList(steps[2]);
    expect(uses).toHaveLength(1);
    expect(uses[0].name).toBe('pastry cream');
  });

  it('sorts steps by number for the remaining-amount walk', () => {
    expect(scalerAt(4).sortedSteps.map(st => st.id)).toEqual(['s1', 's2', 's3']);
  });
});
