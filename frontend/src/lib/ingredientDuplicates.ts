// ════════════════════════════════════════════════════════════════════════
// SmartChef — finding ingredients that are the same thing twice
//
// Two libraries that grew apart and were then synced together leave the
// catalog with pairs like "Sale" and "Salt", or "Carota" and "Carrot": an
// ingredient named in one language next to the English catalog entry whose
// translation in that language is exactly that name. Plain same-name copies
// ("Water" twice) happen too.
//
// The pairs are only proposals. A translation is a claim somebody (or an
// AI) made, and it can be wrong — one library had "Cognac" as the French
// name of "Brandy". So a pair is pre-selected only when the evidence is
// strong: the same name, or a match in the language the person reads the
// library in, which is the language they would have noticed a mistake in.
// Pure: values in, proposals out.
// ════════════════════════════════════════════════════════════════════════

export interface DuplicateCandidate {
  id: string;
  name: string;
  translations?: Array<{ lang: string; text: string }>;
  parent_ingredient_id?: string | null;
  created_at?: string | null;
}

export interface DuplicateProposal {
  /** Folded away. */
  sourceId: string;
  sourceName: string;
  /** Kept; every recipe using the source points here afterwards. */
  targetId: string;
  targetName: string;
  /** 'same-name', or the language whose translation of the target is the
   *  source's name. */
  reason: 'same-name' | 'translation';
  lang?: string;
  /** Strong enough evidence to be ticked by default. */
  recommended: boolean;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** The copy to keep among same-name duplicates: the better-translated one,
 *  then the older one, then a stable tie-break. */
function keeperFirst(a: DuplicateCandidate, b: DuplicateCandidate): number {
  const ta = a.translations?.length ?? 0;
  const tb = b.translations?.length ?? 0;
  if (ta !== tb) return tb - ta;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

export function findDuplicateIngredients(items: DuplicateCandidate[], preferredLang?: string | null): DuplicateProposal[] {
  const proposals: DuplicateProposal[] = [];
  const merged = new Set<string>();
  const byName = new Map<string, DuplicateCandidate[]>();
  for (const it of items) {
    const key = norm(it.name);
    if (!key) continue;
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(it);
  }

  // 1. Same name.
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort(keeperFirst);
    for (const dup of rest) {
      proposals.push({ sourceId: dup.id, sourceName: dup.name, targetId: keep.id, targetName: keep.name, reason: 'same-name', recommended: true });
      merged.add(dup.id);
    }
  }

  // 2. A name that is another ingredient's translation.
  const pref = norm(preferredLang);
  for (const source of items) {
    if (merged.has(source.id)) continue;
    const key = norm(source.name);
    const hits = new Map<string, { target: DuplicateCandidate; langs: string[] }>();
    for (const target of items) {
      if (target.id === source.id || merged.has(target.id) || norm(target.name) === key) continue;
      // A variety is not a duplicate of its general ingredient, whichever
      // way round the link points.
      if (target.parent_ingredient_id === source.id || source.parent_ingredient_id === target.id) continue;
      const langs = (target.translations ?? []).filter((t) => norm(t.text) === key).map((t) => norm(t.lang));
      if (langs.length) hits.set(target.id, { target, langs });
    }
    // One name translating two different ingredients is ambiguous ("Échalote"
    // for both Shallot and Leek); leave it to a person.
    if (hits.size !== 1) continue;
    const { target, langs } = [...hits.values()][0];
    // If the source also names the target in some language, both are base
    // entries translating each other — keep the one with the richer set.
    const mutual = (source.translations ?? []).some((t) => norm(t.text) === norm(target.name));
    if (mutual && keeperFirst(source, target) < 0) continue;
    const lang = langs.includes(pref) ? pref : langs[0];
    proposals.push({
      sourceId: source.id, sourceName: source.name, targetId: target.id, targetName: target.name,
      reason: 'translation', lang, recommended: !!pref && langs.includes(pref),
    });
    merged.add(source.id);
  }

  // A target folded away by an earlier pair would leave the source pointing
  // at a tombstone — drop those; a second pass after merging catches them.
  return proposals.filter((p) => !merged.has(p.targetId));
}
