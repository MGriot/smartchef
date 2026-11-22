// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Tidy with AI" for the tools, techniques and units catalogs,
// and for ingredient seasonality
//
// The same idea as lib/ingredientTidy.ts, for the libraries that are not
// ingredients: the AI's answers (POST /api/<catalog>/ai-tidy, or
// /api/ingredients/ai-season) become a list of changes, each kind with its
// own checkbox, and nothing is written until the user applies them.
// Pure so it can be tested — the suite has no jsdom.
//
// Conservative in the same places:
//   - a rename onto another row's name is not applied (that is a merge);
//   - an existing translation is only replaced when the model said it is
//     WRONG, not merely worded differently;
//   - an existing description is only replaced when the model said it is
//     wrong, and that correction is proposed but not pre-selected;
//   - clearing a season on file is proposed but never pre-selected.
// ════════════════════════════════════════════════════════════════════════

export type CatalogKind = 'tools' | 'techniques' | 'units' | 'seasonality';

/** What can be asked of the AI, per catalog. */
export type CatalogAspect = 'naming' | 'description' | 'category' | 'synonyms' | 'season';

export const CATALOG_ASPECTS: Record<CatalogKind, CatalogAspect[]> = {
  tools: ['naming', 'description', 'category', 'synonyms'],
  techniques: ['naming', 'description', 'synonyms'],
  units: ['naming'],
  seasonality: ['season'],
};

export interface CatalogTidyItem {
  id: string;
  name: string;
  /** Unit symbol — shown to the model, never changed. */
  symbol?: string | null;
  translations?: Array<{ lang: string; name?: string | null }>;
  description?: string | null;
  category?: string | null;
  synonyms?: string[];
  seasonal_months?: number[] | null;
}

export interface CatalogSuggestion {
  key: string;
  name?: string;
  translations?: Array<{ lang: string; text: string }>;
  wrongTranslations?: string[];
  /** A description for a row with none, or the replacement for a wrong one. */
  description?: string | null;
  descriptionWrong?: boolean;
  category?: string | null;
  synonyms?: string[];
  /** 1-12; an empty list means "not a seasonal food". Absent = no answer. */
  months?: number[];
}

export interface CatalogProposal {
  id: string;
  oldName: string;
  newName?: string;
  duplicateOf?: { id: string; name: string };
  addTranslations: Array<{ lang: string; text: string }>;
  fixTranslations: Array<{ lang: string; from: string; to: string }>;
  /** from = null is a fill. */
  description?: { from: string | null; to: string };
  category?: { from: string | null; to: string };
  addSynonyms: string[];
  /** to = [] clears a season on file. */
  months?: { from: number[]; to: number[] };
}

export type CatalogChangeKind = 'name' | 'addTranslations' | 'fixTranslations' | 'description' | 'category' | 'synonyms' | 'months';

const norm = (s: string | null | undefined) => (s ?? '').trim();

/** 1-12, unique, ascending — anything else is dropped. */
export function cleanMonths(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const v of raw) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 12) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

const sameMonths = (a: number[], b: number[]) => a.length === b.length && a.every((m, i) => m === b[i]);

export function buildCatalogProposals(items: CatalogTidyItem[], suggestions: CatalogSuggestion[]): CatalogProposal[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const idByName = new Map<string, string>();
  for (const i of items) if (!idByName.has(norm(i.name).toLowerCase())) idByName.set(norm(i.name).toLowerCase(), i.id);

  const out: CatalogProposal[] = [];
  for (const s of suggestions) {
    const item = byId.get(s.key);
    if (!item) continue;
    const p: CatalogProposal = { id: item.id, oldName: item.name, addTranslations: [], fixTranslations: [], addSynonyms: [] };

    const newName = norm(s.name);
    if (newName && newName !== norm(item.name)) {
      const clash = idByName.get(newName.toLowerCase());
      if (clash && clash !== item.id) p.duplicateOf = { id: clash, name: byId.get(clash)!.name };
      else p.newName = newName;
    }

    if (!p.duplicateOf && s.translations) {
      const current = new Map(
        (item.translations ?? []).filter((t) => norm(t.name)).map((t) => [t.lang.toLowerCase(), norm(t.name)]),
      );
      const wrong = new Set((s.wrongTranslations ?? []).map((l) => l.toLowerCase()));
      for (const t of s.translations) {
        const lang = t.lang.toLowerCase();
        const text = norm(t.text);
        if (!text) continue;
        const have = current.get(lang);
        if (have === undefined) p.addTranslations.push({ lang, text });
        else if (wrong.has(lang) && have.toLowerCase() !== text.toLowerCase()) p.fixTranslations.push({ lang, from: have, to: text });
      }
    }

    const desc = norm(s.description);
    if (desc) {
      const have = norm(item.description);
      if (!have) p.description = { from: null, to: desc };
      else if (s.descriptionWrong && have.toLowerCase() !== desc.toLowerCase()) p.description = { from: have, to: desc };
    }

    const category = norm(s.category);
    if (category && category.toLowerCase() !== norm(item.category).toLowerCase()) {
      p.category = { from: norm(item.category) || null, to: category };
    }

    if (s.synonyms) {
      const taken = new Set([norm(item.name).toLowerCase(), newName.toLowerCase(), ...(item.synonyms ?? []).map((x) => x.toLowerCase())]);
      for (const syn of s.synonyms) {
        const clean = norm(syn);
        if (clean && !taken.has(clean.toLowerCase())) {
          p.addSynonyms.push(clean);
          taken.add(clean.toLowerCase());
        }
      }
    }

    if (s.months) {
      const from = cleanMonths(item.seasonal_months ?? []);
      const to = cleanMonths(s.months);
      if (!sameMonths(from, to)) p.months = { from, to };
    }

    if (catalogProposalKinds(p).length > 0 || p.duplicateOf) out.push(p);
  }
  return out;
}

export function catalogProposalKinds(p: CatalogProposal): CatalogChangeKind[] {
  const kinds: CatalogChangeKind[] = [];
  if (p.newName) kinds.push('name');
  if (p.addTranslations.length) kinds.push('addTranslations');
  if (p.fixTranslations.length) kinds.push('fixTranslations');
  if (p.description) kinds.push('description');
  if (p.category) kinds.push('category');
  if (p.addSynonyms.length) kinds.push('synonyms');
  if (p.months) kinds.push('months');
  return kinds;
}

export const catalogSelectionKey = (id: string, kind: CatalogChangeKind) => `${id}:${kind}`;

/** True for the changes that throw information away: replacing a
 *  description on file, and clearing a season on file. */
export function isLossyChange(p: CatalogProposal, kind: CatalogChangeKind): boolean {
  if (kind === 'description') return !!p.description?.from;
  if (kind === 'months') return !!p.months && p.months.to.length === 0;
  return false;
}

export function defaultCatalogSelection(proposals: CatalogProposal[]): Set<string> {
  const selected = new Set<string>();
  for (const p of proposals) {
    for (const kind of catalogProposalKinds(p)) {
      if (!isLossyChange(p, kind)) selected.add(catalogSelectionKey(p.id, kind));
    }
  }
  return selected;
}

/** The body of POST /api/<catalog>/:id/tidy (or, for seasonality,
 *  /api/ingredients/:id/naming) for the ticked changes, or null. */
export function catalogChangeFor(p: CatalogProposal, selected: Set<string>): Record<string, unknown> | null {
  const on = (kind: CatalogChangeKind) => selected.has(catalogSelectionKey(p.id, kind));
  const body: Record<string, unknown> = {};
  if (p.newName && on('name')) body.name = p.newName;
  const translations = [
    ...(on('addTranslations') ? p.addTranslations : []),
    ...(on('fixTranslations') ? p.fixTranslations.map((f) => ({ lang: f.lang, text: f.to })) : []),
  ];
  if (translations.length) body.translations = translations;
  if (p.description && on('description')) body.description = p.description.to;
  if (p.category && on('category')) body.category = p.category.to;
  if (p.addSynonyms.length && on('synonyms')) body.addSynonyms = p.addSynonyms;
  if (p.months && on('months')) body.seasonalMonths = p.months.to;
  return Object.keys(body).length ? body : null;
}
