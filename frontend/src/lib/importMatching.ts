// ════════════════════════════════════════════════════════════════════════
// SmartChef — Import review: combining name matches with catalog claims
//
// Two independent opinions arrive about what an imported ingredient is:
// the fuzzy matcher's (scoring the recipe's own wording against the
// library) and the model's (which library entry it says the ingredient
// corresponds to — see catalogName in llmParser.local.ts). This merges
// them into the single ranked list the Review Matches step renders.
//
// Pulled out of pages/RecipeImport.tsx rather than written inline because
// the test suite has no jsdom (frontend/vitest.config.ts is
// environment: "node"), so logic that lives in a component cannot be
// tested at all — and the behaviour that matters most here is the one that
// is hardest to eyeball: that a draft with NO catalog claims comes out
// byte-for-byte the same as it did before any of this existed.
// ════════════════════════════════════════════════════════════════════════

import type { MatchSuggestion } from './fuzzyMatch';

/** The Review Matches step's per-item decision: either "use this existing
 *  library row" or "create a new one" (ingredients also need a category).
 *  A new row's `name` is what the user typed over the suggested name;
 *  undefined means "keep the suggestion". */
export type Resolution =
  | { choice: 'existing'; id: string; name: string }
  | { choice: 'new'; categoryId?: string; name?: string };

/** The name a "create new" row will be created with: whatever the user
 *  typed, else the suggestion. */
export function newRowName(resolution: Resolution | undefined, suggested: string): string {
  const typed = resolution?.choice === 'new' ? resolution.name : undefined;
  return typed !== undefined ? typed.trim() || suggested : suggested;
}

/** Pre-selects the top suggestion when it is confident enough, otherwise
 *  defaults to creating a new row. The 0.7 floor is the same one the
 *  server-side write matcher uses (ingredient.matcher.ts's findBestMatch),
 *  and a catalog-derived suggestion clears it trivially because it scores
 *  1.0 — which is the point: an entry the model recognized from the
 *  library shouldn't need a click. */
export function defaultResolution(suggestions: MatchSuggestion[]): Resolution {
  const top = suggestions[0];
  if (top && top.score > 0.7) return { choice: 'existing', id: top.id, name: top.name };
  return { choice: 'new' };
}

/**
 * Merges the suggestions found for the recipe's own wording with those
 * found for the catalog entry the model claimed, into one ranked list.
 *
 * `byCatalog` is additive, never a replacement. The model's claim has
 * already been validated against the catalog actually sent
 * (dropUnknownCatalogNames), so an entry here does exist — but "exists" is
 * not "is correct", and a model will occasionally assert that margarine is
 * the butter you already have. Keeping both opinions in one list means the
 * user sees the alternative rather than only the model's answer.
 *
 * Entries that ONLY the catalog claim found are flagged `viaCatalog`, so
 * the UI can badge a match that string similarity would never have made.
 * That badge is the whole safety story for this feature: without it, a
 * wrong claim is auto-selected and silently folds a distinct ingredient
 * into an existing row.
 *
 * With an empty `byCatalog` — every non-AI import path, and every AI
 * import where the model claimed nothing — this returns `byName` ranked
 * exactly as before, which is the regression guard.
 */
export function mergeSuggestions(
  byName: MatchSuggestion[],
  byCatalog: MatchSuggestion[],
  limit = 3
): MatchSuggestion[] {
  if (!byCatalog.length) return byName.slice(0, limit);

  const merged = new Map<string, MatchSuggestion>();
  for (const s of byName) merged.set(s.id, { ...s });
  for (const s of byCatalog) {
    const existing = merged.get(s.id);
    if (!existing) {
      merged.set(s.id, { ...s, viaCatalog: true });
      continue;
    }
    // Same row reached both ways: keep the better score, and don't badge
    // it — the name match found it on its own, so there is nothing the
    // user would be surprised by.
    if (s.score > existing.score) existing.score = s.score;
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
