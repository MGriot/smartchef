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
}

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

geocodeRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });
  const limit = parseLimit(req.query.limit);

  // `data` is the first match (every caller that predates the search box
  // reads only that); `results` is the whole list.
  const respond = (results: GeocodeResult[]) =>
    results.length
      ? res.json({ data: results[0], results })
      : res.status(404).json({ error: "No match found" });

  const key = `${limit}:${q.toLowerCase()}`;
  if (cache.has(key)) return respond(cache.get(key)!);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${limit}&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "SmartChef/1.0 (self-hosted recipe app)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);

    const raw = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    const results: GeocodeResult[] = raw.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name,
    }));
    cache.set(key, results);
    respond(results);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Geocoding failed" });
  }
});
