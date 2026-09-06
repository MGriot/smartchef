// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone-mode match suggestions
// Client-side equivalent of backend/src/services/ingredient.matcher.ts's
// proposeIngredientMatches/proposeToolMatches/proposeTechniqueMatches, for
// when there's no backend to call (standalone mode). Same read-only
// contract: scores candidates, never creates rows.
// ════════════════════════════════════════════════════════════════════════

import { topMatches, type MatchSuggestion } from '../lib/fuzzyMatch';

export async function proposeIngredientMatchesLocal(names: string[]): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listIngredients } = await import('./ingredients.local');
  const all = await listIngredients({});
  const candidates = all.map((i: Record<string, unknown>) => ({
    id: i.id as string,
    name: i.name as string,
    pluralName: (i.plural_name as string | null) ?? null,
  }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}

export async function proposeToolMatchesLocal(names: string[]): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listTools } = await import('./ingredients.local');
  const all = await listTools({});
  const candidates = all.map((t: Record<string, unknown>) => ({ id: t.id as string, name: t.name as string }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}

export async function proposeTechniqueMatchesLocal(names: string[]): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listTechniques } = await import('./techniques.local');
  const all = await listTechniques({});
  const candidates = all.map((t: Record<string, unknown>) => ({ id: t.id as string, name: t.name as string }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}
