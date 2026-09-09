import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, GeoJSON, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Feature, Geometry } from 'geojson';
import { countryCentroid, countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';
import { countryFeatureFor } from '../lib/worldGeo';

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
        {/* Esri's public ArcGIS Online basemap. Free, no API key, no signup,
            and — the property that actually matters here — it serves tiles
            regardless of what Referer the request carries.

            This app has now been through every other obvious option, each
            of which failed for its own reason:
              - tile.openstreetmap.org answers `x-blocked: Access denied`.
                Their tile usage policy forbids embedding raw OSM tiles in
                an app without running your own infrastructure, so this is
                policy, not a bug, and won't change.
              - basemaps.cartocdn.com began requiring a (free, signup-gated)
                API key and now watermarks tiles "API KEY REQUIRED".
              - maps.wikimedia.org 403s any request whose Referer isn't
                http(s). The Electron build serves its pages from
                capacitor-electron://-/, which Chromium attaches as the
                Referer on every tile <img>, so the desktop app got a blank
                basemap while Android (https://localhost) was fine. Setting
                referrerPolicy="no-referrer" was not enough to rescue it in
                the real app, which is why the provider changed instead of
                the header.

            Measured against the live endpoints with the app's own
            Electron user agent, both with `Referer: capacitor-electron://-/`
            and with none at all:
              wikimedia   ref:403  noref:200   <- the bug
              esri        ref:200  noref:200   <- chosen
            So this works on Electron, Android and web alike, and does not
            depend on any header being stripped.

            referrerPolicy is kept as belt-and-braces (it tested fine both
            ways above) so a future provider that dislikes the custom scheme
            degrades to "no Referer" rather than to a blank map. */}
        {/* The credit is kept to "Tiles (c) Esri" with the full data-source
            list moved into the link's title: spelled out inline it wrapped to
            four lines and covered the bottom quarter of the map, which is
            only ~220px tall. Hovering still shows the whole list. */}
        <TileLayer
          attribution='Tiles &copy; <a href="https://www.esri.com" title="Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom">Esri</a>'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
          maxZoom={19}
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
