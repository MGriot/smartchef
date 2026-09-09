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

export async function proposeMatches(
  ingredientNames: string[],
  toolNames: string[],
  techniqueNames: string[]
): Promise<ProposedMatches> {
  if (await isStandaloneMode()) {
    const { proposeIngredientMatchesLocal, proposeToolMatchesLocal, proposeTechniqueMatchesLocal } = await import('./localMatcher');
    const [ingredients, tools, techniques] = await Promise.all([
      proposeIngredientMatchesLocal(ingredientNames),
      proposeToolMatchesLocal(toolNames),
      proposeTechniqueMatchesLocal(techniqueNames),
    ]);
    return { ingredients, tools, techniques };
  }

  const res = await apiFetch('/api/recipes/match-suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientNames, toolNames, techniqueNames }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Could not fetch match suggestions');
  return json.data as ProposedMatches;
}
