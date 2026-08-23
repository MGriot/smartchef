// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the GitHttp native plugin
// Android-only (no Electron equivalent — see electronBridge.ts's
// electronHttpRequest() for Electron's own IPC-based version of this same
// idea). Registered via Capacitor.registerPlugin, backed by the
// app-specific GitHttpPlugin.java (frontend/android/app/src/main/java/com/
// smartchef/app/GitHttpPlugin.java) registered directly in MainActivity —
// not a published/npm plugin, so no entry in capacitor.settings.gradle.
// Despite the name, GitHttpPlugin.java has no git-specific logic at all —
// it's a generic "make one HTTP request from native Android code, with
// whatever headers you ask for" primitive, reused below for geocoding too
// (androidGeocode()), same as gitRemoteTransport.ts reuses it for reaching
// a git server's HTTP endpoint. Either way the point is sidestepping the
// WebView's fetch(), which enforces both browser CORS (irrelevant to
// native app code, not to web content) and can't set arbitrary headers
// browsers reserve for themselves (e.g. User-Agent — see androidGeocode()).
// ════════════════════════════════════════════════════════════════════════

import { registerPlugin } from '@capacitor/core';
import { base64ToBytes } from './gitfs';

export interface GitHttpPlugin {
  request(opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string; // base64, omitted for a bodyless request
  }): Promise<{
    url: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: string; // base64
  }>;
}

export const GitHttp = registerPlugin<GitHttpPlugin>('GitHttp');

interface GeocodeResult { lat: number; lng: number; displayName: string }

// Renderer-side cache — Android has no separate main/renderer process split
// the way Electron does, so there's no natural "shared across windows"
// home for this the way electron/src/index.ts's geocodeCache has; a plain
// module-level Map here is exactly as effective for the same purpose
// (skip re-geocoding the same free-text region repeatedly).
const geocodeCache = new Map<string, GeocodeResult | null>();

/** Android's counterpart to electronBridge.ts's electronGeocode() — same
 *  Nominatim endpoint, same User-Agent (its usage policy requires one
 *  identifying the application; a plain WebView fetch() can't set it,
 *  browsers reserve that header for themselves), routed through the
 *  GitHttpPlugin native request above instead of Electron's main-process
 *  IPC. null on no match or any failure — RegionsMap.tsx/RegionPicker.tsx
 *  already treat a missing pin as "not geocoded yet," not an error. */
export async function androidGeocode(q: string): Promise<GeocodeResult | null> {
  const query = q.trim();
  if (!query) return null;
  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await GitHttp.request({ url, method: 'GET', headers: { 'User-Agent': 'SmartChef/1.0 (self-hosted recipe app)' } });
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Nominatim error ${res.statusCode}`);
    const results = JSON.parse(new TextDecoder().decode(base64ToBytes(res.body))) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!results.length) {
      geocodeCache.set(key, null);
      return null;
    }
    const result: GeocodeResult = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), displayName: results[0].display_name };
    geocodeCache.set(key, result);
    return result;
  } catch (err) {
    // Not cached, unlike a confirmed no-results — a transient failure
    // (network blip, timeout) shouldn't permanently block a retry for
    // this query, matching electronGeocode()'s own catch behavior.
    console.error('SmartChef: Android geocode failed:', err);
    return null;
  }
}
