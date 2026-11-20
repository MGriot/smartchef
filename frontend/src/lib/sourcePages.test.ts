import { describe, expect, it } from 'vitest';
import { MAX_PAGES_PER_REQUEST, SOURCE_PAGE_CHARS, pageRecipeToText, pickSourceLinks, sourcePagesForModel, sourcesReadSummary } from './sourcePages';
import { normalizeSourceUrl } from './recipeSources';
import { buildCheckRequest, interpretCheckResponse, type CheckCatalog, type CheckDraft } from './recipeCheck';

describe('pageRecipeToText', () => {
  it('writes the facts, the grouped ingredients and the numbered steps', () => {
    const text = pageRecipeToText({
      title: 'Soupe à l\'oignon',
      servings: 4,
      prepTimeMin: 15,
      cookTimeMin: 45,
      ingredients: [
        { name: 'cipolle', quantity: 1, unit: 'kg' },
        { name: 'Emmentaler', quantity: 150, unit: 'g', groupName: 'Per gratinare', notes: 'grattugiato' },
      ],
      steps: [{ description: 'Affettate le cipolle.' }, { title: 'Cottura', description: 'Stufate.', durationMin: 40 }],
    });
    expect(text).toContain('Servings: 4 · Prep time: 15 min · Cook time: 45 min');
    expect(text).toContain('- 1 kg cipolle');
    expect(text).toContain('[Per gratinare]\n- 150 g Emmentaler (grattugiato)');
    expect(text).toContain('2. Cottura: Stufate. (40 min)');
  });

  it('never exceeds the per-page budget', () => {
    const text = pageRecipeToText({ ingredients: [], steps: Array.from({ length: 400 }, () => ({ description: 'Mescolate con cura per bene.' })) });
    expect(text.length).toBeLessThanOrEqual(SOURCE_PAGE_CHARS);
  });
});

describe('pickSourceLinks', () => {
  it('gives every recipe its first link before anyone a second, a shared page once', () => {
    const picked = pickSourceLinks(
      [['https://a.it/1', 'https://a.it/2'], ['http://www.a.it/1/', 'https://b.it/1'], ['https://c.it/1']],
      normalizeSourceUrl,
    );
    expect(picked).toEqual(['https://a.it/1', 'https://c.it/1', 'https://a.it/2', 'https://b.it/1']);
  });

  it('stops at the request budget', () => {
    const many = Array.from({ length: 12 }, (_, i) => [`https://s${i}.it/r`]);
    expect(pickSourceLinks(many, normalizeSourceUrl)).toHaveLength(MAX_PAGES_PER_REQUEST);
  });
});

describe('what the model and the user are shown', () => {
  const pages = [
    { url: 'https://a.it/1', ok: true, title: 'Zuppa', text: 'Servings: 4' },
    { url: 'https://b.it/1', ok: false, text: '', error: 'HTTP 403' },
  ];

  it('hands the model the readable pages only', () => {
    expect(sourcePagesForModel(pages)).toEqual([{ url: 'https://a.it/1', title: 'Zuppa', text: 'Servings: 4' }]);
  });

  it('tells the user about every page', () => {
    expect(sourcesReadSummary(pages)).toEqual([
      { url: 'https://a.it/1', ok: true, title: 'Zuppa' },
      { url: 'https://b.it/1', ok: false, error: 'HTTP 403' },
    ]);
  });
});

describe('Check with AI reads the reference pages', () => {
  const catalog: CheckCatalog = { tools: [], techniques: [], units: [], tagNames: [] };
  const draft: CheckDraft = {
    title: 'Zuppa di cipolle',
    ingredients: [],
    steps: [{ title: null, description: 'Stufate le cipolle.', durationMin: null, toolIds: [], techniqueIds: [], notes: null, stepIngredients: [] }],
    sourcePages: [{ url: 'https://a.it/zuppa', title: 'Zuppa di cipolle', text: 'Servings: 4 · Cook time: 45 min\nSteps:\n1. Stufate le cipolle.' }],
  };

  it('sends the pages with the recipe', () => {
    expect(buildCheckRequest(draft, catalog).sourcePages).toHaveLength(1);
    expect(buildCheckRequest({ ...draft, sourcePages: [] }, catalog)).not.toHaveProperty('sourcePages');
  });

  it('accepts a fact quoted from a source page', () => {
    const result = interpretCheckResponse({ servings: { value: 4, evidence: 'Servings: 4' }, cookTimeMin: { value: 45, evidence: 'Cook time: 45 min' } }, draft, catalog);
    expect(result.changes.map((c) => (c.type === 'field' ? [c.field, c.value] : null))).toEqual([['servings', 4], ['cook_time_min', 45]]);
  });

  it('still rejects the same fact when no page states it', () => {
    const result = interpretCheckResponse({ servings: { value: 4, evidence: 'Servings: 4' } }, { ...draft, sourcePages: [] }, catalog);
    expect(result.changes).toEqual([]);
  });
});
