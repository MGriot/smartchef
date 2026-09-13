import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { COUNTRIES, countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';
import { apiFetch } from '../lib/api';

export interface RegionCoord { lat: number; lng: number }

interface RegionPickerProps {
  value: string[];
  onChange: (values: string[]) => void;
  /** Coords for free-text (non-country) regions, keyed by lowercased label — lets the map place a pin for them too. */
  coords?: Record<string, RegionCoord>;
  onCoordsChange?: (coords: Record<string, RegionCoord>) => void;
}

interface PlaceSuggestion {
  /** What the chip will read — the place's own name, not Nominatim's full
   *  comma-separated address. */
  label: string;
  /** The full address, shown under the label so two places with the same
   *  name can be told apart. */
  context: string;
  lat: number;
  lng: number;
}

/** Nominatim answers with a full address ("Fès, Pachalik de Fès, Préfecture
 *  de Fès, Fès-Meknès, Maroc"). The first part is the place; the rest is
 *  what tells one Springfield from another, so it is kept as context rather
 *  than thrown away or stuffed into the chip. */
function splitDisplayName(displayName: string): { label: string; context: string } {
  const parts = displayName.split(',').map((p) => p.trim()).filter(Boolean);
  return { label: parts[0] ?? displayName, context: parts.slice(1).join(', ') };
}

/**
 * Chip-based multi-select for recipe regions. Each chip is either a bare
 * ISO country code (shown with its flag + localized name via
 * Intl.DisplayNames) or free text (a city, a sub-region — e.g. "Pinerolo"),
 * shown plain with a dashed border.
 *
 * Both halves of the search matter. The ~195 countries are matched locally
 * and instantly; anything smaller than a country is looked up through
 * /api/geocode (a Nominatim proxy), which is what makes "Fes" offer the
 * actual city rather than only "add «Fes» as a custom region" — the picker
 * used to have no idea whether free text named a real place until after the
 * chip had been added, so a typo became a chip with no pin and no warning.
 * A hand-typed entry is still accepted (some places simply are not in
 * OpenStreetMap under the name a cook would use) and geocoded in the
 * background, exactly as before.
 */
export default function RegionPicker({ value, onChange, coords = {}, onCoordsChange }: RegionPickerProps) {
  const { i18n, t } = useTranslation();
  const [query, setQuery] = useState('');
  const [geocoding, setGeocoding] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  const countryMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return COUNTRIES
      .filter((c) => !value.includes(c.code))
      .map((c) => ({ code: c.code, name: countryDisplayName(c.code, i18n.language) }))
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 5);
  }, [query, value, i18n.language]);

  // Debounced, and cancelled by a newer keystroke — Nominatim's usage policy
  // is one request a second and this fires from a text field. `seq` is what
  // stops a slow early response from overwriting a fast later one.
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setPlaces([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/geocode?q=${encodeURIComponent(q)}&limit=6`);
        if (mine !== seq.current) return;
        if (!res.ok) {
          setPlaces([]);
          return;
        }
        const json = await res.json();
        const rows: Array<{ lat: number; lng: number; displayName: string }> =
          json.results ?? (json.data ? [json.data] : []);
        setPlaces(rows.map((r) => ({ ...splitDisplayName(r.displayName), lat: r.lat, lng: r.lng })));
      } catch {
        // Offline, or no proxy reachable. The hand-typed fallback below
        // still works, so this is not worth an error message.
        if (mine === seq.current) setPlaces([]);
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [query]);

  const reset = () => {
    setQuery('');
    setPlaces([]);
    setSearching(false);
  };

  const addCountry = (code: string) => {
    if (!value.includes(code)) onChange([...value, code]);
    reset();
  };

  /** A searched place arrives with its coordinates already, so unlike a
   *  hand-typed chip it needs no follow-up geocode at all. */
  const addPlace = (place: PlaceSuggestion) => {
    if (!value.includes(place.label)) onChange([...value, place.label]);
    onCoordsChange?.({ ...coords, [place.label.toLowerCase()]: { lat: place.lat, lng: place.lng } });
    reset();
  };

  const addCustom = async () => {
    const text = query.trim();
    if (!text || value.includes(text)) return;
    onChange([...value, text]);
    reset();

    if (!onCoordsChange) return;
    setGeocoding(text);
    try {
      const res = await apiFetch(`/api/geocode?q=${encodeURIComponent(text)}`);
      if (res.ok) {
        const json = await res.json();
        onCoordsChange({ ...coords, [text.toLowerCase()]: { lat: json.data.lat, lng: json.data.lng } });
      }
      // 404/offline/etc: leave the chip as plain text, no pin — not an error the user needs to see.
    } catch {
      // Offline or network error — same graceful no-pin fallback.
    } finally {
      setGeocoding(null);
    }
  };

  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  const exactAlreadyOffered =
    places.some((p) => p.label.toLowerCase() === query.trim().toLowerCase()) ||
    countryMatches.some((c) => c.name.toLowerCase() === query.trim().toLowerCase());

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((v) => {
          const known = isCountryCode(v);
          return (
            <span
              key={v}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold ${
                known ? 'bg-primary/10 text-primary' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-dashed border-zinc-300 dark:border-zinc-600'
              }`}
            >
              {known && <span>{flagEmoji(v)}</span>}
              {known ? countryDisplayName(v, i18n.language) : v}
              {geocoding === v && <span className="material-symbols-outlined text-[13px] animate-spin">sync</span>}
              <button type="button" onClick={() => remove(v)} className="hover:text-red-500">
                <span className="material-symbols-outlined text-[13px] block">close</span>
              </button>
            </span>
          );
        })}
      </div>
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (countryMatches.length > 0) addCountry(countryMatches[0].code);
              else if (places.length > 0) addPlace(places[0]);
              else addCustom();
            }
          }}
          placeholder={t('recipeDetail.regionSearchPlaceholder')}
          className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
        />
        {query.trim() && (
          <div className="absolute z-10 mt-1 w-full bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-zinc-100 dark:border-zinc-800 max-h-64 overflow-y-auto">
            {countryMatches.map((s) => (
              <button
                key={s.code}
                type="button"
                onClick={() => addCountry(s.code)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60 flex items-center gap-2"
              >
                <span>{flagEmoji(s.code)}</span>
                {s.name}
              </button>
            ))}

            {places.length > 0 && (
              <p className="px-3 pt-2 pb-1 text-[9px] font-black uppercase tracking-widest text-zinc-300 dark:text-zinc-600">
                {t('recipeDetail.regionPlaces')}
              </p>
            )}
            {places.map((p, i) => (
              <button
                key={`${p.label}-${i}`}
                type="button"
                onClick={() => addPlace(p)}
                className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 flex items-start gap-2"
              >
                <span className="material-symbols-outlined text-[16px] text-primary/60 mt-0.5 shrink-0">location_on</span>
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-700 dark:text-zinc-300 truncate">{p.label}</span>
                  {p.context && (
                    <span className="block text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{p.context}</span>
                  )}
                </span>
              </button>
            ))}

            {searching && (
              <p className="px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-2">
                <span className="material-symbols-outlined text-[14px] animate-spin">sync</span>
                {t('recipeDetail.regionSearching')}
              </p>
            )}

            {!exactAlreadyOffered && (
              <button
                type="button"
                onClick={addCustom}
                className="w-full text-left px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 border-t border-zinc-100 dark:border-zinc-800"
              >
                {t('recipeDetail.addCustomRegion', { text: query.trim() })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
