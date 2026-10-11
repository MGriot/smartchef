// ════════════════════════════════════════════════════════════════════════
// SmartChef — Import linking
//
// What the AI import knows about a recipe beyond its ingredients: which
// tools and techniques each step uses (turned into inline {{tool:id}} /
// {{tech:id}} references, the way the editor writes them) and where the dish
// comes from (the recipe's `regions`). Pure functions, so they are testable
// without the import page.
// ════════════════════════════════════════════════════════════════════════

import { buildRef, normalizeName } from './stepRefs';
import { findMention } from './nameMatch';
import type { StepMention } from '../services/recipeTemplateParser';
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
    const names = target.names.filter((n) => typeof n === 'string');
    // A tool or technique prints as its bare name, so every mention is linked
    // (unlike an ingredient, whose reference repeats an amount). A token is
    // never matched again, so this ends; the cap is only a backstop.
    for (let n = 0; n < 12; n++) {
      const hit = findMention(out, names, type === 'tech' ? 'verb' : 'noun');
      if (!hit) break;
      out = out.slice(0, hit.start) + buildRef(type, target.id) + out.slice(hit.end);
    }
  }
  return out;
}

/** What the model quoted from one step, per name it listed for that step.
 *  Only wordings the step text really contains are kept — a quote the prose
 *  does not hold is the model's guess, and it links nothing. */
export function verifiedMentions(
  description: string,
  mentions: StepMention[] | undefined,
  kind: StepMention['kind'],
): Array<{ name: string; texts: string[] }> {
  const byName = new Map<string, { name: string; texts: string[] }>();
  for (const m of mentions ?? []) {
    if (m.kind !== kind || !m.name || !m.text) continue;
    if (!findMention(description, [m.text], kind === 'technique' ? 'verb' : 'noun')) continue;
    const key = normalizeName(m.name);
    const entry = byName.get(key) ?? { name: m.name, texts: [] };
    if (!entry.texts.includes(m.text)) entry.texts.push(m.text);
    byName.set(key, entry);
  }
  return [...byName.values()];
}

/** The verified quotes for ingredients, per ingredient row (by sortOrder),
 *  resolved the way matchStepIngredients resolves the model's names. */
export function ingredientMentionNames(
  description: string,
  mentions: StepMention[] | undefined,
  ingredients: Array<{ name: string }>,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const keys = ingredients.map((ing) => normalizeName(ing.name));
  for (const { name, texts } of verifiedMentions(description, mentions, 'ingredient')) {
    const key = normalizeName(name);
    if (!key) continue;
    const at = keys.findIndex((k) => k === key) >= 0 ? keys.findIndex((k) => k === key) : keys.findIndex((k) => k && (k.includes(key) || key.includes(k)));
    if (at >= 0) out.set(at, [...(out.get(at) ?? []), ...texts]);
  }
  return out;
}

/** Ingredients a step names that the model left out of that step's list: the
 *  structured-data path has no list at all, and a model's list is not
 *  exhaustive. Found by looking each ingredient's own name up in the prose, so
 *  it is deterministic, and each hit becomes a plain "uses it" row. */
export function ingredientsNamedInText(
  description: string,
  ingredients: Array<{ name: string }>,
  skip: Set<number>,
): number[] {
  const hits: number[] = [];
  ingredients.forEach((ing, i) => {
    const name = ing.name?.trim();
    if (!name || name.length < 3 || skip.has(i)) return;
    if (findMention(description, [name], 'noun')) hits.push(i);
  });
  return hits;
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
