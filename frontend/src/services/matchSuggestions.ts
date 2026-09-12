// ════════════════════════════════════════════════════════════════════════
// SmartChef — Mode-aware match suggestions
// Single entry point the Import review step calls regardless of how a
// recipe was parsed (AI or the local template/JSON parser) or which mode
// the app is running in. Standalone mode scores against the local SQLite
// catalog (services/localMatcher.ts); server mode asks the backend's
// ingredient.matcher.ts via a small dedicated endpoint, since the local
// (non-AI) parser path has no matched-result response to piggyback on.
// ════════════════════════════════════════════════════════════════════════

import { apiFetch } from '../lib/api';
import { isStandaloneMode } from '../lib/standalone';
import type { MatchSuggestion } from '../lib/fuzzyMatch';

export interface ProposedMatches {
  ingredients: Record<string, MatchSuggestion[]>;
  tools: Record<string, MatchSuggestion[]>;
  techniques: Record<string, MatchSuggestion[]>;
}

/** `lang` is the app's content language (store.contentLang). Without it
 *  both modes score and label against each row's base English name, so the
 *  review step offered "Butter" for "burro" regardless of the language the
 *  app was set to — see the header of localMatcher.ts. Optional, and
 *  omitting it keeps the previous base-name behaviour, which is what the
 *  language-agnostic callers (bulk migration imports) want. */
export async function proposeMatches(
  ingredientNames: string[],
  toolNames: string[],
  techniqueNames: string[],
  lang?: string
): Promise<ProposedMatches> {
  if (await isStandaloneMode()) {
    const { proposeIngredientMatchesLocal, proposeToolMatchesLocal, proposeTechniqueMatchesLocal } = await import('./localMatcher');
    const [ingredients, tools, techniques] = await Promise.all([
      proposeIngredientMatchesLocal(ingredientNames, lang),
      proposeToolMatchesLocal(toolNames, lang),
      proposeTechniqueMatchesLocal(techniqueNames, lang),
    ]);
    return { ingredients, tools, techniques };
  }

  const res = await apiFetch('/api/recipes/match-suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientNames, toolNames, techniqueNames, lang }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Could not fetch match suggestions');
  return json.data as ProposedMatches;
}
