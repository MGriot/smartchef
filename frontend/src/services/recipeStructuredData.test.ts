// ════════════════════════════════════════════════════════════════════════
// schema.org Recipe extraction.
//
// The fixtures below reproduce the *shapes* real recipe sites publish —
// a bare Recipe object, a Recipe inside an @graph alongside WebPage and
// Organization nodes, HowToSection-grouped instructions, comma-joined
// keywords, ImageObject covers, recipeYield as prose. Those variations are
// the whole difficulty of this parser; a single tidy JSON-LD blob would
// prove nothing.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  extractRecipeFromHtml,
  isoDurationToMinutes,
  parseYield,
  parseIngredientLine,
} from './recipeStructuredData';

const page = (jsonLd: unknown, extra = '') => `<!doctype html><html><head>
  <title>A recipe</title>
  ${extra}
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body><p>Some prose the LLM path would otherwise have had to read.</p></body></html>`;

describe('ISO-8601 durations', () => {
  it('reads hours and minutes', () => {
    expect(isoDurationToMinutes('PT1H30M')).toBe(90);
    expect(isoDurationToMinutes('PT20M')).toBe(20);
    expect(isoDurationToMinutes('PT2H')).toBe(120);
  });
  it('reads days, which slow-cook recipes use', () => {
    expect(isoDurationToMinutes('P1DT2H')).toBe(1560);
  });
  it('ignores anything that is not a duration', () => {
    expect(isoDurationToMinutes('30 minutes')).toBeUndefined();
    expect(isoDurationToMinutes(undefined)).toBeUndefined();
    expect(isoDurationToMinutes('PT0M')).toBeUndefined();
  });
});

describe('recipeYield', () => {
  it('reads every shape sites publish', () => {
    expect(parseYield(4)).toBe(4);
    expect(parseYield('4')).toBe(4);
    expect(parseYield('4 servings')).toBe(4);
    expect(parseYield('Serves 6')).toBe(6);
    expect(parseYield(['8', '8 servings'])).toBe(8);
  });
  it('gives up rather than guessing', () => {
    expect(parseYield('a loaf')).toBeUndefined();
    expect(parseYield(undefined)).toBeUndefined();
  });
});

describe('ingredient lines', () => {
  it('splits amount, unit, name and note', () => {
    expect(parseIngredientLine('200 g plain flour, sifted')).toMatchObject({
      quantity: 200, unit: 'g', name: 'plain flour', notes: 'sifted',
    });
  });
  it('reads fractions rather than doubling them', () => {
    // The bug lib/ingredientAmount.ts was written for: "1/2" must not be 1.
    expect(parseIngredientLine('1/2 cup sugar')).toMatchObject({ quantity: 0.5, unit: 'cup', name: 'sugar' });
    expect(parseIngredientLine('1 1/2 tsp salt')?.quantity).toBe(1.5);
  });
  it('takes a bracketed note', () => {
    expect(parseIngredientLine('3 eggs (room temperature)')).toMatchObject({
      quantity: 3, name: 'eggs', notes: 'room temperature',
    });
  });
  it('leaves a countable noun as the name, not a unit', () => {
    // "2 eggs" must not become 2 of unit "eggs" — over-eager unit matching
    // is invisible once saved, a missing unit is obvious.
    const parsed = parseIngredientLine('2 eggs');
    expect(parsed?.quantity).toBe(2);
    expect(parsed?.unit).toBeUndefined();
    expect(parsed?.name).toBe('eggs');
  });
  it('keeps an amountless line as a plain name', () => {
    expect(parseIngredientLine('Salt to taste')).toMatchObject({ name: 'Salt to taste' });
  });
  it('drops nothing but blanks', () => {
    expect(parseIngredientLine('   ')).toBeNull();
  });

  // The three below were all found by running the extractor against real
  // pages rather than fixtures, and each was wrong before that.
  it('reads long-form unit names, not just abbreviations', () => {
    // Serious Eats writes "2.5 pounds", not "2.5 lb".
    expect(parseIngredientLine('2.5 pounds mixed ripe tomatoes')).toMatchObject({
      quantity: 2.5, unit: 'pounds', name: 'mixed ripe tomatoes',
    });
    expect(parseIngredientLine('10 tablespoons olive oil')?.unit).toBe('tablespoons');
  });

  it('drops the metric-equivalent aside US sites put after the amount', () => {
    // "(1.1kg)" restates the amount just consumed — it is neither the name
    // nor a note, and used to end up glued to the front of the name.
    expect(parseIngredientLine('2.5 pounds (1.1kg) mixed ripe tomatoes, cut into pieces')).toMatchObject({
      quantity: 2.5, unit: 'pounds', name: 'mixed ripe tomatoes', notes: 'cut into pieces',
    });
  });

  it('keeps both a comma note and a trailing bracket note', () => {
    expect(parseIngredientLine('2 teaspoons (8g) kosher salt, plus more for seasoning (use half if table salt)')).toMatchObject({
      quantity: 2,
      unit: 'teaspoons',
      name: 'kosher salt',
      notes: 'plus more for seasoning; use half if table salt',
    });
  });
});

describe('extractRecipeFromHtml', () => {
  it('reads a bare Recipe node', () => {
    const html = page({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Pasta al pomodoro',
      description: 'Simple <b>tomato</b> pasta.',
      recipeYield: '4 servings',
      prepTime: 'PT10M',
      cookTime: 'PT20M',
      inLanguage: 'it-IT',
      recipeIngredient: ['400 g spaghetti', '500 g san marzano tomatoes', '2 cloves garlic'],
      recipeInstructions: ['Boil the pasta.', 'Make the sauce.', 'Combine.'],
      image: 'https://example.com/pasta.jpg',
    });

    const r = extractRecipeFromHtml(html, 'https://example.com/pasta')!;
    expect(r.title).toBe('Pasta al pomodoro');
    // HTML inside description is stripped, not passed through to the editor.
    expect(r.description).toBe('Simple tomato pasta.');
    expect(r.servings).toBe(4);
    expect(r.prepTimeMin).toBe(10);
    expect(r.cookTimeMin).toBe(20);
    expect(r.language).toBe('it');
    expect(r.ingredients).toHaveLength(3);
    expect(r.ingredients[0]).toMatchObject({ quantity: 400, unit: 'g', name: 'spaghetti' });
    expect(r.steps.map((s) => s.description)).toEqual(['Boil the pasta.', 'Make the sauce.', 'Combine.']);
    expect(r.imageUrl).toBe('https://example.com/pasta.jpg');
    expect(r.sourceUrl).toBe('https://example.com/pasta');
  });

  it('finds the Recipe inside an @graph full of other nodes', () => {
    // The commonest real-world shape — WordPress recipe plugins emit this.
    const html = page({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'A Food Blog' },
        { '@type': 'WebPage', name: 'Recipe page' },
        {
          '@type': ['Recipe', 'NewsArticle'],
          name: 'Bruschetta',
          recipeIngredient: ['4 slices sourdough', '2 tomatoes'],
          recipeInstructions: [{ '@type': 'HowToStep', text: 'Toast the bread.' }],
        },
      ],
    });

    const r = extractRecipeFromHtml(html)!;
    expect(r.title).toBe('Bruschetta');
    expect(r.ingredients).toHaveLength(2);
    expect(r.steps[0].description).toBe('Toast the bread.');
  });

  it('flattens HowToSection-grouped instructions and keeps the section as a step title', () => {
    const html = page({
      '@type': 'Recipe',
      name: 'Lasagne',
      recipeIngredient: ['500 g beef'],
      recipeInstructions: [
        {
          '@type': 'HowToSection',
          name: 'For the ragù',
          itemListElement: [
            { '@type': 'HowToStep', text: 'Brown the beef.' },
            { '@type': 'HowToStep', text: 'Add the tomatoes.' },
          ],
        },
        {
          '@type': 'HowToSection',
          name: 'To assemble',
          itemListElement: [{ '@type': 'HowToStep', text: 'Layer and bake.' }],
        },
      ],
    });

    const r = extractRecipeFromHtml(html)!;
    expect(r.steps).toHaveLength(3);
    expect(r.steps.map((s) => s.title)).toEqual(['For the ragù', 'For the ragù', 'To assemble']);
    expect(r.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3]);
  });

  it('splits a single prose instruction blob into steps', () => {
    const html = page({
      '@type': 'Recipe',
      name: 'Toast',
      recipeIngredient: ['2 slices bread'],
      recipeInstructions: '1. Slice the bread.\n2. Toast it.\n3. Serve.',
    });
    const r = extractRecipeFromHtml(html)!;
    expect(r.steps.map((s) => s.description)).toEqual(['Slice the bread.', 'Toast it.', 'Serve.']);
  });

  it('collects tags from category, cuisine and keywords without duplicating', () => {
    const html = page({
      '@type': 'Recipe',
      name: 'Risotto',
      recipeIngredient: ['300 g rice'],
      recipeInstructions: ['Stir.'],
      recipeCategory: 'Main Course',
      recipeCuisine: ['Italian'],
      keywords: 'italian, rice, Main Course',
    });
    const r = extractRecipeFromHtml(html)!;
    expect(r.tags).toContain('Main Course');
    expect(r.tags).toContain('Italian');
    expect(r.tags).toContain('rice');
    // "Main Course" appears in both recipeCategory and keywords.
    expect(r.tags.filter((t) => t === 'Main Course')).toHaveLength(1);
  });

  it('reads an ImageObject cover, not just a URL string', () => {
    const html = page({
      '@type': 'Recipe',
      name: 'Cake',
      recipeIngredient: ['200 g flour'],
      recipeInstructions: ['Bake.'],
      image: { '@type': 'ImageObject', url: 'https://example.com/cake.jpg', width: 800 },
    });
    expect(extractRecipeFromHtml(html)!.imageUrl).toBe('https://example.com/cake.jpg');
  });

  it('falls back to totalTime only when there is nothing better', () => {
    const onlyTotal = extractRecipeFromHtml(page({
      '@type': 'Recipe', name: 'Stew', totalTime: 'PT2H',
      recipeIngredient: ['1 kg beef'], recipeInstructions: ['Simmer.'],
    }))!;
    expect(onlyTotal.cookTimeMin).toBe(120);

    // A real cookTime always wins, and totalTime is not added on top of a
    // prepTime it already includes.
    const withBoth = extractRecipeFromHtml(page({
      '@type': 'Recipe', name: 'Stew', totalTime: 'PT2H', prepTime: 'PT15M', cookTime: 'PT1H45M',
      recipeIngredient: ['1 kg beef'], recipeInstructions: ['Simmer.'],
    }))!;
    expect(withBoth.cookTimeMin).toBe(105);

    const totalPlusPrep = extractRecipeFromHtml(page({
      '@type': 'Recipe', name: 'Stew', totalTime: 'PT2H', prepTime: 'PT15M',
      recipeIngredient: ['1 kg beef'], recipeInstructions: ['Simmer.'],
    }))!;
    expect(totalPlusPrep.cookTimeMin).toBeUndefined();
  });

  it('survives a malformed block by trying the others', () => {
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Recipe', name: 'Survivor',
        recipeIngredient: ['1 egg'], recipeInstructions: ['Fry it.'],
      })}</script>
    </head><body></body></html>`;
    expect(extractRecipeFromHtml(html)!.title).toBe('Survivor');
  });

  it('does not split an ingredient line on its own commas', () => {
    // recipeIngredient is a list of lines; a comma inside one separates the
    // name from its note. Comma-splitting turned "1 celery stick, finely
    // chopped" into two ingredients on a real page.
    const r = extractRecipeFromHtml(page({
      '@type': 'Recipe', name: 'Soffritto',
      recipeIngredient: ['1 celery stick, finely chopped', '1 onion, diced'],
      recipeInstructions: ['Chop.'],
    }))!;
    expect(r.ingredients).toHaveLength(2);
    expect(r.ingredients[0]).toMatchObject({ name: 'celery stick', notes: 'finely chopped' });
  });

  it('returns null when the page has no structured recipe, so the LLM still runs', () => {
    expect(extractRecipeFromHtml('<html><body><p>Just a blog post.</p></body></html>')).toBeNull();
    expect(extractRecipeFromHtml(page({ '@type': 'WebPage', name: 'Not a recipe' }))).toBeNull();
    expect(extractRecipeFromHtml('')).toBeNull();
  });

  it('rejects a stub Recipe node carrying neither ingredients nor steps', () => {
    // Some sites emit an empty Recipe for breadcrumbs. Importing that would
    // create a blank recipe instead of falling through to the LLM.
    expect(extractRecipeFromHtml(page({ '@type': 'Recipe', name: 'Stub only' }))).toBeNull();
  });

  it('warns rather than failing when only one half is present', () => {
    const r = extractRecipeFromHtml(page({
      '@type': 'Recipe', name: 'Ingredients only', recipeIngredient: ['1 egg'],
    }))!;
    expect(r.steps).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/instructions/i);
  });
});
