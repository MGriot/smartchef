// ════════════════════════════════════════════════════════════════════════
// The Import screen hands people two templates to fill in, and promises
// that what comes back is "recognized and processed instantly, no AI
// needed". That promise is only true while the templates and this parser
// agree — and they live in different files, in four locales, with the
// parser's own docstring asking for them to be kept in sync by hand.
//
// So: parse the actual shipped templates, in every language, and assert the
// no-AI path claims them. A template that drifts out of the parser's reach
// doesn't throw anywhere — it silently falls through to the LLM, which is
// exactly the failure this pins down.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { tryParseStructuredText } from './recipeTemplateParser';
import enLocale from '../i18n/locales/en.json';
import itLocale from '../i18n/locales/it.json';
import frLocale from '../i18n/locales/fr.json';
import esLocale from '../i18n/locales/es.json';

const locales = [
  ['en', enLocale],
  ['it', itLocale],
  ['fr', frLocale],
  ['es', esLocale],
] as const;

describe('shipped import templates', () => {
  it.each(locales)('%s text template parses without the AI path', (_lang, locale) => {
    const result = tryParseStructuredText(locale.import.rawTextTemplate);
    expect(result).not.toBeNull();
    // The template's ingredient/step examples are real lines, not just
    // placeholders — if the block scan stops recognizing them the result is
    // still non-null (the field labels alone are enough), so check the
    // bodies too.
    expect(result!.ingredients.length).toBeGreaterThan(0);
    expect(result!.steps.length).toBeGreaterThan(0);
  });

  it.each(locales)('%s JSON template parses without the AI path', (_lang, locale) => {
    const result = tryParseStructuredText(locale.import.rawTextTemplateJson);
    expect(result).not.toBeNull();
    expect(result!.ingredients.map((i) => i.name)).toContain('flour');
    expect(result!.steps).toHaveLength(2);
  });

  it('JSON template exercises the fields the text form cannot express', () => {
    const result = tryParseStructuredText(enLocale.import.rawTextTemplateJson)!;
    // Ingredient groups, and a per-step title + duration: the whole reason
    // the JSON flavour is offered alongside the text one.
    expect(result.ingredients[0].groupName).toBe('For the dough');
    expect(result.steps[0].title).toBe('Make the dough');
    expect(result.steps[0].durationMin).toBe(10);
  });

  it('reads "(facoltativo)" and friends as an optional ingredient', () => {
    const result = tryParseStructuredText([
      'Title: Bruschetta',
      '',
      'Ingredients:',
      '- 4 slices bread',
      '- 2 tomatoes (facoltativo)',
      '- 1 clove garlic (optional, chopped)',
      '- 1 bunch basil (fresh)',
      '',
      'Steps:',
      '1. Toast the bread.',
      '2. Rub with garlic.',
    ].join('\n'))!;

    expect(result.ingredients.map((i) => i.isOptional)).toEqual([false, true, true, false]);
    // The note survives the flag rather than being consumed by it: the
    // second half of "optional, tritato" is still an instruction.
    expect(result.ingredients[2].notes).toBe('optional, chopped');
  });

  it('leaves genuinely freeform prose to the AI path', () => {
    expect(
      tryParseStructuredText("Mom's lasagna. Brown the beef, layer it with noodles, bake for 45 minutes."),
    ).toBeNull();
  });
});
