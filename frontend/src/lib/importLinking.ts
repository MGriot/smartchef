// ════════════════════════════════════════════════════════════════════════
// SmartChef — Import linking
//
// What the AI import knows about a recipe beyond its ingredients: which
// tools and techniques each step uses (turned into inline {{tool:id}} /
// {{tech:id}} references, the way the editor writes them) and where the dish
// comes from (the recipe's `regions`). Pure functions, so they are testable
// without the import page.
// ════════════════════════════════════════════════════════════════════════

import { buildRef } from './stepRefs';
import { findMention } from './nameMatch';
import { isCountryCode, countryDisplayName } from './countries';

export interface LinkTarget {
  id: string;
  /** Every wording that may appear in the prose: the model's own name for it
   *  and the library name it resolved to (they differ — "Oven" vs "Forno"). */
  names: string[];
}

/**
 * Turns the first literal mention of each target in a step's prose into a
 * {{tool:id}} / {{tech:id}} reference. Conservative on purpose, like
 * linkIngredientsInText(): whole-word, case-insensitive, first occurrence
 * only, skipped when the entity is already referenced or the name is too
 * short to match safely.
 */
export function linkEntitiesInText(text: string, type: 'tool' | 'tech', targets: LinkTarget[]): string {
  if (!text || targets.length === 0) return text;
  let out = text;
  for (const target of targets) {
    const already = new RegExp(String.raw`\{\{${type}:${target.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[|}]`);
    if (already.test(out)) continue;
    const hit = findMention(out, target.names.filter((n) => typeof n === 'string'), type === 'tech' ? 'verb' : 'noun');
    if (hit) out = out.slice(0, hit.start) + buildRef(type, target.id) + out.slice(hit.end);
  }
  return out;
}

export interface GeocodedPlace {
  lat: number;
  lng: number;
  shape?: unknown;
}

export interface ResolvedRegions {
  regions: string[];
  regionCoords: Record<string, GeocodedPlace>;
}

/**
 * The parser's `regions` → what a recipe stores: ISO country codes as they
 * are, free-text places as their label with coordinates under the lower-cased
 * label (the shape RegionPicker writes). `geocode` is optional and
 * best-effort — a place that cannot be located is kept as plain text.
 */
export async function resolveRegions(
  parsed: Array<{ country: string | null; place: string | null }> | undefined,
  geocode?: (query: string) => Promise<GeocodedPlace | null>,
  locale = 'en',
): Promise<ResolvedRegions> {
  const regions: string[] = [];
  const regionCoords: Record<string, GeocodedPlace> = {};
  const add = (v: string) => {
    if (!regions.some((r) => r.toLowerCase() === v.toLowerCase())) regions.push(v);
  };

  for (const entry of parsed ?? []) {
    const code = entry.country?.trim().toUpperCase() ?? '';
    const validCountry = code.length === 2 && isCountryCode(code);
    const place = entry.place?.trim() || '';

    if (place) {
      add(place);
      if (geocode && !regionCoords[place.toLowerCase()]) {
        // The country makes "Valencia" the Spanish one, not the Venezuelan.
        const query = validCountry ? `${place}, ${countryDisplayName(code, locale)}` : place;
        try {
          const hit = await geocode(query);
          if (hit) regionCoords[place.toLowerCase()] = hit;
        } catch {
          // Offline or no proxy: the chip stays text-only.
        }
      }
    }
    // A place already says where; the country is added too so the Atlas
    // groups the recipe under it as well.
    if (validCountry) add(code);
  }
  return { regions, regionCoords };
}
