import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, GeoJSON, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import worldTopo from 'world-atlas/countries-50m.json';
import { alpha2ToNumeric } from 'i18n-iso-countries';
import { countryCentroid, countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';

interface RegionCoord { lat: number; lng: number }

interface RegionsMapProps {
  regions: string[];
  /** Coords for free-text (non-country) regions, keyed by lowercased label — from RegionPicker's geocoding. */
  coords?: Record<string, RegionCoord>;
}

// A small colored-dot DivIcon instead of Leaflet's default marker images —
// avoids the well-known bundler headache of resolving its default PNG icon
// URLs, and matches the app's flat visual style better than a pin.
function dotIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}
const countryIcon = dotIcon('#f97316');
const placeIcon = dotIcon('#3b82f6');

// Natural Earth's 50m-resolution country boundaries (via `world-atlas`,
// ~750KB, bundled so this works fully offline like the rest of the app).
// The 110m variant (~110KB) was tried first but its polygons are simplified
// for whole-world atlas views — coarse enough that zooming in on a single
// country showed visibly straight, blocky edges that looked like rendering
// glitches rather than a real coastline. 50m still isn't survey-grade, but
// holds up to the zoom level this widget's +/- controls actually allow (see
// MapContainer's maxZoom below). Each feature's `id` is the ISO 3166-1
// *numeric* code, so a region's alpha-2 code (our own format, see
// lib/countries.ts) needs converting via `i18n-iso-countries` before it can
// be looked up here. Built once at module load, not per-render.
const countryFeatures: FeatureCollection = feature(
  worldTopo as unknown as Topology,
  (worldTopo as unknown as Topology).objects.countries as GeometryCollection
) as unknown as FeatureCollection;

const featureByNumericId = new Map<number, Feature<Geometry>>();
for (const f of countryFeatures.features) {
  if (f.id !== undefined) featureByNumericId.set(Number(f.id), f as Feature<Geometry>);
}

function countryFeatureFor(alpha2: string): Feature<Geometry> | undefined {
  const numeric = alpha2ToNumeric(alpha2);
  if (!numeric) return undefined;
  return featureByNumericId.get(Number(numeric));
}

/**
 * Read-only visualization of a recipe's selected regions:
 *  - an ISO country code whose boundary we have gets its whole area filled
 *    in (orange) — "Brazil" highlights the country, not just a dot.
 *  - an ISO country code we can't resolve a boundary for (a handful of tiny
 *    territories missing from the 110m dataset) falls back to the same
 *    centroid dot as before, so nothing silently disappears.
 *  - a free-text region that's been geocoded (`coords`) still gets a plain
 *    point marker (blue) — a single address/city has no "area" to fill.
 * Selection itself happens in RegionPicker; this never writes back.
 */
export default function RegionsMap({ regions, coords = {} }: RegionsMapProps) {
  const { areas, points } = useMemo(() => {
    const areas: { key: string; label: string; geo: Feature<Geometry> }[] = [];
    const countryDots: { key: string; lat: number; lng: number; isCountry: true; label: string }[] = [];
    for (const code of regions.filter(isCountryCode)) {
      const geo = countryFeatureFor(code);
      if (geo) {
        areas.push({ key: code, label: code, geo });
        continue;
      }
      const centroid = countryCentroid(code);
      if (centroid) countryDots.push({ key: code, lat: centroid.lat, lng: centroid.lng, isCountry: true, label: code });
    }
    const placePoints = regions
      .filter((r) => !isCountryCode(r))
      .map((label) => {
        const c = coords[label.toLowerCase()];
        return c ? { key: label, lat: c.lat, lng: c.lng, isCountry: false as const, label } : null;
      })
      .filter((p): p is NonNullable<typeof p> => !!p);
    return { areas, points: [...countryDots, ...placePoints] };
  }, [regions, coords]);

  // Plain computation, not useMemo — hooks can't follow the early return
  // below, and this is cheap enough (a handful of regions at most) to not
  // need memoizing anyway.
  const bounds = L.latLngBounds([]);
  for (const a of areas) bounds.extend(L.geoJSON(a.geo).getBounds());
  for (const p of points) bounds.extend([p.lat, p.lng]);

  if (areas.length === 0 && points.length === 0) return null;

  const singlePoint = areas.length === 0 && points.length === 1;

  return (
    <div className="rounded-2xl overflow-hidden h-56 relative z-0">
      <MapContainer
        {...(singlePoint
          ? { center: [points[0].lat, points[0].lng] as [number, number], zoom: 5 }
          : { bounds, boundsOptions: { padding: [20, 20] as [number, number] } })}
        // This widget answers "which country/place is this recipe from,"
        // not "what does this street look like" — capping how far the +/-
        // controls can zoom keeps the view at a scale the 50m-resolution
        // country polygons above actually look right at, instead of letting
        // users zoom in far enough to see individual straight polygon edges.
        maxZoom={9}
        scrollWheelZoom={false}
        // Water-ish fallback tone (not Leaflet's harsher default gray) for
        // the brief moment a tile is still loading, instead of a jarring
        // blank patch.
        style={{ background: '#c8dce8' }}
        className="w-full h-full"
      >
        {/* Wikimedia's public tile service — genuinely free, no API key or
            signup required for reasonable external embedding (see
            https://wikitech.wikimedia.org/wiki/Maps/Public_tile_service_terms_of_use).
            Switched from CARTO's basemaps.cartocdn.com after CARTO started
            requiring a (free, but signup-gated) API key for that endpoint —
            its tiles now render with a diagonal "API KEY REQUIRED"
            watermark without one. tile.openstreetmap.org itself already
            actively blocks this app's traffic (see git history), which is
            why this isn't just OSM's own tile server.
            No `{r}` (@2x retina) suffix on purpose — Wikimedia's raster
            tiles aren't reliably pre-rendered at @2x for every tile
            (sparser areas especially, e.g. open ocean), which showed up as
            solid gray gaps on HiDPI displays. Slightly softer on retina
            screens, but every tile actually exists. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://maps.wikimedia.org/osm-intl/{z}/{x}/{y}.png"
          maxZoom={19}
          // Wikimedia rejects a tile request whose Referer isn't http(s) —
          // it answers 403, and since a failed <img> is silent, the map just
          // renders as the bare `background` colour above with the GeoJSON
          // overlays (plain SVG, no network) still drawn on top. The Electron
          // build serves its pages from capacitor-electron://-/, and Chromium
          // attaches that as the Referer on every tile, so the desktop app got
          // no basemap at all while Android (served from https://localhost)
          // was fine. Sending no Referer at all is accepted — verified against
          // the live endpoint: no Referer 200, capacitor-electron:// 403.
          referrerPolicy="no-referrer"
        />
        {areas.map((a) => (
          <GeoJSON
            key={a.key}
            data={a.geo}
            style={{ color: '#f97316', weight: 1.5, fillColor: '#f97316', fillOpacity: 0.35 }}
          >
            <Tooltip>{`${flagEmoji(a.label)} ${countryDisplayName(a.label, navigator.language)}`}</Tooltip>
          </GeoJSON>
        ))}
        {points.map((p) => (
          <Marker key={p.key} position={[p.lat, p.lng]} icon={p.isCountry ? countryIcon : placeIcon}>
            <Tooltip>{p.isCountry ? `${flagEmoji(p.label)} ${countryDisplayName(p.label, navigator.language)}` : p.label}</Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
