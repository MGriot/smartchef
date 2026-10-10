import { describe, it, expect } from 'vitest';
import { findMention } from './nameMatch';
import { linkEntitiesInText } from './importLinking';
import { linkIngredientsInText, matchStepIngredients } from './stepRefs';

const text = (s: string, names: string[], kind: 'noun' | 'verb' = 'noun') => {
  const m = findMention(s, names, kind);
  return m ? s.slice(m.start, m.end) : null;
};

describe('findMention', () => {
  it('matches plural, singular and qualified names', () => {
    expect(text('aggiungi un uovo', ['Uova'])).toBe('uovo');
    expect(text('Setaccia la farina con lo zucchero', ['Farina 00'])).toBe('farina');
    expect(text('unisci le fragole', ['Fragola'])).toBe('fragole');
    expect(text('mix the eggs', ['Egg'])).toBe('eggs');
  });

  it('matches verbs by their stem across conjugations', () => {
    expect(text('Sbatti le uova', ['Sbattere'], 'verb')).toBe('Sbatti');
    expect(text('setacciate la farina', ['Setacciare'], 'verb')).toBe('setacciate');
    expect(text('Whisk until smooth, whisking often', ['Whisk'], 'verb')).toBe('Whisk');
    expect(text('cuoci nel forno', ['Cuocere in forno'], 'verb')).toBe('cuoci nel forno');
  });

  it('never matches inside another word or an existing token', () => {
    expect(text('Il fornaio lavora', ['Forno'])).toBeNull();
    expect(text('olive nere', ['Olio'])).toBeNull();
    expect(text('Usa {{ing:1}} ora', ['Ingrediente'])).toBeNull();
  });

  it('is accent- and case-insensitive and keeps the original text', () => {
    expect(text('Lascia lievitare la PASTA', ['pasta'])).toBe('PASTA');
    expect(text('Frullare la crème', ['Creme'])).toBe('crème');
  });
});

describe('import linking with a model that names things in English', () => {
  it('links tools and techniques through any of their library names', () => {
    const out = linkEntitiesInText('Sbatti le uova con la frusta.', 'tool', [{ id: 'T1', names: ['Whisk', 'Frusta'] }]);
    expect(out).toBe('Sbatti le uova con la {{tool:T1}}.');
    expect(linkEntitiesInText(out, 'tech', [{ id: 'K1', names: ['Beat', 'Sbattere'] }])).toBe('{{tech:K1}} le uova con la {{tool:T1}}.');
  });

  it('links an ingredient the step names in another form', () => {
    const ings = [{ name: 'Farina 00' }, { name: 'Uova' }, { name: 'Zucchero a velo' }];
    const refs = matchStepIngredients([{ name: 'Farina 00' }, { name: 'Uova' }, { name: 'Zucchero a velo' }], ings);
    expect(linkIngredientsInText('Setaccia la farina con lo zucchero a velo e aggiungi un uovo.', refs, ings))
      .toBe('Setaccia la {{ing:0}} con lo {{ing:2}} e aggiungi un {{ing:1}}.');
  });
});
