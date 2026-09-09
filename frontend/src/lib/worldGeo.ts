import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import worldTopo from 'world-atlas/countries-50m.json';
import { alpha2ToNumeric } from 'i18n-iso-countries';

// Natural Earth's 50m-resolution country boundaries (via `world-atlas`,
// ~750KB, bundled so this works fully offline like the rest of the app).
// The 110m variant (~110KB) was tried first but its polygons are simplified
// for whole-world atlas views — coarse enough that zooming in on a single
// country showed visibly straight, blocky edges that looked like rendering
// glitches rather than a real coastline. 50m still isn't survey-grade, but
// holds up to the zoom levels the map widgets actually allow.
//
// Each feature's `id` is the ISO 3166-1 *numeric* code, so a region's
// alpha-2 code (our own format, see lib/countries.ts) needs converting via
// `i18n-iso-countries` before it can be looked up here. Built once at module
// load, not per-render — and shared by every map in the app (a recipe's own
// RegionsMap and the atlas choropleth) so the 750KB parse happens once.
const countryFeatures: FeatureCollection = feature(
  worldTopo as unknown as Topology,
  (worldTopo as unknown as Topology).objects.countries as GeometryCollection
) as unknown as FeatureCollection;

const featureByNumericId = new Map<number, Feature<Geometry>>();
for (const f of countryFeatures.features) {
  if (f.id !== undefined) featureByNumericId.set(Number(f.id), f as Feature<Geometry>);
}

/** The boundary polygon for an ISO 3166-1 alpha-2 code, when we have one —
 *  a handful of tiny territories are missing from the dataset, and callers
 *  are expected to fall back to a centroid dot for those. */
export function countryFeatureFor(alpha2: string): Feature<Geometry> | undefined {
  const numeric = alpha2ToNumeric(alpha2);
  if (!numeric) return undefined;
  return featureByNumericId.get(Number(numeric));
}
