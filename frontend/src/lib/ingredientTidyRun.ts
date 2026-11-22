// ════════════════════════════════════════════════════════════════════════
// SmartChef — planning a "Tidy with AI" run over the ingredient catalog
//
// A run used to send every ingredient, every time, and keep nothing: a
// provider that started refusing halfway (Gemini's per-minute quota) threw
// away the batches that had already come back, and the next try started
// over from the first one. This decides, per ingredient and per aspect,
// whether the model still needs to see it:
//   - already complete for the aspect (every library language named, a
//     category and a tag, all seven nutrients, at least one synonym), or
//   - reviewed before and unchanged since: a short hash of exactly what
//     the aspect looks at, stored when its answer arrived.
// Pure so it can be tested on its own; services/ingredients.local.ts reads
// the rows and the stored hashes and calls it.
// ════════════════════════════════════════════════════════════════════════

import type { TidyIngredient } from './ingredientTidy';

export type TidyAspect = 'naming' | 'classification' | 'nutrition' | 'synonyms';
export const TIDY_ASPECTS: TidyAspect[] = ['naming', 'classification', 'nutrition', 'synonyms'];
export type TidyAspectFlags = Record<TidyAspect, boolean>;

export const askedAspects = (aspects: Partial<TidyAspectFlags>): TidyAspect[] => TIDY_ASPECTS.filter((a) => !!aspects[a]);

/** Ingredients per request: fewer the more is asked of each, so one answer
 *  stays well inside the model's output limit, and a batch that fails only
 *  costs that many. */
export function tidyBatchSize(aspects: Partial<TidyAspectFlags>): number {
  return askedAspects(aspects).length <= 1 ? 40 : 20;
}

/** Status codes the router answers with when the provider is busy or
 *  rate-limited (429, 5xx) rather than refusing outright: worth waiting
 *  and sending the same batch again. 502 is "the AI said no" — a missing
 *  key, a rejected one — and fails the same way every time. */
export function isRetryableTidyStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

/** Waits before re-sending a batch the provider refused, on top of the
 *  short retries each request already makes: a per-minute quota needs the
 *  minute to pass. */
export const TIDY_BATCH_BACKOFF_MS = [15_000, 30_000, 60_000];

const NUTRIENTS = ['calories_kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'] as const;

/** 32-bit FNV-1a, as hex. Not for security: it only has to notice that
 *  what an aspect looks at has changed since its review. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const sorted = (values: string[]) => [...values].sort();

/** What each aspect looks at, reduced to a hash. The naming hash includes
 *  the library's languages: adding one makes every ingredient worth naming
 *  again. */
export function tidyContentHashes(ing: TidyIngredient, langs: string[]): Record<TidyAspect, string> {
  const translations = sorted((ing.translations ?? []).map((tr) => `${tr.lang}=${tr.text.trim()}`));
  return {
    naming: fnv1a(JSON.stringify([ing.name.trim(), ing.parent_ingredient_id ?? null, translations, sorted(langs)])),
    classification: fnv1a(JSON.stringify([ing.category_id ?? null, sorted((ing.tags ?? []).map((t) => t.id))])),
    nutrition: fnv1a(JSON.stringify([...NUTRIENTS, 'density_g_per_ml'].map((k) => ing[k as keyof TidyIngredient] ?? null))),
    synonyms: fnv1a(JSON.stringify([ing.name.trim(), sorted((ing.synonyms ?? []).map((s) => s.trim().toLowerCase()))])),
  };
}

/** Whether an ingredient already has everything an aspect would fill in.
 *  Density is not required: most solids are never measured by volume. */
export function isTidyAspectComplete(ing: TidyIngredient, aspect: TidyAspect, langs: string[], knownCategoryIds?: Set<string>): boolean {
  switch (aspect) {
    case 'naming': {
      const named = new Set((ing.translations ?? []).filter((tr) => tr.text.trim()).map((tr) => tr.lang));
      return langs.every((l) => named.has(l));
    }
    case 'classification':
      return !!ing.category_id && (!knownCategoryIds || knownCategoryIds.has(ing.category_id)) && (ing.tags ?? []).length > 0;
    case 'nutrition':
      return NUTRIENTS.every((k) => typeof ing[k] === 'number');
    case 'synonyms':
      return (ing.synonyms ?? []).some((s) => s.trim());
  }
}

export interface TidyPlan {
  /** Ingredients the model still has to see, in the order given. */
  pendingIds: string[];
  /** Skipped: already complete for every selected aspect. */
  complete: number;
  /** Skipped: reviewed before, unchanged since. */
  unchanged: number;
}

/** Decides which ingredients a run sends. `reviewed` holds, per
 *  ingredient, the hashes stored when each aspect's answer arrived. An
 *  ingredient is skipped when, for every selected aspect, it is complete
 *  or unchanged since that aspect's review. `force` sends everything. */
export function planTidyRun(
  ingredients: TidyIngredient[],
  reviewed: Map<string, Partial<Record<TidyAspect, string>>>,
  aspects: Partial<TidyAspectFlags>,
  langs: string[],
  opts: { force?: boolean; knownCategoryIds?: Set<string> } = {},
): TidyPlan {
  const asked = askedAspects(aspects);
  const plan: TidyPlan = { pendingIds: [], complete: 0, unchanged: 0 };
  if (asked.length === 0) return plan;
  for (const ing of ingredients) {
    if (opts.force) { plan.pendingIds.push(ing.id); continue; }
    const hashes = tidyContentHashes(ing, langs);
    const stored = reviewed.get(ing.id) ?? {};
    let anyUnchanged = false;
    let needed = false;
    for (const aspect of asked) {
      if (stored[aspect] === hashes[aspect]) { anyUnchanged = true; continue; }
      if (isTidyAspectComplete(ing, aspect, langs, opts.knownCategoryIds)) continue;
      needed = true;
      break;
    }
    if (needed) plan.pendingIds.push(ing.id);
    else if (anyUnchanged) plan.unchanged++;
    else plan.complete++;
  }
  return plan;
}

/** Splits the pending ids into the batches a run sends, one request each. */
export function tidyBatches(ids: string[], aspects: Partial<TidyAspectFlags>): string[][] {
  const size = tidyBatchSize(aspects);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
