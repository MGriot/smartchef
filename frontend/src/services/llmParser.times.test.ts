// The recipe-level times of an AI import. The model is told not to invent
// them, and most recipes give durations only inside their steps, so every
// AI import used to save with all three empty. They are now the sum of the
// step durations of each kind unless the recipe states one.

import { describe, expect, it } from 'vitest';
import { parseJsonResponse } from './llmParser.local';

const reply = (extra: Record<string, unknown>, steps: Array<Record<string, unknown>>) =>
  JSON.stringify({ title: 'Zuppa di cipolle', ingredients: [], steps, ...extra });

describe('recipe-level times of an AI import', () => {
  it('adds up the step durations by kind when the recipe states none', () => {
    const out = parseJsonResponse(reply({ prepTimeMin: null, cookTimeMin: null, restTimeMin: null }, [
      { stepNumber: 1, description: 'Affettate le cipolle.', durationMin: 10, timeKind: 'prep' },
      { stepNumber: 2, description: 'Stufatele a fuoco dolce.', durationMin: 40, timeKind: 'cook' },
      { stepNumber: 3, description: 'Gratinate in forno.', durationMin: '15 min', timeKind: 'cook' },
      { stepNumber: 4, description: 'Lasciate intiepidire.', durationMin: 5, timeKind: 'rest' },
      { stepNumber: 5, description: 'Servite.', durationMin: null, timeKind: null },
    ]));
    expect(out.prepTimeMin).toBe(10);
    expect(out.cookTimeMin).toBe(55);
    expect(out.restTimeMin).toBe(5);
    expect(out.steps.map((s) => s.durationMin)).toEqual([10, 40, 15, 5, undefined]);
  });

  it('keeps a time the recipe states and fills only the others', () => {
    const out = parseJsonResponse(reply({ prepTimeMin: 20, cookTimeMin: 'PT1H' }, [
      { stepNumber: 1, description: 'Tagliate.', durationMin: 5, timeKind: 'prep' },
      { stepNumber: 2, description: 'Cuocete.', durationMin: 30, timeKind: 'cook' },
      { stepNumber: 3, description: 'Fate riposare.', durationMin: 120, timeKind: 'rest' },
    ]));
    expect(out).toMatchObject({ prepTimeMin: 20, cookTimeMin: 60, restTimeMin: 120 });
  });

  it('reads the kind from the wording when the model gives none', () => {
    const out = parseJsonResponse(reply({}, [
      { stepNumber: 1, description: 'Cuocete in forno per 25 minuti.', durationMin: 25 },
      { stepNumber: 2, description: 'Fate lievitare per un\'ora.', durationMin: 60 },
    ]));
    expect(out).toMatchObject({ cookTimeMin: 25, restTimeMin: 60 });
    expect(out.prepTimeMin).toBeUndefined();
  });

  it('leaves all three empty when no step has a duration', () => {
    const out = parseJsonResponse(reply({}, [{ stepNumber: 1, description: 'Mescolate.' }]));
    expect([out.prepTimeMin, out.cookTimeMin, out.restTimeMin]).toEqual([undefined, undefined, undefined]);
  });
});
