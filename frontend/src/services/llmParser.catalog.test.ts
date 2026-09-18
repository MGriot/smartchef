// ════════════════════════════════════════════════════════════════════════
// The library catalog handed to the model, and the validation of what it
// says back. Pure string work — no DB, no provider — so it runs anywhere.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, catalogSection, dropUnknownCatalogNames } from './llmParser.local';
import type { ImportCatalog } from './importCatalog.local';

const entry = (name: string, translatedName: string | null = null) => ({ name, translatedName });

const CATALOG: ImportCatalog = {
  ingredients: [entry('Butter', 'Burro'), entry('Guanciale'), entry('Red Bell Pepper', 'Peperone rosso')],
  tools: [entry('Stand Mixer', 'Planetaria')],
  techniques: [entry('Braise', 'Brasare')],
};

const EMPTY: ImportCatalog = { ingredients: [], tools: [], techniques: [] };

describe('catalogSection', () => {
  it('adds nothing at all when there is no catalog', () => {
    expect(catalogSection(null, 'openai')).toBe('');
  });

  // A fresh install seeds zero tools and zero techniques, and must get
  // exactly the prompt it got before this feature existed.
  it('adds nothing when the library is empty', () => {
    expect(catalogSection(EMPTY, 'openai')).toBe('');
  });

  it('renders a translated entry as "Base (Traduzione)"', () => {
    expect(catalogSection(CATALOG, 'openai')).toContain('Butter (Burro)');
  });

  it('renders an untranslated entry bare, with no empty parentheses', () => {
    const section = catalogSection(CATALOG, 'openai');
    expect(section).toContain('Guanciale');
    expect(section).not.toContain('Guanciale (');
  });

  it('does not repeat a translation that equals the base name', () => {
    const section = catalogSection({ ...EMPTY, tools: [entry('Wok', 'wok')] }, 'openai');
    expect(section).toContain('Wok');
    expect(section).not.toContain('Wok (wok)');
  });

  it('tells the model to echo the name outside the parentheses', () => {
    expect(catalogSection(CATALOG, 'openai')).toContain('FUORI dalle parentesi');
  });

  it('sends all three lists to a cloud provider', () => {
    const section = catalogSection(CATALOG, 'anthropic');
    expect(section).toContain('Ingredienti:');
    expect(section).toContain('Strumenti:');
    expect(section).toContain('Tecniche:');
  });

  // Ollama runs against a default context window the base prompt plus the
  // recipe already nearly fills, and overflow is silent there — so the one
  // long list is withheld while the two short ones still go.
  it('withholds the ingredient list from ollama but keeps tools and techniques', () => {
    const section = catalogSection(CATALOG, 'ollama');
    expect(section).not.toContain('Ingredienti:');
    expect(section).not.toContain('Guanciale');
    expect(section).toContain('Strumenti:');
    expect(section).toContain('Tecniche:');
  });

  it('adds nothing for ollama when only ingredients exist', () => {
    expect(catalogSection({ ...EMPTY, ingredients: [entry('Butter')] }, 'ollama')).toBe('');
  });
});

describe('buildSystemPrompt', () => {
  it('is the base prompt unchanged when there is no catalog', () => {
    expect(buildSystemPrompt(null, 'openai')).toBe(buildSystemPrompt(EMPTY, 'openai'));
  });

  it('keeps the base rules and appends the catalog', () => {
    const prompt = buildSystemPrompt(CATALOG, 'openai');
    expect(prompt).toContain('Sei un assistente specializzato');
    expect(prompt).toContain('Catalogo della libreria');
    expect(prompt.indexOf('Sei un assistente')).toBeLessThan(prompt.indexOf('Catalogo della libreria'));
  });

  // New tools and techniques are coined in English so they land on top of
  // the catalog's own base names instead of beside them — the "Bollitura
  // vs Boil" duplication this feature exists to stop.
  it('asks for English names for anything newly coined', () => {
    expect(buildSystemPrompt(null, 'openai')).toContain('IN INGLESE');
  });

  // Steps cross-reference the main ingredient list by name; a model
  // writing catalog names there instead would silently break the links
  // that lib/stepRefs.ts resolves.
  it('tells the model to keep step ingredient names off the catalog', () => {
    expect(buildSystemPrompt(CATALOG, 'openai')).toContain('MAI da catalogName');
  });
});

describe('dropUnknownCatalogNames', () => {
  const result = (ingredients: Array<{ name: string; catalogName?: string | null }>) => ({
    ingredients,
    warnings: [] as string[],
  });

  it('keeps a claim that really is in the catalog', () => {
    const r = dropUnknownCatalogNames(result([{ name: 'burro morbido', catalogName: 'Butter' }]), CATALOG, 'openai');
    expect(r.ingredients[0].catalogName).toBe('Butter');
    expect(r.warnings).toEqual([]);
  });

  it('matches ignoring case, accents and punctuation', () => {
    const c: ImportCatalog = { ...EMPTY, ingredients: [entry('Crème fraîche')] };
    const r = dropUnknownCatalogNames(result([{ name: 'panna', catalogName: 'creme fraiche' }]), c, 'openai');
    expect(r.ingredients[0].catalogName).toBe('creme fraiche');
  });

  // The hazard this exists for: a model naming something plausible that
  // was never on the list would otherwise be auto-selected downstream.
  it('drops an invented claim and says so', () => {
    const r = dropUnknownCatalogNames(result([{ name: 'margarina', catalogName: 'Margarine' }]), CATALOG, 'openai');
    expect(r.ingredients[0].catalogName).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Margarine');
    expect(r.warnings[0]).toContain('margarina');
  });

  // Ollama is never sent the ingredient list, so a claim naming a real row
  // is still a guess — and a guess auto-selected at 100% is the thing this
  // whole validation step exists to prevent.
  it('drops a claim on a tier that was never shown the ingredient list', () => {
    const r = dropUnknownCatalogNames(result([{ name: 'burro', catalogName: 'Butter' }]), CATALOG, 'ollama');
    expect(r.ingredients[0].catalogName).toBeNull();
  });

  it('drops everything when no catalog was sent at all', () => {
    const r = dropUnknownCatalogNames(result([{ name: 'burro', catalogName: 'Butter' }]), null, 'openai');
    expect(r.ingredients[0].catalogName).toBeNull();
  });

  // Tools and techniques are echoed straight into their own arrays, so the
  // ingredient list is the only thing a claim can validly name.
  it('never matches a claim against the tool or technique lists', () => {
    const r = dropUnknownCatalogNames(result([{ name: 'impastatrice', catalogName: 'Stand Mixer' }]), CATALOG, 'openai');
    expect(r.ingredients[0].catalogName).toBeNull();
  });

  it('normalizes an absent, empty or whitespace claim to null without warning', () => {
    const r = dropUnknownCatalogNames(
      result([{ name: 'sale' }, { name: 'pepe', catalogName: '' }, { name: 'olio', catalogName: '   ' }]),
      CATALOG,
      'openai'
    );
    expect(r.ingredients.map((i) => i.catalogName)).toEqual([null, null, null]);
    expect(r.warnings).toEqual([]);
  });

  it('reports every dropped claim in one warning', () => {
    const r = dropUnknownCatalogNames(
      result([
        { name: 'a', catalogName: 'Nope' },
        { name: 'b', catalogName: 'Butter' },
        { name: 'c', catalogName: 'Also nope' },
      ]),
      CATALOG,
      'openai'
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Nope');
    expect(r.warnings[0]).toContain('Also nope');
    expect(r.ingredients[1].catalogName).toBe('Butter');
  });
});
