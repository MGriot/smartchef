import { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, GeoJSON, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { countryCentroid, countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';
import { countryFeatureFor } from '../lib/worldGeo';

interface RegionCoord { lat: number; lng: number }

export interface AtlasMapProps {
  /** Recipe count per region key — an ISO alpha-2 code, or a free-text label. */
  counts: Record<string, number>;
  /** Coords for the free-text labels, keyed lowercased, merged from every
   *  recipe's own `region_coords` (RegionPicker geocodes them on save). */
  coords: Record<string, RegionCoord>;
  /** The region currently filtering the list below the map, if any. */
  selected: string | null;
  onSelect: (region: string | null) => void;
  locale: string;
}

function dotIcon(color: string, size: number) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Fill opacity by share of the busiest region. A plain linear ramp made
 *  everything below the top two or three countries look identical, because
 *  recipe counts per country are heavily skewed — sqrt keeps the low end
 *  distinguishable while the leader still reads as the darkest. */
function shade(count: number, max: number): number {
  if (max <= 0) return 0;
  return 0.18 + 0.62 * Math.sqrt(count / max);
}

/**
 * The atlas choropleth: every country that has at least one recipe filled in
 * proportionally to how many, plus a dot for each geocoded free-text region.
 * Clicking either one selects it (clicking the selection again clears it),
 * which is what filters the recipe grid on the page below.
 *
 * Distinct from RegionsMap, which answers "where is *this* recipe from" for
 * a single recipe and never accepts a click.
 */
export default function AtlasMap({ counts, coords, selected, onSelect, locale }: AtlasMapProps) {
  const { areas, points, max } = useMemo(() => {
    const areas: { key: string; count: number; geo: ReturnType<typeof countryFeatureFor> }[] = [];
    const points: { key: string; lat: number; lng: number; count: number; isCountry: boolean }[] = [];

    for (const [key, count] of Object.entries(counts)) {
      if (isCountryCode(key)) {
        const geo = countryFeatureFor(key);
        if (geo) {
          areas.push({ key, count, geo });
          continue;
        }
        // A few tiny territories have no polygon in the 50m dataset — a
        // centroid dot keeps them on the map rather than silently absent.
        const centroid = countryCentroid(key);
        if (centroid) points.push({ key, lat: centroid.lat, lng: centroid.lng, count, isCountry: true });
        continue;
      }
      const c = coords[key.toLowerCase()];
      if (c) points.push({ key, lat: c.lat, lng: c.lng, count, isCountry: false });
    }

    const max = Math.max(0, ...Object.values(counts));
    return { areas, points, max };
  }, [counts, coords]);

  const bounds = L.latLngBounds([]);
  for (const a of areas) if (a.geo) bounds.extend(L.geoJSON(a.geo).getBounds());
  for (const p of points) bounds.extend([p.lat, p.lng]);

  const label = (key: string) =>
    isCountryCode(key) ? `${flagEmoji(key)} ${countryDisplayName(key, locale)}` : key;

  return (
    <div className="rounded-3xl overflow-hidden h-[420px] relative z-0 border border-zinc-100 dark:border-zinc-800">
      <MapContainer
        {...(bounds.isValid()
          ? { bounds, boundsOptions: { padding: [24, 24] as [number, number] } }
          : { center: [20, 10] as [number, number], zoom: 2 })}
        minZoom={1}
        maxZoom={9}
        scrollWheelZoom={false}
        style={{ background: '#c8dce8' }}
        className="w-full h-full"
      >
        {/* Same Esri basemap, and for the same reason, as RegionsMap — see
            the long note there on why every other free tile provider was
            ruled out. Credit kept short so it doesn't cover the map. */}
        <TileLayer
          attribution='Tiles &copy; <a href="https://www.esri.com" title="Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom">Esri</a>'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
          maxZoom={19}
          referrerPolicy="no-referrer"
        />
        {areas.map((a) => {
          const isSelected = selected === a.key;
          return (
            <GeoJSON
              key={`${a.key}-${isSelected}-${a.count}`}
              data={a.geo!}
              style={{
                color: isSelected ? '#0f766e' : '#f97316',
                weight: isSelected ? 2.5 : 1,
                fillColor: isSelected ? '#0f766e' : '#f97316',
                fillOpacity: shade(a.count, max),
              }}
              eventHandlers={{ click: () => onSelect(isSelected ? null : a.key) }}
            >
              <Tooltip sticky>{`${label(a.key)} — ${a.count}`}</Tooltip>
            </GeoJSON>
          );
        })}
        {points.map((p) => (
          <Marker
            key={p.key}
            position={[p.lat, p.lng]}
            icon={dotIcon(
              selected === p.key ? '#0f766e' : p.isCountry ? '#f97316' : '#3b82f6',
              // Free-text places have no area to shade, so their weight has
              // to show up in the dot's size instead.
              12 + Math.min(10, Math.round(8 * Math.sqrt(p.count / Math.max(1, max))))
            )}
            eventHandlers={{ click: () => onSelect(selected === p.key ? null : p.key) }}
          >
            <Tooltip>{`${label(p.key)} — ${p.count}`}</Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
