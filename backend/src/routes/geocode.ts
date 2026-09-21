// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Geocode (Nominatim proxy)
// Resolves a free-typed place name (city, region, whatever) to lat/lng so
// RegionsMap can place a pin for it, not just the ~195 static countries.
// Proxied server-side rather than called directly from the browser because
// Nominatim's usage policy requires a real identifying User-Agent (a
// browser's default UA doesn't qualify) — this also gives us a place to
// cache and keep the app's usage well under their rate limit.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";

export const geocodeRouter = Router();

interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  /** The place's own outline, only when the caller asked for one. A region
   *  or an area IS a shape; rendering it as a dot in the middle says
   *  something false about where the food is from. */
  shape?: unknown;
  /** Nominatim's own classification. `boundary`/`administrative` is a
   *  region; `place`/`city` is a point even though Nominatim will happily
   *  hand back a municipal boundary for it. */
  category?: string;
  kind?: string;
}

/** Simplification tolerance in degrees (~1 km). An unsimplified regional
 *  boundary is hundreds of kilobytes, and this one ends up inside a recipe
 *  row that syncs to every device. */
const POLYGON_THRESHOLD = 0.01;

/** Past this, keep the point and drop the outline: no map detail is worth
 *  putting a quarter-megabyte of coastline into every device's git
 *  history. */
const MAX_SHAPE_BYTES = 60_000;

// Keyed by "<limit>:<lowercased query>" — a 1-result answer is not the
// answer to an 8-result question, and the region picker asks both.
const cache = new Map<string, GeocodeResult[]>();

/** 1 keeps the original "resolve this one place" behaviour; more turns
 *  this into a search the region picker can offer city/sub-region
 *  suggestions from. Capped so a typo in the query string cannot be used
 *  to hammer Nominatim on the app's User-Agent. */
function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(8, Math.max(1, Math.trunc(n)));
}

/** The outline, unless it is too big to be worth carrying. A Point or
 *  LineString is not an area and is dropped too — the lat/lng already says
 *  everything a point can. */
function withinBudget(geojson: unknown): unknown {
  if (!geojson || typeof geojson !== "object") return undefined;
  const type = (geojson as { type?: string }).type;
  if (type !== "Polygon" && type !== "MultiPolygon") return undefined;
  return JSON.stringify(geojson).length > MAX_SHAPE_BYTES ? undefined : geojson;
}

geocodeRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });
  const limit = parseLimit(req.query.limit);
  // Opt-in: the picker's as-you-type search asks for six results and wants
  // none of this, while the one chosen place asks for its outline once.
  const wantShape = String(req.query.shape ?? "") === "1";

  // `data` is the first match (every caller that predates the search box
  // reads only that); `results` is the whole list.
  const respond = (results: GeocodeResult[]) =>
    results.length
      ? res.json({ data: results[0], results })
      : res.status(404).json({ error: "No match found" });

  const key = `${limit}:${wantShape ? "shape:" : ""}${q.toLowerCase()}`;
  if (cache.has(key)) return respond(cache.get(key)!);

  try {
    const shapeParams = wantShape ? `&polygon_geojson=1&polygon_threshold=${POLYGON_THRESHOLD}` : "";
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${limit}${shapeParams}&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "SmartChef/1.0 (self-hosted recipe app)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);

    const raw = (await response.json()) as Array<{
      lat: string; lon: string; display_name: string;
      geojson?: unknown; class?: string; type?: string;
    }>;
    const results: GeocodeResult[] = raw.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name,
      ...(wantShape ? { shape: withinBudget(r.geojson), category: r.class, kind: r.type } : {}),
    }));
    cache.set(key, results);
    respond(results);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Geocoding failed" });
  }
});
