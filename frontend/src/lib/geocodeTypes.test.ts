import { describe, it, expect } from 'vitest';
import { isAreaResult } from './geocodeTypes';

const polygon = { type: 'Polygon' as const, coordinates: [] };

describe('isAreaResult', () => {
  it('treats an administrative boundary as an area', () => {
    // Sardigna/Sardegna, the case that started this: a whole island was
    // marked with a pin in the sea off its east coast.
    expect(isAreaResult({ shape: polygon, category: 'boundary', kind: 'administrative' })).toBe(true);
  });

  it('treats a named region or island as an area', () => {
    for (const kind of ['region', 'state', 'province', 'county', 'district', 'island', 'archipelago']) {
      expect(isAreaResult({ shape: polygon, category: 'place', kind })).toBe(true);
    }
  });

  it('keeps a city a point even though Nominatim offers its boundary', () => {
    // Drawing a city's administrative limits says more than the recipe
    // means — "from Pinerolo" is a place, not a jurisdiction.
    expect(isAreaResult({ shape: polygon, category: 'place', kind: 'city' })).toBe(false);
    expect(isAreaResult({ shape: polygon, category: 'place', kind: 'town' })).toBe(false);
    expect(isAreaResult({ shape: polygon, category: 'place', kind: 'village' })).toBe(false);
  });

  it('keeps anything with no outline a point', () => {
    expect(isAreaResult({ category: 'boundary', kind: 'administrative' })).toBe(false);
    expect(isAreaResult({})).toBe(false);
  });

  it('is not fooled by an unrelated category that happens to have a shape', () => {
    // A restaurant, a building, a road: all things Nominatim will return a
    // polygon for and none of them a region.
    expect(isAreaResult({ shape: polygon, category: 'amenity', kind: 'restaurant' })).toBe(false);
    expect(isAreaResult({ shape: polygon, category: 'highway', kind: 'residential' })).toBe(false);
  });
});
