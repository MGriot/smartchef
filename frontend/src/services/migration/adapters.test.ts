// ════════════════════════════════════════════════════════════════════════
// Reading other apps' exports.
//
// Fixtures follow each app's real export shape, including the awkward
// parts: Paprika's newline-delimited ingredient and direction blocks with
// "For the sauce:" headings inside them, and its zip-of-gzipped-JSON
// container; Mealie's structured food/unit objects; Crouton's nested
// quantity objects.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { gzipSync, deflateRawSync, crc32 } from 'node:zlib';
import { readMigrationFile } from './adapters';

const enc = new TextEncoder();

/** Minimal real zip, same construction as zipReader.test.ts. */
function makeZip(files: Array<{ name: string; content: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = new Uint8Array(deflateRawSync(file.content));
    const crc = crc32(Buffer.from(file.content));
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
    lv.setUint32(22, file.content.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); local.set(data, 30 + nameBytes.length);
    locals.push(local);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.content.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

const PAPRIKA = {
  name: 'Ragù alla bolognese',
  servings: '6 servings',
  prep_time: '20',
  cook_time: '180',
  categories: ['Mains', 'Italian'],
  source_url: 'https://example.com/ragu',
  notes: 'Better the next day.',
  ingredients: 'For the sauce:\n500 g beef mince\n2 tbsp olive oil\n1 onion, finely chopped\n\nTo serve:\n400 g tagliatelle',
  directions: '1. Brown the mince.\n2. Add the soffritto.\n3. Simmer for three hours.',
};

describe('Paprika', () => {
  it('reads a .paprikarecipes archive of gzipped JSON', async () => {
    const zip = makeZip([
      { name: 'Ragu.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(PAPRIKA)))) },
    ]);
    const result = (await readMigrationFile('library.paprikarecipes', zip))!;
    expect(result.source).toBe('paprika');
    expect(result.recipes).toHaveLength(1);

    const r = result.recipes[0];
    expect(r.title).toBe('Ragù alla bolognese');
    expect(r.servings).toBe(6);
    expect(r.prepTimeMin).toBe(20);
    expect(r.cookTimeMin).toBe(180);
    expect(r.tags).toEqual(['Mains', 'Italian']);
    expect(r.sourceUrl).toBe('https://example.com/ragu');
    expect(r.tips).toBe('Better the next day.');
  });

  it('turns "For the sauce:" headings into ingredient groups, not ingredients', async () => {
    const zip = makeZip([
      { name: 'a.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(PAPRIKA)))) },
    ]);
    const r = (await readMigrationFile('x.paprikarecipes', zip))!.recipes[0];

    // Four ingredients, not six — the two headings are groups.
    expect(r.ingredients.map((i) => i.name)).toEqual(['beef mince', 'olive oil', 'onion', 'tagliatelle']);
    expect(r.ingredients[0].groupName).toBe('For the sauce');
    expect(r.ingredients[3].groupName).toBe('To serve');
    expect(r.ingredients[0]).toMatchObject({ quantity: 500, unit: 'g' });
    expect(r.ingredients[2]).toMatchObject({ name: 'onion', notes: 'finely chopped' });
  });

  it('numbers steps and strips their original numbering', async () => {
    const zip = makeZip([
      { name: 'a.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(PAPRIKA)))) },
    ]);
    const r = (await readMigrationFile('x.paprikarecipes', zip))!.recipes[0];
    expect(r.steps.map((s) => s.description)).toEqual([
      'Brown the mince.', 'Add the soffritto.', 'Simmer for three hours.',
    ]);
    expect(r.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3]);
  });

  it('reads a single ungzipped .paprikarecipe too', async () => {
    const result = (await readMigrationFile('one.paprikarecipe', enc.encode(JSON.stringify(PAPRIKA))))!;
    expect(result.recipes[0].title).toBe('Ragù alla bolognese');
  });

  it('imports what it can and reports what it could not', async () => {
    // A 200-recipe export with three bad entries should yield 197, not fail.
    const zip = makeZip([
      { name: 'good.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(PAPRIKA)))) },
      { name: 'broken.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from('{ not json'))) },
      { name: 'nameless.paprikarecipe', content: new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ ingredients: 'x', directions: 'y' })))) },
    ]);
    const result = (await readMigrationFile('lib.paprikarecipes', zip))!;
    expect(result.recipes).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
  });
});

describe('Mealie', () => {
  const MEALIE = {
    name: 'Panzanella',
    slug: 'panzanella',
    description: 'Tuscan bread salad.',
    recipeYield: '4 servings',
    prepTime: 'PT15M',
    cookTime: 'PT0M',
    orgURL: 'https://example.com/panzanella',
    tags: [{ name: 'salad' }, { name: 'summer' }],
    recipeIngredient: [
      { quantity: 500, unit: { abbreviation: 'g' }, food: { name: 'ripe tomatoes' }, note: 'cut into chunks' },
      { quantity: 200, unit: { name: 'g' }, food: { name: 'stale bread' } },
      { display: '3 tbsp extra-virgin olive oil' },
    ],
    recipeInstructions: [
      { title: 'Prep', text: 'Tear the bread.' },
      { text: 'Toss everything together.' },
    ],
    notes: [{ text: 'Best after 30 minutes.' }],
  };

  it('prefers structured food/unit objects over the display string', async () => {
    const result = (await readMigrationFile('mealie.json', enc.encode(JSON.stringify(MEALIE))))!;
    expect(result.source).toBe('mealie');

    const r = result.recipes[0];
    expect(r.title).toBe('Panzanella');
    expect(r.servings).toBe(4);
    expect(r.prepTimeMin).toBe(15);
    expect(r.tags).toEqual(['salad', 'summer']);
    expect(r.ingredients[0]).toMatchObject({ name: 'ripe tomatoes', quantity: 500, unit: 'g', notes: 'cut into chunks' });
    expect(r.ingredients[1]).toMatchObject({ name: 'stale bread', quantity: 200, unit: 'g' });
  });

  it('falls back to parsing the display line when there is no structure', async () => {
    const r = (await readMigrationFile('mealie.json', enc.encode(JSON.stringify(MEALIE))))!.recipes[0];
    expect(r.ingredients[2]).toMatchObject({ name: 'extra-virgin olive oil', quantity: 3, unit: 'tbsp' });
  });

  it('keeps a step title and renumbers', async () => {
    const r = (await readMigrationFile('mealie.json', enc.encode(JSON.stringify(MEALIE))))!.recipes[0];
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]).toMatchObject({ stepNumber: 1, title: 'Prep', description: 'Tear the bread.' });
    expect(r.tips).toBe('Best after 30 minutes.');
  });

  it('reads a bulk export wrapped in a recipes array', async () => {
    const bulk = { recipes: [MEALIE, { ...MEALIE, name: 'Second' }] };
    const result = (await readMigrationFile('export.json', enc.encode(JSON.stringify(bulk))))!;
    expect(result.recipes.map((r) => r.title)).toEqual(['Panzanella', 'Second']);
  });

  it('reads a zipped bulk export', async () => {
    const zip = makeZip([
      { name: 'recipes/panzanella.json', content: enc.encode(JSON.stringify(MEALIE)) },
      { name: 'recipes/other.json', content: enc.encode(JSON.stringify({ ...MEALIE, name: 'Other' })) },
    ]);
    const result = (await readMigrationFile('mealie-export.zip', zip))!;
    expect(result.recipes.map((r) => r.title).sort()).toEqual(['Other', 'Panzanella']);
  });
});

describe('Crouton', () => {
  it('reads its nested quantity objects', async () => {
    const crouton = {
      uuid: 'abc-123',
      name: 'Focaccia',
      serves: 8,
      tags: ['bread'],
      webLink: 'https://example.com/focaccia',
      ingredients: [
        { ingredient: { name: 'flour' }, quantity: { amount: 500, quantityType: 'g' } },
        { ingredient: { name: 'water' }, quantity: { amount: 350, quantityType: 'ml' } },
      ],
      steps: [{ step: 'Mix and rest.' }, { step: 'Bake hot.' }],
    };
    const result = (await readMigrationFile('focaccia.crumb', enc.encode(JSON.stringify(crouton))))!;
    expect(result.source).toBe('crouton');
    expect(result.recipes[0]).toMatchObject({ title: 'Focaccia', servings: 8 });
    expect(result.recipes[0].ingredients[0]).toMatchObject({ name: 'flour', quantity: 500, unit: 'g' });
    expect(result.recipes[0].steps).toHaveLength(2);
  });
});

describe('schema.org exports (Nextcloud Cookbook, RecipeSage JSON-LD)', () => {
  it('reads a plain schema.org recipe document', async () => {
    const doc = {
      '@type': 'Recipe',
      name: 'Tortilla',
      recipeYield: '4',
      recipeIngredient: ['6 eggs', '500 g potatoes'],
      recipeInstructions: ['Fry the potatoes.', 'Add the eggs.'],
    };
    const result = (await readMigrationFile('recipe.json', enc.encode(JSON.stringify(doc))))!;
    expect(result.recipes[0].title).toBe('Tortilla');
    expect(result.recipes[0].ingredients).toHaveLength(2);
  });
});

describe('CopyMeThat', () => {
  it('reads the schema.org data still embedded in its HTML export', async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe', name: 'Banana bread',
      recipeIngredient: ['3 bananas', '200 g flour'],
      recipeInstructions: ['Mash. Mix. Bake.'],
    })}</script></head><body></body></html>`;
    const result = (await readMigrationFile('recipes.html', enc.encode(html)))!;
    expect(result.source).toBe('copymethat');
    expect(result.recipes[0].title).toBe('Banana bread');
  });
});

describe('declining files that are not migrations', () => {
  it('leaves SmartChef’s own bundle to its own importer', async () => {
    // Hijacking this would break the existing share-bundle import.
    const bundle = { formatVersion: 1, recipes: [{ id: 'x', title: 'Mine' }] };
    expect(await readMigrationFile('mine.smartchef.json', enc.encode(JSON.stringify(bundle)))).toBeNull();
  });

  it('returns null for unrelated files rather than a misleading error', async () => {
    expect(await readMigrationFile('notes.json', enc.encode('{"hello":"world"}'))).toBeNull();
    expect(await readMigrationFile('notes.txt', enc.encode('just some text'))).toBeNull();
  });
});
