import React, { useMemo, useState } from 'react';
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

/**
 * Chip-based multi-select for recipe regions. Each chip is either a bare
 * ISO country code (shown with its flag + localized name via
 * Intl.DisplayNames) or free-typed text (city, region, whatever — e.g.
 * "Pinerolo"), shown plain with a dashed border. Free-typed entries are
 * geocoded via /api/geocode (a Nominatim proxy) so the map can place a real
 * pin for them too, not just for the ~195 static countries — this happens
 * in the background after the chip is added, and silently does nothing on
 * failure (offline, no match) rather than blocking the chip from being added.
 */
export default function RegionPicker({ value, onChange, coords = {}, onCoordsChange }: RegionPickerProps) {
  const { i18n, t } = useTranslation();
  const [query, setQuery] = useState('');
  const [geocoding, setGeocoding] = useState<string | null>(null);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return COUNTRIES
      .filter((c) => !value.includes(c.code))
      .map((c) => ({ code: c.code, name: countryDisplayName(c.code, i18n.language) }))
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, value, i18n.language]);

  const addCountry = (code: string) => {
    if (!value.includes(code)) onChange([...value, code]);
    setQuery('');
  };

  const addCustom = async () => {
    const text = query.trim();
    if (!text || value.includes(text)) return;
    onChange([...value, text]);
    setQuery('');

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

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((v) => {
          const known = isCountryCode(v);
          return (
            <span
              key={v}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold ${
                known ? 'bg-primary/10 text-primary' : 'bg-zinc-100 text-zinc-500 border border-dashed border-zinc-300'
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
              if (suggestions.length > 0) addCountry(suggestions[0].code);
              else addCustom();
            }
          }}
          placeholder={t('recipeDetail.regionSearchPlaceholder')}
          className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
        />
        {query.trim() && (
          <div className="absolute z-10 mt-1 w-full bg-white rounded-xl shadow-lg border border-zinc-100 max-h-48 overflow-y-auto">
            {suggestions.map((s) => (
              <button
                key={s.code}
                type="button"
                onClick={() => addCountry(s.code)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50 flex items-center gap-2"
              >
                <span>{flagEmoji(s.code)}</span>
                {s.name}
              </button>
            ))}
            <button
              type="button"
              onClick={addCustom}
              className="w-full text-left px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-50 border-t border-zinc-100"
            >
              {t('recipeDetail.addCustomRegion', { text: query.trim() })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
