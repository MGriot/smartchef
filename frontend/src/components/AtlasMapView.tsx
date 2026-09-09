import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, GeoJSON, Popup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import CoverImage from './CoverImage';
import { countryCentroid, countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';
import { countryFeatureFor } from '../lib/worldGeo';

interface RegionCoord { lat: number; lng: number }

export interface AtlasPin {
  /** An ISO alpha-2 code, or a free-text region label. */
  key: string;
  recipes: { id: string; title: string; cover: string | null }[];
}

export interface AtlasMapProps {
  regions: AtlasPin[];
  /** Coords for the free-text labels, keyed lowercased, merged from every
   *  recipe's own `region_coords` (RegionPicker geocodes them on save). */
  coords: Record<string, RegionCoord>;
  /** The region currently filtering the list below the map, if any. */
  selected: string | null;
  onSelect: (region: string | null) => void;
  locale: string;
  /** Copy for the popup's "filter the grid on this place" button. */
  showAllLabel: string;
  moreLabel: (n: number) => string;
}

const PIN_ACTIVE = '#0f766e';
const PIN_COUNTRY = '#e2562a';
const PIN_PLACE = '#2563eb';

/** A teardrop pin with the recipe count in its head. Leaflet's own default
 *  marker is a PNG pair that bundlers famously can't resolve, and an inline
 *  SVG can carry the count without a second overlay element. */
function pinIcon(color: string, count: number) {
  const w = 34;
  const h = 44;
  return L.divIcon({
    className: '',
    html: `
      <svg width="${w}" height="${h}" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">
        <path d="M12 0.9C6.2 0.9 1.6 5.5 1.6 11.3c0 7.8 9.3 19 10.4 20.3 1.1-1.3 10.4-12.5 10.4-20.3C22.4 5.5 17.8 0.9 12 0.9z" fill="${color}" stroke="#ffffff" stroke-width="1.6"/>
        <text x="12" y="15.4" text-anchor="middle" fill="#ffffff" font-size="10.5" font-weight="800" font-family="system-ui,-apple-system,Segoe UI,sans-serif">${count}</text>
      </svg>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -h + 6],
  });
}

/** A faint tint on the countries that have recipes. Deliberately weak: the
 *  pins are what you read here, and a strong choropleth fought them for
 *  attention. sqrt rather than linear because counts per country are skewed
 *  enough that a linear ramp made everything below the top two identical. */
function shade(count: number, max: number): number {
  if (max <= 0) return 0;
  return 0.08 + 0.2 * Math.sqrt(count / max);
}

/**
 * The atlas map: one pin per place that has recipes, carrying its count, and
 * opening a card of that place's recipes — cover photo, title, link — so the
 * map itself shows the food rather than only counting it. Countries are
 * tinted underneath as a secondary "how much of the world do I cover" read.
 *
 * Distinct from RegionsMap, which answers "where is *this* recipe from" for
 * a single recipe and never accepts a click.
 */
export default function AtlasMap({
  regions, coords, selected, onSelect, locale, showAllLabel, moreLabel,
}: AtlasMapProps) {
  const { pins, areas, max } = useMemo(() => {
    const pins: (AtlasPin & { lat: number; lng: number; isCountry: boolean })[] = [];
    const areas: { key: string; count: number; geo: NonNullable<ReturnType<typeof countryFeatureFor>> }[] = [];

    for (const region of regions) {
      if (isCountryCode(region.key)) {
        const geo = countryFeatureFor(region.key);
        if (geo) areas.push({ key: region.key, count: region.recipes.length, geo });
        // The pin sits on the country's centroid whether or not we have its
        // polygon — a tinted shape with no pin would have no way to open.
        const centroid = countryCentroid(region.key);
        if (centroid) pins.push({ ...region, lat: centroid.lat, lng: centroid.lng, isCountry: true });
        continue;
      }
      const c = coords[region.key.toLowerCase()];
      if (c) pins.push({ ...region, lat: c.lat, lng: c.lng, isCountry: false });
    }

    const max = Math.max(0, ...regions.map((r) => r.recipes.length));
    return { pins, areas, max };
  }, [regions, coords]);

  const bounds = L.latLngBounds([]);
  for (const p of pins) bounds.extend([p.lat, p.lng]);

  const label = (key: string) =>
    isCountryCode(key) ? `${flagEmoji(key)} ${countryDisplayName(key, locale)}` : key;

  return (
    <div className="rounded-3xl overflow-hidden h-[520px] relative z-0 border border-zinc-100 dark:border-zinc-800">
      <MapContainer
        {...(bounds.isValid()
          ? { bounds, boundsOptions: { padding: [48, 48] as [number, number] } }
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
              data={a.geo}
              style={{
                color: isSelected ? PIN_ACTIVE : PIN_COUNTRY,
                weight: isSelected ? 2 : 0.8,
                fillColor: isSelected ? PIN_ACTIVE : PIN_COUNTRY,
                fillOpacity: isSelected ? 0.4 : shade(a.count, max),
              }}
              eventHandlers={{ click: () => onSelect(isSelected ? null : a.key) }}
              interactive={false}
            />
          );
        })}

        {pins.map((p) => {
          const isSelected = selected === p.key;
          const shownRecipes = p.recipes.slice(0, 4);
          const rest = p.recipes.length - shownRecipes.length;
          return (
            <Marker
              key={`${p.key}-${isSelected}`}
              position={[p.lat, p.lng]}
              icon={pinIcon(isSelected ? PIN_ACTIVE : p.isCountry ? PIN_COUNTRY : PIN_PLACE, p.recipes.length)}
              zIndexOffset={isSelected ? 1000 : 0}
            >
              <Tooltip direction="top" offset={[0, -40]}>{label(p.key)}</Tooltip>
              {/* The card the reference boards use: the food, not a number.
                  Clicking a photo opens the recipe; the button below filters
                  the grid under the map to this place. */}
              <Popup maxWidth={280} minWidth={240} autoPanPadding={[24, 24]}>
                <div className="font-body">
                  <p className="text-sm font-bold text-zinc-800 mb-2">
                    {label(p.key)} <span className="text-zinc-400">· {p.recipes.length}</span>
                  </p>
                  <div className="space-y-1.5">
                    {shownRecipes.map((r) => (
                      <Link
                        key={r.id}
                        to={`/recipe/${r.id}`}
                        className="flex items-center gap-2.5 rounded-lg hover:bg-zinc-50 p-1 -m-1"
                      >
                        <span className="w-14 h-11 rounded-md overflow-hidden shrink-0 block">
                          <CoverImage src={r.cover} alt={r.title} className="w-full h-full object-cover" iconSize={18} />
                        </span>
                        <span className="text-[13px] font-semibold text-zinc-700 leading-snug line-clamp-2">{r.title}</span>
                      </Link>
                    ))}
                  </div>
                  {rest > 0 && <p className="text-[11px] text-zinc-400 mt-1.5">{moreLabel(rest)}</p>}
                  <button
                    type="button"
                    onClick={() => onSelect(isSelected ? null : p.key)}
                    className="mt-2.5 w-full py-1.5 rounded-lg bg-primary/10 text-primary text-[11px] font-bold hover:bg-primary/20 transition-colors"
                  >
                    {showAllLabel}
                  </button>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
