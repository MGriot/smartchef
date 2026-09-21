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
    /** base64 — present only for a response small enough to cross inline
     *  (see GitHttpPlugin.java's INLINE_MAX_BYTES). */
    body?: string;
    /** Set instead of `body` for a large response: the native side has
     *  streamed it to a file in the app cache, and the caller must read it
     *  with readBodyChunk() and then releaseBody() it. This is what keeps a
     *  full-history pack — ~16 MB on a real library, and always fetched
     *  whole on a device's FIRST sync — from being base64'd and
     *  JSON-serialized across the bridge in one piece, which killed the
     *  WebView renderer outright. */
    bodyFile?: string;
    bodyLength: number;
  }>;
  /** One bounded slice of a spilled body. Returns fewer bytes than asked
   *  for at the end of the file, and `bytesRead: 0` past it. */
  readBodyChunk(opts: { path: string; offset: number; length: number }): Promise<{
    data: string; // base64
    bytesRead: number;
    /** The offset the native side actually read from, echoed so a
     *  mismatch can be caught — see spilledBody.ts. Absent on native
     *  builds older than 1.2.1. */
    offset?: number;
  }>;
  /** Deletes a spilled body. Succeeds if it is already gone. */
  releaseBody(opts: { path: string }): Promise<void>;
  /** Download progress, emitted by the native side while it streams a
   *  response to disk. See observeDownloadProgress() below for why this
   *  has to come from there and cannot come from isomorphic-git. */
  addListener(
    eventName: 'gitHttpProgress',
    listener: (event: { url: string; loaded: number; total: number; done?: boolean }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

export const GitHttp = registerPlugin<GitHttpPlugin>('GitHttp');

/** Reports bytes as the native side downloads a response.
 *
 *  This exists because isomorphic-git's own onProgress cannot do the job
 *  here. Its progress comes from the server's sideband messages, which it
 *  parses WHILE reading the response body — but this app's transport hands
 *  the renderer a response that native code has already downloaded in
 *  full, so nothing can fire until the work is finished. A first-run clone
 *  therefore showed "connecting" for its entire duration, which is
 *  indistinguishable from being stuck, and was reported as exactly that.
 *
 *  Electron has no equivalent: its IPC handler resolves with the whole
 *  body too, and there is no plugin event channel. Returning a no-op
 *  unsubscribe there keeps callers branch-free — the phases they show just
 *  stay coarse, which on a desktop is not what anyone is waiting on.
 *
 *  Returns an unsubscribe function; call it when the operation ends, or a
 *  later download will keep driving a screen that has moved on. */
export function observeDownloadProgress(
  onProgress: (loaded: number, total: number, done: boolean) => void
): () => void {
  let removePromise: Promise<{ remove: () => Promise<void> }> | null = null;
  let cancelled = false;
  try {
    removePromise = GitHttp.addListener('gitHttpProgress', (e) => {
      if (!cancelled) onProgress(e.loaded, e.total, e.done === true);
    });
  } catch {
    // No plugin here (Electron, or a test double without addListener).
    return () => {};
  }
  return () => {
    cancelled = true;
    void removePromise?.then((h) => h.remove()).catch(() => {});
  };
}

import type { GeocodeResult } from './geocodeTypes';

/** Kept in step with backend/src/routes/geocode.ts — see there for why an
 *  outline is simplified and size-capped before it is carried. */
const POLYGON_THRESHOLD = 0.01;
const MAX_SHAPE_BYTES = 60_000;

function withinBudget(geojson: unknown): GeocodeResult['shape'] {
  if (!geojson || typeof geojson !== 'object') return undefined;
  const type = (geojson as { type?: string }).type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return undefined;
  return JSON.stringify(geojson).length > MAX_SHAPE_BYTES ? undefined : (geojson as GeocodeResult['shape']);
}

// Renderer-side cache — Android has no separate main/renderer process split
// the way Electron does, so there's no natural "shared across windows"
// home for this the way electron/src/index.ts's geocodeCache has; a plain
// module-level Map here is exactly as effective for the same purpose
// (skip re-geocoding the same free-text region repeatedly).
const geocodeCache = new Map<string, GeocodeResult[]>();

/** Android's counterpart to electronBridge.ts's electronGeocode() — same
 *  Nominatim endpoint, same User-Agent (its usage policy requires one
 *  identifying the application; a plain WebView fetch() can't set it,
 *  browsers reserve that header for themselves), routed through the
 *  GitHttpPlugin native request above instead of Electron's main-process
 *  IPC. null on no match or any failure — RegionsMap.tsx/RegionPicker.tsx
 *  already treat a missing pin as "not geocoded yet," not an error. */
export async function androidGeocode(q: string, limit = 1, shape = false): Promise<GeocodeResult[]> {
  const query = q.trim();
  if (!query) return [];
  const max = Math.min(8, Math.max(1, Math.trunc(limit) || 1));
  const key = `${max}:${shape ? 'shape:' : ''}${query.toLowerCase()}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  try {
    const shapeParams = shape ? `&polygon_geojson=1&polygon_threshold=${POLYGON_THRESHOLD}` : '';
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${max}${shapeParams}&q=${encodeURIComponent(query)}`;
    const res = await GitHttp.request({ url, method: 'GET', headers: { 'User-Agent': 'SmartChef/1.0 (self-hosted recipe app)' } });
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Nominatim error ${res.statusCode}`);
    // `body` rather than `bodyFile`: a Nominatim answer for one query is a
    // few KB, far under the plugin's inline threshold, so it never spills.
    // Treated as "no match" rather than asserted, since the field is now
    // optional — this function's contract is already best-effort.
    if (!res.body) return [];
    const raw = JSON.parse(new TextDecoder().decode(base64ToBytes(res.body))) as Array<{
      lat: string; lon: string; display_name: string; geojson?: unknown; class?: string; type?: string;
    }>;
    const results: GeocodeResult[] = raw.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name,
      ...(shape ? { shape: withinBudget(r.geojson), category: r.class, kind: r.type } : {}),
    }));
    geocodeCache.set(key, results);
    return results;
  } catch (err) {
    // Not cached, unlike a confirmed no-results — a transient failure
    // (network blip, timeout) shouldn't permanently block a retry for
    // this query, matching electronGeocode()'s own catch behavior.
    console.error('SmartChef: Android geocode failed:', err);
    return [];
  }
}
