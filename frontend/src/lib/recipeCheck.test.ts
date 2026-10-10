import { describe, it, expect } from 'vitest';
import {
  interpretCheckResponse, applyCheckChanges, numberSupportedBy, plainStepText, isTypoFix, isDigitSlip,
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

  it('never rewrites a step: no links or tokens come out of a check', () => {
    const r = interpretCheckResponse({
      steps: [{ i: 0, ingredients: [{ name: 'Farina' }], tools: ['Whisk'], techniques: ['Fold'] }],
    }, draft(), catalog);
    expect(r.changes).toEqual([]);
  });

  it('ignores an amount that is only a share of the ingredient', () => {
    const d = draft();
    d.steps![1].description = 'Aggiungi metà della farina, 100 g.';
    d.steps![0].description = 'Mescola 200 g di farina.';
    const half = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 100, unit: 'g', evidence: 'metà della farina, 100 g' }] }, d, catalog);
    expect(half.changes).toEqual([]);
  });

  it('ignores an ingredient whose amount is split across several steps', () => {
    const d = draft();
    d.steps![1].description = 'Aggiungi la farina, 50 g.';
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }] }, d, catalog);
    expect(r.changes).toEqual([]);
  });

  it('only corrects an existing amount that looks like a slip of the pen', () => {
    const d = draft();
    d.ingredients![0].quantity = 150;
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }] }, d, catalog);
    expect(r.changes).toEqual([]);
  });

  it('does not change the unit of a row that already has one', () => {
    const r = interpretCheckResponse({ ingredients: [{ i: 0, quantity: 200, unit: 'pz', evidence: 'mescola 200 g di farina' }] }, draft(), catalog);
    expect(r.changes).toEqual([]);
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

describe('typo fixes', () => {
  const typoDraft = (): CheckDraft => {
    const d = draft();
    d.steps![0].description = 'Con la {{tool:T1}} mescola la farina con lo zuchero.';
    return d;
  };

  it('accepts a small spelling fix inside a step and leaves the tokens alone', () => {
    const d = typoDraft();
    const r = interpretCheckResponse({ typos: [{ target: 'stepText', i: 0, before: 'zuchero', after: 'zucchero' }] }, d, catalog);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: 'textFix', from: 'zuchero', to: 'zucchero' });
    expect((r.changes[0] as any).before).toContain('farina con lo zuchero');
    const next: any = applyCheckChanges(d, r.changes);
    expect(next.steps[0].description).toBe('Con la {{tool:T1}} mescola la farina con lo zucchero.');
    expect(d.steps![0].description).toContain('zuchero'); // input untouched
  });

  it('rejects rewording, number changes, and words that are not in the text', () => {
    const d = typoDraft();
    const bad = (before: string, after: string) =>
      interpretCheckResponse({ typos: [{ target: 'stepText', i: 0, before, after }] }, d, catalog).changes;
    expect(bad('mescola la farina', 'amalgama la farina')).toEqual([]);
    expect(bad('zuchero', 'zucchero e sale')).toEqual([]);
    expect(bad('frusta', 'frustra')).toEqual([]); // not present as written
    const withNumber = typoDraft();
    withNumber.title = 'Torta 20 minuti';
    expect(interpretCheckResponse({ typos: [{ target: 'title', i: null, before: 'Torta 20', after: 'Torta 30' }] }, withNumber, catalog).changes).toEqual([]);
  });

  it('rejects a phrase that occurs twice, so the fix cannot land in the wrong place', () => {
    const d = typoDraft();
    d.steps![0].description = 'Aggiungi zuchero e poi altro zuchero.';
    expect(interpretCheckResponse({ typos: [{ target: 'stepText', i: 0, before: 'zuchero', after: 'zucchero' }] }, d, catalog).changes).toEqual([]);
  });

  it('isTypoFix tells a typo from a rewrite', () => {
    expect(isTypoFix('zuchero', 'zucchero')).toBe(true);
    expect(isTypoFix('thecake', 'the cake')).toBe(true);
    expect(isTypoFix('mix', 'combine')).toBe(false);
    expect(isTypoFix('200 g', '300 g')).toBe(false);
  });
});

describe('isDigitSlip', () => {
  it('accepts dropped, doubled, swapped digits and decimal slides', () => {
    expect(isDigitSlip(20, 200)).toBe(true);
    expect(isDigitSlip(250, 520)).toBe(true);
    expect(isDigitSlip(1.5, 15)).toBe(true);
    expect(isDigitSlip(150, 200)).toBe(false);
  });
});

describe('applyCheckChanges', () => {
  it('applies only the chosen changes', () => {
    const d = draft();
    const r = interpretCheckResponse({
      ingredients: [{ i: 0, quantity: 200, unit: 'g', evidence: 'mescola 200 g di farina' }],
      servings: { value: 6, evidence: 'Serve 6 persone' },
    }, d, catalog);
    const chosen = r.changes.filter((c) => c.type !== 'field');
    const next: any = applyCheckChanges({ ...d, tools: [] } as CheckDraft, chosen);
    expect(next.ingredients[0].quantity).toBe(200);
    expect(next.servings).toBe(4);
    expect(d.ingredients![0].quantity).toBe(20); // input untouched
  });
});

describe('plainStepText', () => {
  it('renders tokens as the words the cook reads', () => {
    const ings = draft().ingredients!;
    expect(plainStepText('Sbatti {{ing:0|q=200 g}} con {{tool:T1}}', ings, catalog)).toBe('Sbatti 200 g Farina con Frusta');
  });
});
