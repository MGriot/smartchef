import { describe, it, expect } from 'vitest';
import {
  interpretCheckResponse, applyCheckChanges, numberSupportedBy, plainStepText,
  type CheckCatalog, type CheckDraft,
} from './recipeCheck';

const catalog: CheckCatalog = {
  tools: [{ id: 'T1', name: 'Whisk', translated_name: 'Frusta' }, { id: 'T2', name: 'Oven', translated_name: 'Forno' }],
  techniques: [{ id: 'Q1', name: 'Fold', translated_name: 'Incorporare' }],
  units: [{ id: 'U-g', symbol: 'g', name: 'grammi' }, { id: 'U-pz', symbol: 'pz', name: 'pezzi' }],
  tagNames: ['Vegetarian'],
};

const draft = (): CheckDraft => ({
  title: 'Torta alla Frusta',
  description: null,
  servings: 4,
  prep_time_min: 0,
  cook_time_min: 0,
  tags: [],
  regions: [],
  ingredients: [
    { sortOrder: 0, ingredientName: 'Farina', quantity: 20, unitId: 'U-g', unitSymbol: 'g', notes: null },
    { sortOrder: 1, ingredientName: 'Zucchero', quantity: 100, unitId: 'U-g', unitSymbol: 'g', notes: null },
  ],
  steps: [
    { title: null, description: 'Con la frusta mescola 200 g di farina con lo zucchero.', durationMin: null, toolIds: [], techniqueIds: [], notes: null, stepIngredients: [] },
    { title: null, description: 'Cuoci nel forno per 1 ora. Serve 6 persone.', durationMin: null, toolIds: [], techniqueIds: [], notes: null, stepIngredients: [] },
  ],
});

describe('numberSupportedBy', () => {
  it('accepts the number as written, an hour as minutes, a kilo as grams', () => {
    expect(numberSupportedBy(20, 'cuoci 20 minuti')).toBe(true);
    expect(numberSupportedBy(60, 'cuoci 1 ora')).toBe(true);
    expect(numberSupportedBy(1500, '1,5 kg di farina')).toBe(true);
    expect(numberSupportedBy(45, 'cuoci 20 minuti')).toBe(false);
  });
});

describe('interpretCheckResponse — never invents', () => {
  it('fixes a quantity that a step contradicts, with its quote', () => {
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }] }, draft(), catalog);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: 'ingredientQty', index: 0, quantity: 200, kind: 'fix', before: '20 g', after: '200 g' });
  });

  it('drops a change whose quote is not in the recipe', () => {
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 250, unit: 'g', evidence: 'usa 250 g di farina' }] }, draft(), catalog);
    expect(r.changes).toHaveLength(0);
  });

  it('drops a number the quote does not state', () => {
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 300, unit: 'g', evidence: 'mescola 200 g di farina' }] }, draft(), catalog);
    expect(r.changes).toHaveLength(0);
  });

  it('drops a quote that is about a different ingredient', () => {
    const r = interpretCheckResponse({ ingredients: [{ i: 1, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }] }, draft(), catalog);
    expect(r.changes.filter((c) => c.type === 'ingredientQty')).toHaveLength(0);
  });

  it('fills times and servings only from a stated figure', () => {
    const r = interpretCheckResponse({
      servings: { value: 6, evidence: 'Serve 6 persone' },
      cookTimeMin: { value: 60, evidence: 'nel forno per 1 ora' },
      prepTimeMin: { value: 15, evidence: 'about fifteen minutes' },
    }, draft(), catalog);
    const fields = r.changes.filter((c) => c.type === 'field').map((c: any) => [c.field, c.value, c.kind]);
    expect(fields).toEqual([['servings', 6, 'fix'], ['cook_time_min', 60, 'fill']]);
  });

  it('links a step to tools and ingredients its own text mentions, and ignores the rest', () => {
    const r = interpretCheckResponse({
      steps: [{ i: 0, ingredients: [{ name: 'Farina' }, { name: 'Zucchero' }], tools: ['Whisk', 'Oven', 'Blowtorch'], techniques: ['Fold'] }],
    }, draft(), catalog);
    const links: any = r.changes.find((c) => c.type === 'stepLinks');
    expect(links.toolIds).toEqual(['T1']); // Oven is not mentioned in step 1; Fold is not either
    expect(links.techniqueIds).toEqual([]);
    expect(links.stepIngredients.map((s: any) => s.ingredientSortOrder).sort()).toEqual([0, 1]);
    expect(links.description).toContain('{{tool:T1}}');
    expect(links.description).toContain('{{ing:0');
    expect(r.unmatched).toContain('Blowtorch');
  });

  it('never gives an ingredient used in several steps 100% in each', () => {
    const d = draft();
    d.steps![1].description = 'Aggiungi la farina rimasta e cuoci nel forno per 1 ora.';
    const r = interpretCheckResponse({
      steps: [{ i: 0, ingredients: [{ name: 'Farina' }] }, { i: 1, ingredients: [{ name: 'Farina' }] }],
    }, d, catalog);
    const rows = r.changes.filter((c: any) => c.type === 'stepLinks').flatMap((c: any) => c.stepIngredients);
    expect(rows).toHaveLength(0);
  });

  it('keeps an amount for a step only when it is quoted', () => {
    const quoted = interpretCheckResponse({
      steps: [{ i: 0, ingredients: [{ name: 'Farina', quantity: 200, unit: 'g' }], evidence: 'mescola 200 g di farina' }],
    }, draft(), catalog);
    const ref: any = (quoted.changes.find((c) => c.type === 'stepLinks') as any).stepIngredients[0];
    expect(ref).toMatchObject({ amountMode: 'absolute', quantity: 200, unitSymbol: 'g' });

    const invented = interpretCheckResponse({
      steps: [{ i: 0, ingredients: [{ name: 'Farina', quantity: 500, unit: 'g' }], evidence: 'mescola 200 g di farina' }],
    }, draft(), catalog);
    const ref2: any = (invented.changes.find((c) => c.type === 'stepLinks') as any).stepIngredients[0];
    expect(ref2.amountMode).toBe('fraction');
  });

  it('skips a yield whose unit is not in the library', () => {
    const d = draft();
    d.description = 'Per 12 biscotti';
    const r = interpretCheckResponse({ yield: { amount: 12, unit: 'dozzine', evidence: 'Per 12 biscotti' } }, d, catalog);
    expect(r.changes.filter((c) => c.type === 'yield')).toHaveLength(0);
    expect(r.unmatched).toContain('dozzine');
  });

  it('survives garbage', () => {
    expect(interpretCheckResponse(null, draft(), catalog).changes).toEqual([]);
    expect(interpretCheckResponse({ ingredients: 'x', steps: [null, { i: 99 }], tags: [{}] }, draft(), catalog).changes).toEqual([]);
  });
});

describe('applyCheckChanges', () => {
  it('applies only the chosen changes and mirrors tools into the recipe list', () => {
    const d = draft();
    const r = interpretCheckResponse({
      ingredients: [{ i: 0, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }],
      steps: [{ i: 0, tools: ['Whisk'] }],
      servings: { value: 6, evidence: 'Serve 6 persone' },
    }, d, catalog);
    const chosen = r.changes.filter((c) => c.type !== 'field');
    const next: any = applyCheckChanges({ ...d, tools: [] } as CheckDraft, chosen, undefined, catalog);
    expect(next.ingredients[0].quantity).toBe(200);
    expect(next.servings).toBe(4);
    expect(next.steps[0].toolIds).toEqual(['T1']);
    expect(next.tools.map((t: any) => t.id)).toEqual(['T1']);
    expect(d.ingredients![0].quantity).toBe(20); // input untouched
  });
});

describe('plainStepText', () => {
  it('renders tokens as the words the cook reads', () => {
    const ings = draft().ingredients!;
    expect(plainStepText('Sbatti {{ing:0|q=200 g}} con {{tool:T1}}', ings, catalog)).toBe('Sbatti 200 g Farina con Frusta');
  });
});
