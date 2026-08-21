import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
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

/**
 * Read-only visualization of a recipe's selected regions — one marker per
 * ISO country code (orange, centroid from the static countries.ts list) and
 * one per free-text region that's been successfully geocoded (blue, from
 * `coords`). A free-text region with no geocode result yet (offline, or
 * never resolved) simply gets no pin — it still shows as a chip in
 * RegionPicker, this just can't place it on a map. Selection itself happens
 * in RegionPicker; this never writes back.
 */
export default function RegionsMap({ regions, coords = {} }: RegionsMapProps) {
  const points = useMemo(() => {
    const countryPoints = regions
      .filter(isCountryCode)
      .map((code) => {
        const centroid = countryCentroid(code);
        return centroid ? { key: code, lat: centroid.lat, lng: centroid.lng, isCountry: true, label: code } : null;
      });
    const placePoints = regions
      .filter((r) => !isCountryCode(r))
      .map((label) => {
        const c = coords[label.toLowerCase()];
        return c ? { key: label, lat: c.lat, lng: c.lng, isCountry: false, label } : null;
      });
    return [...countryPoints, ...placePoints].filter((p): p is NonNullable<typeof p> => !!p);
  }, [regions, coords]);

  if (points.length === 0) return null;

  const center: [number, number] = [
    points.reduce((s, p) => s + p.lat, 0) / points.length,
    points.reduce((s, p) => s + p.lng, 0) / points.length,
  ];

  return (
    <div className="rounded-2xl overflow-hidden h-56 relative z-0">
      <MapContainer center={center} zoom={points.length === 1 ? 5 : 2} scrollWheelZoom={false} className="w-full h-full">
        {/* tile.openstreetmap.org's own usage policy blocks embedded-app
            traffic like ours outright (operations.osmfoundation.org/policies/tiles) —
            confirmed via its response headers (`x-blocked: Access denied`),
            which is why the map rendered as blank gray tiles. CARTO's
            basemaps are OSM data under the same license, served from
            infrastructure meant for exactly this kind of embedding, no API
            key required. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
        />
        {points.map((p) => (
          <Marker key={p.key} position={[p.lat, p.lng]} icon={p.isCountry ? countryIcon : placeIcon}>
            <Tooltip>{p.isCountry ? `${flagEmoji(p.label)} ${countryDisplayName(p.label, navigator.language)}` : p.label}</Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
