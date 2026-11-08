import { describe, it, expect } from 'vitest';
import {
  applyMachineTranslation, completeness, entryFor, languagesIn, libraryNameIn, machineTranslationInput, withField, withoutLanguage,
  type TranslatableDraft,
} from './recipeTranslationDraft';

const draft = (): TranslatableDraft => ({
  title: 'Torta di mele',
  description: 'Semplice.',
  translations: [{ lang: 'fr', title: 'Tarte aux pommes' }],
  steps: [
    { title: null, description: 'Mescola {{ing:0}}.', notes: 'Adagio.', translations: [] },
    { title: 'Cottura', description: 'Inforna.', notes: null, translations: [{ lang: 'en', description: 'Bake.' }] },
  ],
  ingredients: [{ notes: 'a pezzi', translations: [] }, { notes: null, translations: [] }],
});

describe('withField', () => {
  it('creates the entry on first write and drops it once empty', () => {
    const step = withField({ translations: [] }, 'en', 'title', 'Mix');
    expect(step.translations).toEqual([{ lang: 'en', title: 'Mix' }]);
    expect(withField(step, 'en', 'title', '').translations).toEqual([]);
  });

  it('keeps the other fields of an existing entry', () => {
    const step = withField({ translations: [{ lang: 'en', description: 'Bake.' }] }, 'en', 'notes', 'Hot oven');
    expect(entryFor(step, 'en')).toEqual({ lang: 'en', description: 'Bake.', notes: 'Hot oven' });
  });
});

describe('languagesIn / completeness / withoutLanguage', () => {
  it('lists every language with some text, wherever it lives', () => {
    expect(languagesIn(draft())).toEqual(['fr', 'en']);
  });

  it('counts only the fields the original fills', () => {
    // title, description, step0 description+notes, step1 title+description, ingredient0 notes
    expect(completeness(draft(), 'en')).toEqual({ done: 1, total: 7 });
    expect(completeness(draft(), 'fr')).toEqual({ done: 1, total: 7 });
  });

  it('removes a language everywhere', () => {
    const d = withoutLanguage(draft(), 'en');
    expect(languagesIn(d)).toEqual(['fr']);
  });
});

describe('machine translation', () => {
  it('sends positions as keys and fills only empty fields', () => {
    const d = draft();
    const input = machineTranslationInput(d);
    expect(input.steps.map((s) => s.id)).toEqual(['s0', 's1']);
    expect(input.ingredientNotes).toEqual([{ id: 'i0', notes: 'a pezzi' }]);

    const out = applyMachineTranslation(d, 'en', {
      title: 'Apple cake',
      description: 'Simple.',
      steps: [
        { id: 's0', title: null, description: 'Mix {{ing:0}}.', notes: 'Gently.' },
        { id: 's1', title: 'Baking', description: 'Put in the oven.', notes: null },
      ],
      ingredientNotes: [{ id: 'i0', notes: 'in pieces' }],
    });
    expect(entryFor(out, 'en')).toEqual({ lang: 'en', title: 'Apple cake', description: 'Simple.' });
    expect(entryFor(out.steps![0], 'en')).toEqual({ lang: 'en', description: 'Mix {{ing:0}}.', notes: 'Gently.' });
    // The user's own "Bake." stays.
    expect(entryFor(out.steps![1], 'en')).toEqual({ lang: 'en', description: 'Bake.', title: 'Baking' });
    expect(entryFor(out.ingredients![0], 'en')).toEqual({ lang: 'en', notes: 'in pieces' });
  });
});

describe('libraryNameIn', () => {
  const tr = [{ lang: 'en', text: 'Apple' }, { lang: 'fr-FR', text: 'Pomme' }, { lang: 'de', text: '  ' }];
  it('finds the exact language', () => expect(libraryNameIn(tr, 'en')).toBe('Apple'));
  it('falls back to the base language', () => expect(libraryNameIn(tr, 'fr')).toBe('Pomme'));
  it('ignores blank names and missing lists', () => {
    expect(libraryNameIn(tr, 'de')).toBeNull();
    expect(libraryNameIn(undefined, 'en')).toBeNull();
  });
});
