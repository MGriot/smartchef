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

const cache = new Map<string, GeocodeResult | null>();

geocodeRouter.get("/", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.status(400).json({ error: "Missing q" });

  const key = q.toLowerCase();
  if (cache.has(key)) {
    const cached = cache.get(key)!;
    return cached ? res.json({ data: cached }) : res.status(404).json({ error: "No match found" });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "SmartChef/1.0 (self-hosted recipe app)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);

    const results = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!results.length) {
      cache.set(key, null);
      return res.status(404).json({ error: "No match found" });
    }

    const result: GeocodeResult = {
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon),
      displayName: results[0].display_name,
    };
    cache.set(key, result);
    res.json({ data: result });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Geocoding failed" });
  }
});
