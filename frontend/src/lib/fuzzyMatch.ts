// ════════════════════════════════════════════════════════════════════════
// SmartChef — Fuzzy string matching (client-side)
// Direct port of backend/src/services/ingredient.matcher.ts's normalize()/
// similarity() — same duplicate-with-cross-reference precedent already
// used by services/matrioska.local.ts (the @shared/types import isn't
// wired into the frontend build, so pure logic gets copied, not imported).
// Keep this in sync with the backend file if either changes.
// ════════════════════════════════════════════════════════════════════════

export interface MatchSuggestion {
  id: string;
  name: string;
  score: number;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

/** Normalized Levenshtein similarity, 0–1. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  const m = na.length;
  const n = nb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = na[i - 1] === nb[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

// Direct port of backend/src/services/ingredient.matcher.ts's UNIT_ALIASES —
// used by the Import review step to resolve a parsed unit word ("cucchiaino")
// to a real units.id client-side, in both modes, without a network round trip.
const UNIT_ALIASES: Record<string, string[]> = {
  g: ['grammo', 'grammi', 'gr', 'g'],
  kg: ['chilogrammo', 'chilogrammi', 'kilo', 'kg'],
  ml: ['millilitro', 'millilitri', 'ml'],
  l: ['litro', 'litri', 'lt'],
  tbsp: ['cucchiaio', 'cucchiai', 'tbsp', 'cucchiaio da tavola'],
  tsp: ['cucchiaino', 'cucchiaini', 'tsp'],
  cup: ['tazza', 'tazze', 'cup'],
  pz: ['pezzo', 'pezzi', 'pz', 'n.', 'numero', 'unità'],
  'q.b.': ['quanto basta', 'qb', 'q.b.', 'a piacere', 'a gusto'],
};

/** Resolves free-text unit wording to a real units.id, given the full unit
 *  catalog (units.symbol/name). Alias table first, then a direct
 *  symbol/name match — same two-step fallback as the backend's matchUnit(). */
export function matchUnitId(unitText: string | undefined, units: { id: string; symbol: string; name: string }[]): string | undefined {
  if (!unitText) return undefined;
  const norm = normalize(unitText);
  for (const [symbol, aliases] of Object.entries(UNIT_ALIASES)) {
    if (aliases.some((a) => normalize(a) === norm || norm.includes(normalize(a)))) {
      const unit = units.find((u) => u.symbol === symbol);
      if (unit) return unit.id;
    }
  }
  const direct = units.find((u) => u.symbol.toLowerCase() === unitText.toLowerCase() || u.name.toLowerCase() === unitText.toLowerCase());
  return direct?.id;
}

/** Scores `name` against every candidate (optionally also against a plural
 *  form, taking whichever scores higher — see ingredients.plural_name),
 *  returns the top `limit` above a floor score. Shared by the standalone
 *  local matcher and anything scoring suggestions client-side. */
export function topMatches<
  T extends { id: string; name: string; pluralName?: string | null; aliases?: Array<string | null | undefined> }
>(
  name: string,
  candidates: T[],
  limit = 3,
  minScore = 0.4
): MatchSuggestion[] {
  const scored = candidates.map((c) => {
    // `name` is what gets SHOWN; every string here is scored against, and
    // the best one wins. That split is what lets a candidate be displayed
    // in the app's language while still matching a recipe written in
    // another one: localMatcher.ts puts the translated name in `name` and
    // the base name in `aliases`, so "burro" matches the Italian label and
    // "butter" still matches the same row. Omitting `aliases` (as most
    // callers do) behaves exactly as before.
    const probes = [c.name, c.pluralName, ...(c.aliases ?? [])].filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0
    );
    return {
      id: c.id,
      name: c.name,
      score: probes.length ? Math.max(...probes.map((p) => similarity(name, p))) : 0,
    };
  });
  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
