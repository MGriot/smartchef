import { describe, it, expect } from 'vitest';
import { interpretCheckResponse, applyCheckChanges, type CheckCatalog, type CheckDraft } from './recipeCheck';
import { buildFixRequest, interpretFixResponse } from './recipeMismatchFix';

// The recipe from the bug report: the list says ready-made pastry, red onions
// and grated cheese; the steps make a dough from flour, butter and egg and
// use spring onions, balsamic vinegar and feta.
const catalog: CheckCatalog = {
  tools: [{ id: 'T-forno', name: 'Oven', translated_name: 'Forno' }],
  techniques: [],
  units: [{ id: 'U-g', symbol: 'g', name: 'grammi' }, { id: 'U-pz', symbol: 'pz', name: 'pezzi' }],
  tagNames: [],
};

const step = (description: string, extra: Partial<CheckDraft['steps'] extends Array<infer S> | undefined ? S : never> = {}) => ({
  title: null, description, durationMin: null, toolIds: [], techniqueIds: [], notes: null, stepIngredients: [], ...extra,
});

const draft = (): CheckDraft => ({
  title: 'Tartellette alle cipolle',
  servings: 4,
  tags: [],
  regions: [],
  tools: [{ id: 'T-forno', name: 'Oven', translated_name: 'Forno' }],
  ingredients: [
    { sortOrder: 0, ingredientName: 'Pasta sfoglia', quantity: 1, unitId: 'U-pz', unitSymbol: 'pz', notes: null },
    { sortOrder: 1, ingredientName: 'Cipolle rosse', quantity: 400, unitId: 'U-g', unitSymbol: 'g', notes: null },
    { sortOrder: 2, ingredientName: 'Formaggio grattugiato', quantity: 50, unitId: 'U-g', unitSymbol: 'g', notes: null },
  ],
  steps: [
    step('Impastate la farina con il burro e un uovo, poi lasciate riposare.'),
    step('Mondate i cipollotti e rosolateli con l\'aceto balsamico.'),
    step('Sbriciolate la feta e infornate nel forno per 20 minuti.', { toolIds: ['T-forno'] }),
  ],
});

const analysis = {
  mismatch: {
    summary: 'Gli ingredienti elencano pasta sfoglia, i passaggi preparano un impasto.',
    unlisted: [
      { name: 'Farina', step: 0, quote: 'Impastate la farina con il burro' },
      { name: 'Burro', step: 0, quote: 'la farina con il burro' },
      { name: 'Cipollotti', step: 1, quote: 'Mondate i cipollotti' },
      { name: 'Aceto balsamico', step: 1, quote: 'con l\'aceto balsamico' },
      { name: 'Feta', step: 2, quote: 'Sbriciolate la feta' },
      // Not in the step's text: dropped.
      { name: 'Panna', step: 2, quote: 'aggiungete la panna' },
      // The list already has it: dropped.
      { name: 'Cipolle rosse', step: 1, quote: 'Mondate i cipollotti' },
    ],
  },
};

describe('ingredient/steps mismatch detection', () => {
  it('keeps only what the steps really say and the list really lacks', () => {
    const r = interpretCheckResponse(analysis, draft(), catalog);
    expect(r.mismatch?.unlisted.map((u) => u.name)).toEqual(['Farina', 'Burro', 'Cipollotti', 'Aceto balsamico', 'Feta']);
  });

  it('finds the list rows no step uses', () => {
    const r = interpretCheckResponse(analysis, draft(), catalog);
    expect(r.mismatch?.unused.map((u) => u.label)).toEqual(['Pasta sfoglia', 'Cipolle rosse', 'Formaggio grattugiato']);
  });

  it('raises nothing when the model reports nothing', () => {
    expect(interpretCheckResponse({ mismatch: null }, draft(), catalog).mismatch).toBeNull();
  });
});

describe('follow the steps', () => {
  const mismatch = () => interpretCheckResponse(analysis, draft(), catalog).mismatch!;

  it('adds what the steps name, marks unstated amounts as estimates, removes the unused rows', () => {
    const fix = interpretFixResponse('steps', {
      add: [
        { name: 'Farina', quantity: 250, unit: 'g', evidence: 'Impastate la farina con il burro' },
        { name: 'Feta', quantity: 100, unit: 'g', evidence: 'Sbriciolate la feta' },
        // Not named by the mismatch: the model may not grow the list.
        { name: 'Basilico', quantity: 5, unit: 'g', evidence: 'Sbriciolate la feta' },
        // Quote not in any step.
        { name: 'Cipollotti', quantity: 2, unit: 'pz', evidence: 'tagliate i cipollotti' },
      ],
      remove: [0, 1, 2, 7],
    }, draft(), catalog, mismatch());
    const adds = fix.changes.filter((c) => c.type === 'ingredientAdd');
    expect(adds.map((c) => (c as any).name)).toEqual(['Farina', 'Feta']);
    expect(adds.every((c) => (c as any).estimated)).toBe(true);
    expect(fix.changes.filter((c) => c.type === 'ingredientRemove').map((c) => (c as any).index)).toEqual([0, 1, 2]);
  });

  it('does not call an amount an estimate when the step states it', () => {
    const d = draft();
    d.steps![0].description = 'Impastate 250 g di farina con il burro.';
    const m = interpretCheckResponse({ mismatch: { unlisted: [{ name: 'Farina', step: 0, quote: '250 g di farina' }] } }, d, catalog).mismatch!;
    const fix = interpretFixResponse('steps', { add: [{ name: 'Farina', quantity: 250, unit: 'g', evidence: '250 g di farina' }] }, d, catalog, m);
    expect((fix.changes[0] as any).estimated).toBe(false);
  });

  it('applies: new rows appended, unused rows removed, references re-indexed', () => {
    const d = draft();
    d.steps![1].description = 'Mondate i cipollotti e rosolateli con {{ing:2}}.';
    d.steps![1].stepIngredients = [{ ingredientSortOrder: 2, amountMode: 'fraction', portion: 1 }];
    const m = interpretCheckResponse(analysis, d, catalog).mismatch!;
    const fix = interpretFixResponse('steps', {
      add: [{ name: 'Farina', quantity: 250, unit: 'g', evidence: 'Impastate la farina con il burro' }],
      remove: [0, 1],
    }, d, catalog, m);
    const add = fix.changes.find((c) => c.type === 'ingredientAdd')!;
    const out = applyCheckChanges(d, fix.changes, { ingredients: { [add.id]: { ingredientId: 'lib-farina', ingredientName: 'Farina' } } });
    expect(out.ingredients!.map((i) => i.ingredientName)).toEqual(['Formaggio grattugiato', 'Farina']);
    expect(out.ingredients!.map((i) => i.sortOrder)).toEqual([0, 1]);
    // The cheese moved from index 2 to 0, and its reference with it.
    expect(out.steps![1].description).toContain('{{ing:0}}');
    expect(out.steps![1].stepIngredients[0].ingredientSortOrder).toBe(0);
  });

  it('skips an added row the page could not resolve to a library ingredient', () => {
    const m = interpretCheckResponse(analysis, draft(), catalog).mismatch!;
    const fix = interpretFixResponse('steps', { add: [{ name: 'Feta', quantity: 100, unit: 'g', evidence: 'Sbriciolate la feta' }] }, draft(), catalog, m);
    expect(applyCheckChanges(draft(), fix.changes).ingredients).toHaveLength(3);
  });
});

describe('follow the ingredients', () => {
  const mismatch = () => interpretCheckResponse(analysis, draft(), catalog).mismatch!;

  it('only offers the steps that name what the list lacks', () => {
    expect(buildFixRequest('ingredients', draft(), catalog, mismatch()).affected).toEqual([0, 1, 2]);
  });

  it('accepts a faithful rewrite and a removal, with the amounts it already had', () => {
    const fix = interpretFixResponse('ingredients', {
      steps: [
        { i: 0, action: 'remove', text: '', reason: 'La pasta sfoglia è già pronta.' },
        { i: 2, action: 'rewrite', text: 'Distribuite il formaggio grattugiato e infornate nel forno per 20 minuti.', reason: 'Usa il formaggio in elenco.' },
      ],
    }, draft(), catalog, mismatch());
    expect(fix.changes.map((c) => c.type)).toEqual(['stepRemove', 'stepRewrite']);
  });

  it('rejects a rewrite that adds a number, keeps a missing ingredient or smuggles a token', () => {
    const fix = interpretFixResponse('ingredients', {
      steps: [
        { i: 2, action: 'rewrite', text: 'Distribuite il formaggio e infornate nel forno per 35 minuti.', reason: '' },
        { i: 1, action: 'rewrite', text: 'Mondate i cipollotti e rosolateli.', reason: '' },
        { i: 0, action: 'rewrite', text: 'Stendete la pasta {{ing:0}}.', reason: '' },
      ],
    }, draft(), catalog, mismatch());
    expect(fix.changes).toHaveLength(0);
  });

  it('applies: rewrite re-links the tool it kept, remove renumbers the steps', () => {
    const fix = interpretFixResponse('ingredients', {
      steps: [
        { i: 0, action: 'remove', text: '', reason: '' },
        { i: 2, action: 'rewrite', text: 'Distribuite il formaggio grattugiato e infornate nel forno per 20 minuti.', reason: '' },
      ],
    }, draft(), catalog, mismatch());
    const out = applyCheckChanges(draft(), fix.changes);
    expect(out.steps).toHaveLength(2);
    expect(out.steps!.map((s: any) => s.stepNumber)).toEqual([1, 2]);
    expect(out.steps![1].description).toContain('{{tool:T-forno}}');
    expect(out.steps![1].description).toContain('{{ing:2}}');
    expect(out.steps![1].stepIngredients.map((r) => r.ingredientSortOrder)).toContain(2);
  });
});

describe('links the check proposes', () => {
  it('links words the step holds to an ingredient and a tool, keeping the author\'s words', () => {
    const d = draft();
    d.steps![0].description = 'Mescolate la farina con il burro.';
    d.ingredients![0] = { ...d.ingredients![0], ingredientName: 'Farina' };
    const r = interpretCheckResponse({
      links: [
        { i: 0, kind: 'ing', target: 0, quote: 'farina' },
        { i: 2, kind: 'tool', target: 'Forno', quote: 'forno' },
        // Quote not a wording of its target / not in the step: dropped.
        { i: 0, kind: 'ing', target: 1, quote: 'burro' },
        { i: 2, kind: 'tool', target: 'Forno', quote: 'padella' },
        // Unknown catalog entry: reported, not linked.
        { i: 2, kind: 'tool', target: 'Spatola', quote: 'feta' },
      ],
    }, d, catalog);
    expect(r.changes.filter((c) => c.type === 'link')).toHaveLength(2);
    expect(r.unmatched).toContain('Spatola');
    const out = applyCheckChanges(d, r.changes);
    expect(out.steps![0].description).toBe('Mescolate la {{ing:0}} con il burro.');
    expect(out.steps![0].stepIngredients.map((x) => x.ingredientSortOrder)).toEqual([0]);
    expect(out.steps![2].description).toContain('{{tool:T-forno}}');
    expect(out.steps![2].toolIds).toEqual(['T-forno']);
  });

  it('keeps the authors own word as an alias when it differs from the ingredient name', () => {
    const d = draft();
    d.ingredients![1] = { ...d.ingredients![1], ingredientName: 'Zucchero semolato' };
    d.steps![0].description = 'Aggiungete lo zucchero.';
    const r = interpretCheckResponse({ links: [{ i: 0, kind: 'ing', target: 1, quote: 'zucchero' }] }, d, catalog);
    expect(applyCheckChanges(d, r.changes).steps![0].description).toBe('Aggiungete lo {{ing:1|as=zucchero}}.');
  });

  it('does not link what a step already links', () => {
    const d = draft();
    d.steps![2].description = 'Infornate nel {{tool:T-forno}} per 20 minuti.';
    const r = interpretCheckResponse({ links: [{ i: 2, kind: 'tool', target: 'Forno', quote: 'forno' }] }, d, catalog);
    expect(r.changes.filter((c) => c.type === 'link')).toHaveLength(0);
  });
});
