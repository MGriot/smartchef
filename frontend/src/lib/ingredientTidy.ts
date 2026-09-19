// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Tidy names with AI" for the existing ingredient catalog
//
// Turns the AI's naming answers (POST /api/ingredients/ai-name) into the
// list of changes the Library shows for review: rename to the catalog
// convention, link a "variety of" parent, fill missing languages. Pure so
// it can be tested — the suite has no jsdom (see lib/importMatching.ts).
//
// Deliberately conservative: existing translations are never overwritten,
// an existing parent is never replaced, and a rename that would collide
// with another ingredient's name is not applied — two rows with one name
// are a merge, which the Library's own Merge action does properly.
// ════════════════════════════════════════════════════════════════════════

export interface TidyIngredient {
  id: string;
  name: string;
  parent_ingredient_id?: string | null;
  translations?: Array<{ lang: string; text: string }>;
}

export interface TidySuggestion {
  key: string;
  name: string;
  parent: string | null;
  parentId: string | null;
  translations: Array<{ lang: string; text: string }>;
}

export interface TidyProposal {
  id: string;
  oldName: string;
  /** Set when the name changes. */
  newName?: string;
  /** Set when a rename was proposed but another ingredient already has
   *  that name — not applied; merge instead. */
  duplicateOf?: { id: string; name: string };
  parentId?: string;
  parentName?: string;
  addTranslations: Array<{ lang: string; text: string }>;
}

export function buildTidyProposals(ingredients: TidyIngredient[], suggestions: TidySuggestion[]): TidyProposal[] {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const idByName = new Map<string, string>();
  for (const i of ingredients) if (!idByName.has(i.name.trim().toLowerCase())) idByName.set(i.name.trim().toLowerCase(), i.id);

  // A parent may be named by the name another row is ABOUT to get ("Apple"
  // for a row still called "apple"), so proposed names resolve too.
  const idByProposedName = new Map<string, string>();
  for (const s of suggestions) if (byId.has(s.key)) idByProposedName.set(s.name.trim().toLowerCase(), s.key);

  const out: TidyProposal[] = [];
  for (const s of suggestions) {
    const ing = byId.get(s.key);
    if (!ing) continue;
    const proposal: TidyProposal = { id: ing.id, oldName: ing.name, addTranslations: [] };

    const newName = s.name.trim();
    if (newName && newName !== ing.name.trim()) {
      const clash = idByName.get(newName.toLowerCase());
      if (clash && clash !== ing.id) proposal.duplicateOf = { id: clash, name: byId.get(clash)!.name };
      else proposal.newName = newName;
    }

    if (!ing.parent_ingredient_id && s.parent) {
      const parentId = s.parentId ?? idByName.get(s.parent.toLowerCase()) ?? idByProposedName.get(s.parent.toLowerCase());
      if (parentId && parentId !== ing.id) {
        proposal.parentId = parentId;
        proposal.parentName = s.parent;
      }
    }

    // Translations that go with a rename we are NOT applying would name a
    // different thing than the row keeps, so a clash adds none.
    if (!proposal.duplicateOf) {
      const have = new Set((ing.translations ?? []).filter((t) => t.text?.trim()).map((t) => t.lang.toLowerCase()));
      for (const t of s.translations) {
        if (!t.text?.trim() || have.has(t.lang.toLowerCase())) continue;
        proposal.addTranslations.push({ lang: t.lang.toLowerCase(), text: t.text.trim() });
      }
    }

    if (proposal.newName || proposal.duplicateOf || proposal.parentId || proposal.addTranslations.length) out.push(proposal);
  }
  return out;
}
