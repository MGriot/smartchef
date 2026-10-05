import { describe, it, expect } from 'vitest';
import { linkEntitiesInText, resolveRegions } from './importLinking';

describe('linkEntitiesInText', () => {
  it('links the first whole-word mention using any of the names', () => {
    const out = linkEntitiesInText('Preriscalda il forno e inforna nel forno.', 'tool', [
      { id: 't1', names: ['Oven', 'Forno'] },
    ]);
    expect(out).toBe('Preriscalda il {{tool:t1}} e inforna nel forno.');
  });

  it('prefers the longer name', () => {
    const out = linkEntitiesInText('Use the stand mixer to whip.', 'tool', [
      { id: 't2', names: ['Mixer', 'Stand Mixer'] },
    ]);
    expect(out).toBe('Use the {{tool:t2}} to whip.');
  });

  it('does not link inside words, existing tokens or short names', () => {
    expect(linkEntitiesInText('Il fornaio lavora.', 'tool', [{ id: 't1', names: ['Forno'] }])).toBe('Il fornaio lavora.');
    expect(linkEntitiesInText('Usa {{tool:t1}} ora.', 'tool', [{ id: 't1', names: ['Usa'] }])).toBe('Usa {{tool:t1}} ora.');
    expect(linkEntitiesInText('a b', 'tech', [{ id: 'x', names: ['a'] }])).toBe('a b');
  });

  it('writes tech tokens', () => {
    expect(linkEntitiesInText('Fai soffriggere la cipolla.', 'tech', [{ id: 'k1', names: ['soffriggere'] }]))
      .toBe('Fai {{tech:k1}} la cipolla.');
  });
});

describe('resolveRegions', () => {
  it('keeps valid country codes and drops invalid ones', async () => {
    const r = await resolveRegions([{ country: 'it', place: null }, { country: 'ZZZ', place: null }]);
    expect(r.regions).toEqual(['IT']);
  });

  it('adds a place with coordinates, plus its country', async () => {
    const r = await resolveRegions(
      [{ country: 'IT', place: 'Toscana' }],
      async () => ({ lat: 43.7, lng: 11.2 }),
    );
    expect(r.regions).toEqual(['Toscana', 'IT']);
    expect(r.regionCoords.toscana).toEqual({ lat: 43.7, lng: 11.2 });
  });

  it('keeps a place as text when geocoding fails', async () => {
    const r = await resolveRegions([{ country: null, place: 'Pinerolo' }], async () => { throw new Error('offline'); });
    expect(r.regions).toEqual(['Pinerolo']);
    expect(r.regionCoords).toEqual({});
  });
});
