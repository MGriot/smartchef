// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone-mode match suggestions
// Client-side equivalent of backend/src/services/ingredient.matcher.ts's
// proposeIngredientMatches/proposeToolMatches/proposeTechniqueMatches, for
// when there's no backend to call (standalone mode). Same read-only
// contract: scores candidates, never creates rows.
//
// Every function takes the content language, and it matters twice over.
// These used to call listIngredients({}) with no `lang` at all, which
// returns each row's BASE name — always English. So the Import review step
// offered "Butter" as the match for "burro" and "Lemon" for "scorza di
// lime" no matter what language the app was set to.
//
// It was not only a labelling problem. Scoring an Italian parsed name
// against an English catalog is close to noise: "cocco rapè" came back
// matched to "Arborio Rice" at 42%, which is the fuzzy matcher doing its
// best with two unrelated languages. Scoring against the translated name
// fixes the suggestions themselves, not just how they are written.
// ════════════════════════════════════════════════════════════════════════

import { topMatches, type MatchSuggestion } from '../lib/fuzzyMatch';

/** A row as the local services return it: `name` is the base (English)
 *  name, `translated_name` is the content-language one when a translation
 *  exists for it and null otherwise. */
function localizedCandidate(row: Record<string, unknown>) {
  const base = row.name as string;
  const translated = (row.translated_name as string | null) ?? null;
  return {
    id: row.id as string,
    // Shown in the picker — the app's language when there is a translation,
    // the base name when there isn't (which is honest: an untranslated
    // ingredient really is only named in English).
    name: translated || base,
    // Still scored against, so a recipe parsed in a different language than
    // the UI keeps matching. Deduped implicitly: when there is no
    // translation, `name` already IS the base name and the extra probe is
    // just the same string scored twice.
    //
    // Synonyms join it for the obvious reason that they are the alternate
    // names someone recorded so this row would be findable by them — the
    // catalog knew "scalogno" meant Shallot and the review step, scoring
    // only against the name, still didn't. Every local list*() already
    // parses the column, so this costs nothing extra to read.
    aliases: [base, ...(Array.isArray(row.synonyms) ? (row.synonyms as string[]) : [])],
  };
}

export async function proposeIngredientMatchesLocal(
  names: string[],
  lang?: string
): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listIngredients } = await import('./ingredients.local');
  const all = await listIngredients({ lang });
  const candidates = all.map((i: Record<string, unknown>) => ({
    ...localizedCandidate(i),
    pluralName: (i.plural_name as string | null) ?? null,
  }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}

export async function proposeToolMatchesLocal(
  names: string[],
  lang?: string
): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listTools } = await import('./ingredients.local');
  const all = await listTools({ lang });
  const candidates = all.map((t: Record<string, unknown>) => localizedCandidate(t));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}

export async function proposeTechniqueMatchesLocal(
  names: string[],
  lang?: string
): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const { listTechniques } = await import('./techniques.local');
  const all = await listTechniques({ lang });
  const candidates = all.map((t: Record<string, unknown>) => localizedCandidate(t));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = topMatches(name, candidates);
  return out;
}
