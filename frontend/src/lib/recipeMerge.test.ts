import { describe, it, expect } from 'vitest';
import { applyCheckChanges, type CheckCatalog, type CheckDraft } from './recipeCheck';
import { buildMergeRequest, interpretMergeResponse } from './recipeMerge';

const catalog: CheckCatalog = {
  tools: [],
  techniques: [],
  units: [{ id: 'U-g', symbol: 'g', name: 'grammi' }, { id: 'U-ml', symbol: 'ml', name: 'millilitri' }],
  tagNames: ['Dolce', 'Vegetariano'],
};

const draft = (): CheckDraft => ({
  title: 'Torta di mele',
  description: 'Una torta semplice.',
  servings: 6,
  prep_time_min: 0,
  cook_time_min: 0,
  tags: ['Dolce'],
  regions: [],
  sources: [{ type: 'url', url: 'https://example.com/old' }],
  ingredients: [
    { sortOrder: 0, ingredientName: 'Farina', quantity: null, unitId: null, unitSymbol: null, notes: null },
    { sortOrder: 1, ingredientName: 'Mele', quantity: 3, unitId: null, unitSymbol: null, notes: null },
  ],
  steps: [
    { title: null, description: 'Mescola la farina con le mele.', durationMin: null, toolIds: [], techniqueIds: [], notes: null, stepIngredients: [] },
  ],
});

const pasted = `Mia nonna la faceva con 250 g di farina e 100 ml di latte.
Cuoci in forno a 180 gradi per 40 minuti.
Ricetta da https://nonna.example.it/torta e dal libro "Il cucchiaio d'argento".`;

describe('buildMergeRequest', () => {
  it('sends the draft, its sources and the pasted text', () => {
    const req = buildMergeRequest(draft(), pasted, catalog);
    expect(req.newText).toBe(pasted);
    expect(req.sources).toEqual([{ type: 'url', label: null, url: 'https://example.com/old' }]);
    expect(req.ingredients.map((i) => i.name)).toEqual(['Farina', 'Mele']);
  });
});

describe('interpretMergeResponse — only what the pasted text says', () => {
  it('fills an amount, adds an ingredient and a step, each quoting the text', () => {
    const result = interpretMergeResponse({
      ingredients: [
        { i: 0, name: 'Farina', quantity: 250, unit: 'g', evidence: 'con 250 g di farina' },
        { i: null, name: 'Latte', quantity: 100, unit: 'ml', evidence: 'e 100 ml di latte' },
      ],
      steps: [{ i: null, title: 'Cottura', text: 'Cuoci in forno a 180 gradi per 40 minuti.', durationMin: 40, evidence: 'Cuoci in forno a 180 gradi per 40 minuti' }],
      cookTimeMin: { value: 40, evidence: 'per 40 minuti' },
    }, draft(), pasted, catalog);
    const types = result.changes.map((c) => c.type);
    expect(types).toContain('ingredientQty');
    expect(types).toContain('ingredientAdd');
    expect(types).toContain('stepAdd');
    expect(types).toContain('field');
  });

  it('drops anything whose quote is not in the pasted text, or whose number is not in its quote', () => {
    const result = interpretMergeResponse({
      ingredients: [
        { i: null, name: 'Burro', quantity: 50, unit: 'g', evidence: 'con 50 g di burro' },
        { i: 0, name: 'Farina', quantity: 300, unit: 'g', evidence: 'con 250 g di farina' },
      ],
      steps: [{ i: null, title: null, text: 'Cuoci a 200 gradi.', durationMin: null, evidence: 'Cuoci in forno a 180 gradi' }],
      servings: { value: 8, evidence: 'per 40 minuti' },
    }, draft(), pasted, catalog);
    expect(result.changes.filter((c) => c.type !== 'sourceAdd')).toEqual([]);
  });

  it('never proposes removing or shrinking a step', () => {
    const result = interpretMergeResponse({
      steps: [{ i: 0, text: 'Mescola.', evidence: 'Cuoci in forno a 180 gradi per 40 minuti' }],
    }, draft(), pasted, catalog);
    expect(result.changes.some((c) => c.type === 'stepRewrite')).toBe(false);
  });

  it('takes sources only as written in the text, without duplicates', () => {
    const result = interpretMergeResponse({
      sources: [
        { type: 'url', url: 'https://nonna.example.it/torta', evidence: 'https://nonna.example.it/torta' },
        { type: 'url', url: 'https://invented.example.com', evidence: 'Ricetta da' },
        { type: 'book', label: "Il cucchiaio d'argento", evidence: 'dal libro "Il cucchiaio d\'argento"' },
        { type: 'url', url: 'https://example.com/old', evidence: 'x' },
      ],
    }, draft(), pasted, catalog);
    const sources = result.changes.flatMap((c) => (c.type === 'sourceAdd' ? [c.source] : []));
    expect(sources).toEqual([
      { type: 'url', url: 'https://nonna.example.it/torta' },
      { type: 'book', label: "Il cucchiaio d'argento" },
    ]);
  });

  it('caps dish tags, prefers catalog spelling and skips ingredient names', () => {
    const text = 'Un dolce vegetariano da merenda, perfetto in autunno, con le mele, tipico della Romagna, facile, veloce, economico.';
    const result = interpretMergeResponse({
      tags: ['vegetariano', 'Mele', 'Merenda', 'Autunno', 'Facile', 'Veloce', 'Economico', 'Dolce'].map((name) => ({ name, evidence: text })),
    }, draft(), text, catalog);
    const tags = result.changes.flatMap((c) => (c.type === 'tag' ? [c.name] : []));
    expect(tags[0]).toBe('Vegetariano');
    expect(tags).not.toContain('Mele');
    expect(tags).not.toContain('Dolce');
    expect(tags.length).toBe(5);
  });
});

describe('applying a merge', () => {
  it('adds the new step and sources, and appends text', () => {
    const d = draft();
    const result = interpretMergeResponse({
      steps: [{ i: null, title: 'Cottura', text: 'Cuoci in forno a 180 gradi per 40 minuti.', durationMin: 40, evidence: 'Cuoci in forno a 180 gradi per 40 minuti' }],
      texts: [{ target: 'tips', text: 'La ricetta della nonna usa anche il latte.', evidence: 'Mia nonna la faceva' }],
    }, d, pasted, catalog);
    const next: any = applyCheckChanges(d, result.changes);
    expect(next.steps).toHaveLength(2);
    expect(next.steps[1]).toMatchObject({ title: 'Cottura', durationMin: 40, stepNumber: 2 });
    expect(next.tips).toBe('La ricetta della nonna usa anche il latte.');
    expect(next.sources.map((s: any) => s.url)).toEqual(['https://example.com/old', 'https://nonna.example.it/torta']);
  });
});
