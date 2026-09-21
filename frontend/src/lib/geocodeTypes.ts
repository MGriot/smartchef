// ════════════════════════════════════════════════════════════════════════
// SmartChef — what a geocode answer looks like
//
// One definition for all three transports (backend/src/routes/geocode.ts,
// electronBridge.ts, gitHttpBridge.ts) and for the two maps. They already
// had three copies of the same inline shape; adding outlines to it would
// have made four.
// ════════════════════════════════════════════════════════════════════════

/** A GeoJSON Polygon or MultiPolygon, as Nominatim returns it. Left
 *  loosely typed because it goes straight to Leaflet's <GeoJSON>, which
 *  does its own validation, and is stored as opaque JSON in between. */
export type PlaceShape = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  /** The place's outline, when one was asked for and Nominatim had one
   *  small enough to carry. */
  shape?: PlaceShape;
  /** Nominatim's own classification of the place. */
  category?: string;
  kind?: string;
}

/** Whether a result describes an AREA rather than a point.
 *
 *  This is the distinction the map was missing: Sardinia and Pinerolo both
 *  arrived as a lat/lng, so both became a dot, and a whole island was
 *  marked with a pin in the sea off its east coast.
 *
 *  Nominatim will hand back a municipal boundary for a city too, so having
 *  a polygon is not enough on its own — a city is conventionally a point
 *  on a map at this scale, and drawing its administrative limits would say
 *  more than the recipe means. Only an explicit boundary, or one of the
 *  sub-national place types, is drawn as an area. */
export function isAreaResult(result: Pick<GeocodeResult, 'shape' | 'category' | 'kind'>): boolean {
  if (!result.shape) return false;
  if (result.category === 'boundary') return true;
  if (result.category !== 'place') return false;
  return ['region', 'state', 'province', 'county', 'district', 'island', 'archipelago'].includes(result.kind ?? '');
}
