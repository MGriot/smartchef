// ════════════════════════════════════════════════════════════════════════
// parseRecipeLocally() end to end, with the provider and the database
// stubbed out: what the model is TOLD (does the catalog reach the prompt,
// and is the right slice of it sent to each provider) and what it is
// BELIEVED about (is a catalogName carried through, and is an invented one
// thrown away).
//
// The mock captures the outgoing request body, so the prompt assertions
// check the bytes that would really have gone to the provider rather than
// a rebuilt copy of them.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<Record<string, any>> = [];
let modelReply = '';
let provider = 'openai';

vi.mock('../lib/nativeHttp', () => ({
  nativeHttpPostJson: vi.fn(async (_url: string, _headers: unknown, body: Record<string, any>) => {
    sent.push(body);
    // Every provider's response shape at once, so one mock serves all four
    // and a test only has to switch `provider`.
    return {
      statusCode: 200,
      text: modelReply,
      json: {
        choices: [{ message: { content: modelReply } }],          // OpenAI
        content: [{ type: 'text', text: modelReply }],            // Anthropic
        candidates: [{ content: { parts: [{ text: modelReply }] } }], // Gemini
        message: { content: modelReply },                         // Ollama
      },
    };
  }),
}));

vi.mock('../lib/llmSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/llmSettings')>()),
  getLlmSettings: vi.fn(async () => ({
    provider,
    ollamaUrl: 'http://localhost:11434',
    keys: { openai: 'test-key', anthropic: 'test-key', gemini: 'test-key' },
  })),
}));

const CATALOG = {
  ingredients: [
    { name: 'Butter', translatedName: 'Burro' },
    { name: 'Flour', translatedName: 'Farina' },
  ],
  tools: [{ name: 'Stand Mixer', translatedName: 'Planetaria' }],
  techniques: [{ name: 'Braise', translatedName: 'Brasare' }],
};

vi.mock('./importCatalog.local', () => ({
  loadImportCatalog: vi.fn(async () => CATALOG),
}));

/** The model's answer. `ingredients` is spread in so a test can vary just
 *  that part without restating a whole recipe. */
function reply(ingredients: unknown[]): string {
  return JSON.stringify({
    title: 'Torta',
    language: 'it',
    servings: 4,
    difficulty: 'easy',
    tags: [],
    tools: ['Stand Mixer'],
    ingredients,
    steps: [{ stepNumber: 1, description: 'Mescola.', techniques: ['Braise'], ingredients: [] }],
    confidence: 0.9,
    warnings: [],
  });
}

beforeEach(() => {
  sent.length = 0;
  provider = 'openai';
  modelReply = reply([{ name: 'burro morbido', catalogName: 'Butter', quantity: 100, unit: 'g' }]);
  vi.resetModules();
});

/** The system prompt as it actually left for the provider. */
function systemPromptSent(): string {
  const body = sent[sent.length - 1];
  return body.messages.find((m: { role: string }) => m.role === 'system').content;
}

describe('the prompt parseRecipeLocally actually sends', () => {
  it('carries the library catalog', async () => {
    const { parseRecipeLocally } = await import('./llmParser.local');
    await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    const prompt = systemPromptSent();
    expect(prompt).toContain('Catalogo della libreria');
    expect(prompt).toContain('Butter (Burro)');
    expect(prompt).toContain('Stand Mixer (Planetaria)');
  });

  it('withholds the ingredient list from a local Ollama, keeping the short lists', async () => {
    provider = 'ollama';
    const { parseRecipeLocally } = await import('./llmParser.local');
    await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    const prompt = systemPromptSent();
    expect(prompt).not.toContain('Butter (Burro)');
    expect(prompt).toContain('Stand Mixer (Planetaria)');
    expect(prompt).toContain('Braise (Brasare)');
  });

  // A photo or a voice note gets the same grounding as pasted text — the
  // media instruction only names the medium.
  it('carries the catalog on a media parse too', async () => {
    const { parseRecipeLocally } = await import('./llmParser.local');
    await parseRecipeLocally({
      input: '',
      inputType: 'media',
      lang: 'it',
      media: { mimeType: 'image/png', data: 'AAAA' },
    });

    expect(systemPromptSent()).toContain('Butter (Burro)');
  });
});

describe('what parseRecipeLocally believes from the answer', () => {
  it('keeps a catalogName that is really in the catalog, without touching name', async () => {
    const { parseRecipeLocally } = await import('./llmParser.local');
    const result = await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    expect(result.ingredients[0].name).toBe('burro morbido');
    expect(result.ingredients[0].catalogName).toBe('Butter');
    expect(result.warnings).toEqual([]);
  });

  it('drops an invented catalogName and warns', async () => {
    modelReply = reply([{ name: 'margarina', catalogName: 'Margarine' }]);
    const { parseRecipeLocally } = await import('./llmParser.local');
    const result = await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    expect(result.ingredients[0].catalogName).toBeNull();
    expect(result.warnings.join(' ')).toContain('Margarine');
  });

  // Ollama is never sent the ingredient list, so any claim it makes was
  // invented by definition.
  it('drops a claim on the ollama tier, where no ingredient list was sent', async () => {
    provider = 'ollama';
    const { parseRecipeLocally } = await import('./llmParser.local');
    const result = await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    expect(result.ingredients[0].catalogName).toBeNull();
  });

  // The regression guard: a model that says nothing about the catalog must
  // produce exactly what it produced before this feature existed.
  it('leaves everything else untouched when the model claims nothing', async () => {
    modelReply = reply([{ name: 'burro', quantity: 100, unit: 'g', notes: 'morbido' }]);
    const { parseRecipeLocally } = await import('./llmParser.local');
    const result = await parseRecipeLocally({ input: 'una ricetta', inputType: 'text', lang: 'it' });

    expect(result.ingredients[0]).toMatchObject({
      name: 'burro',
      quantity: 100,
      unit: 'g',
      notes: 'morbido',
      catalogName: null,
    });
    expect(result.title).toBe('Torta');
    expect(result.tools).toEqual(['Stand Mixer']);
    expect(result.steps[0].techniques).toEqual(['Braise']);
    expect(result.warnings).toEqual([]);
  });
});
