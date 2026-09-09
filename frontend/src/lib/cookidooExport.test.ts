import { describe, it, expect } from 'vitest';
import {
  buildCookidooExport,
  formatDuration,
  formatQuantity,
  type CookidooLabels,
  type CookidooRecipeInput,
} from './cookidooExport';

// The Italian Cookidoo form's own field names — the locale this was built
// against (see the screenshots in the originating issue).
const IT: CookidooLabels = {
  title: 'Titolo',
  prepTime: 'Tempo di preparazione',
  totalTime: 'Tempo totale',
  servings: 'Porzioni',
  servingsValue: (n) => `${n} porzioni`,
  ingredients: 'Ingredienti',
  steps: 'Passaggi della preparazione',
  devices: 'Dispositivi & accessori',
  tips: 'Consigli',
  optional: 'facoltativo',
  hourShort: 'h',
  minuteShort: 'min',
  storagePrefix: 'Come conservare',
  techniquesPrefix: 'Tecniche',
};

const recipe: CookidooRecipeInput = {
  title: 'Pasta al pomodoro',
  description: null,
  tips: 'Meglio con basilico fresco.',
  storage_instructions: 'In frigo per 2 giorni.',
  servings: 4,
  prep_time_min: 15,
  cook_time_min: 20,
  rest_time_min: 10,
  ingredients: [
    { ingredientName: 'farina 00', quantity: 200, unitSymbol: 'g', groupName: "Per l'impasto" },
    { ingredientName: 'acqua', quantity: 100, unitSymbol: 'ml', groupName: "Per l'impasto" },
    { ingredientName: 'pomodoro', quantity: 400, unitSymbol: 'g', groupName: 'Per il condimento' },
    { ingredientName: 'sale', quantityText: 'q.b.', groupName: 'Per il condimento' },
    { ingredientName: 'basilico', quantity: 1, unitSymbol: 'mazzo', isOptional: true, groupName: 'Per il condimento' },
  ],
  steps: [
    { stepNumber: 1, title: 'Impasto', description: 'Mescolare farina e acqua.', durationMin: 5 },
    { stepNumber: 2, title: null, description: 'Cuocere il pomodoro.', notes: 'Mescolare spesso.' },
  ],
  tools: [{ name: 'TM6' }, { name: 'Boccale' }],
  techniques: [{ name: 'Soffritto' }],
};

describe('formatQuantity', () => {
  it('keeps whole numbers whole and caps decimals at two places', () => {
    expect(formatQuantity(200)).toBe('200');
    expect(formatQuantity(1.5)).toBe('1.5');
    // 200 g scaled from 4 to 3 portions — the case that otherwise prints
    // "66.66666666666667 g" into the Cookidoo form.
    expect(formatQuantity(200 * (3 / 4) / 2.25)).toBe('66.67');
  });
});

describe('formatDuration', () => {
  it('renders minutes, whole hours and mixed durations the way the form does', () => {
    expect(formatDuration(45, IT)).toBe('45 min');
    expect(formatDuration(60, IT)).toBe('1 h');
    expect(formatDuration(90, IT)).toBe('1 h 30 min');
  });
});

describe('buildCookidooExport', () => {
  it('emits one section per Cookidoo form field, in the form\'s own order', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.map(s => s.key)).toEqual([
      'title', 'prepTime', 'totalTime', 'servings', 'ingredients', 'steps', 'devices', 'tips',
    ]);
    expect(sections.map(s => s.label)).toEqual([
      'Titolo', 'Tempo di preparazione', 'Tempo totale', 'Porzioni',
      'Ingredienti', 'Passaggi della preparazione', 'Dispositivi & accessori', 'Consigli',
    ]);
  });

  it('totals prep + cook + rest for "Tempo totale" but not for "Tempo di preparazione"', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.find(s => s.key === 'prepTime')?.text).toBe('15 min');
    expect(sections.find(s => s.key === 'totalTime')?.text).toBe('45 min'); // 15 + 20 + 10
  });

  it('groups ingredients under their headings and marks optional ones', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.find(s => s.key === 'ingredients')?.text).toBe(
      [
        "Per l'impasto",
        '200 g farina 00',
        '100 ml acqua',
        '',
        'Per il condimento',
        '400 g pomodoro',
        'q.b. sale',
        '1 mazzo basilico (facoltativo)',
      ].join('\n')
    );
  });

  it('scales numeric amounts to the servings being viewed, leaving free-text amounts alone', () => {
    const { sections } = buildCookidooExport(recipe, IT, { servings: 6 });
    const text = sections.find(s => s.key === 'ingredients')?.text ?? '';
    expect(text).toContain('300 g farina 00'); // 200 * 6/4
    expect(text).toContain('150 ml acqua');
    expect(text).toContain('q.b. sale'); // not scalable, passes through
    expect(sections.find(s => s.key === 'servings')?.text).toBe('6 porzioni');
  });

  it('numbers steps sequentially and appends duration and notes', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.find(s => s.key === 'steps')?.text).toBe(
      ['1. Impasto: Mescolare farina e acqua. (5 min)', '2. Cuocere il pomodoro.', '   Mescolare spesso.'].join('\n')
    );
  });

  it('renumbers steps when the stored stepNumbers have gaps', () => {
    const gappy: CookidooRecipeInput = {
      ...recipe,
      steps: [
        { stepNumber: 1, description: 'Primo.' },
        { stepNumber: 7, description: 'Secondo.' },
        { stepNumber: 9, description: 'Terzo.' },
      ],
    };
    expect(buildCookidooExport(gappy, IT).sections.find(s => s.key === 'steps')?.text)
      .toBe('1. Primo.\n2. Secondo.\n3. Terzo.');
  });

  it('folds storage instructions and techniques into Consigli', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.find(s => s.key === 'tips')?.text).toBe(
      ['Meglio con basilico fresco.', '', 'Come conservare: In frigo per 2 giorni.', '', 'Tecniche: Soffritto'].join('\n')
    );
  });

  it('prefers translated content when the recipe is being viewed in another language', () => {
    const translated: CookidooRecipeInput = {
      ...recipe,
      translated_title: 'Tomato pasta',
      steps: [{ stepNumber: 1, description: 'Mescolare.', translatedDescription: 'Stir it.' }],
    };
    const { sections } = buildCookidooExport(translated, IT);
    expect(sections.find(s => s.key === 'title')?.text).toBe('Tomato pasta');
    expect(sections.find(s => s.key === 'steps')?.text).toBe('1. Stir it.');
  });

  it('drops empty fields instead of emitting a bare heading', () => {
    const sparse: CookidooRecipeInput = { title: 'Solo titolo', servings: 2 };
    const { sections, fullText } = buildCookidooExport(sparse, IT);
    expect(sections.map(s => s.key)).toEqual(['title', 'servings']);
    expect(fullText).toBe('Titolo\nSolo titolo\n\nPorzioni\n2 porzioni');
  });

  it('joins every section into one pasteable document', () => {
    const { fullText } = buildCookidooExport(recipe, IT);
    expect(fullText).toContain('Titolo\nPasta al pomodoro');
    expect(fullText).toContain('Dispositivi & accessori\nTM6\nBoccale');
    // Sections are blank-line separated so the blocks stay visually distinct.
    expect(fullText).toContain('Tempo totale\n45 min\n\nPorzioni');
  });

  it('falls back to the recipe\'s own servings when none is supplied', () => {
    const { sections } = buildCookidooExport(recipe, IT);
    expect(sections.find(s => s.key === 'servings')?.text).toBe('4 porzioni');
    expect(sections.find(s => s.key === 'ingredients')?.text).toContain('200 g farina 00');
  });

  it('does not divide by zero when a recipe stores zero servings', () => {
    const zero: CookidooRecipeInput = { ...recipe, servings: 0 };
    const text = buildCookidooExport(zero, IT, { servings: 2 }).sections
      .find(s => s.key === 'ingredients')?.text ?? '';
    expect(text).toContain('400 g farina 00'); // treated as base 1 -> x2
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('NaN');
  });
});
