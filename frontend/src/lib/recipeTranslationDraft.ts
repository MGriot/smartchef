// ════════════════════════════════════════════════════════════════════════
// SmartChef — Editing a recipe's translations, one language at a time
//
// A recipe's translatable text lives in three places in the editor's
// draft: the recipe's own `translations` (title, description), each step's
// (title, description, notes) and each ingredient row's (notes). The
// editor used to show one free-text "lang" list per place, so editing the
// English version meant opening a dozen little lists and typing "en" into
// each. These helpers let the editor pick ONE language and read or write
// every field of it, creating the entries on first write.
//
// Pure — no React — so the bookkeeping is tested on its own.
// ════════════════════════════════════════════════════════════════════════

export interface TrEntry {
  lang: string;
  title?: string;
  description?: string;
  notes?: string;
}

export type TrField = 'title' | 'description' | 'notes';

interface Translatable {
  translations?: TrEntry[] | null;
}

export interface TranslatableDraft extends Translatable {
  title?: string | null;
  description?: string | null;
  steps?: Array<Translatable & { title?: string | null; description?: string | null; notes?: string | null }>;
  ingredients?: Array<Translatable & { notes?: string | null }>;
}

/** The entry for `lang` on one translatable thing, if there is one. */
export function entryFor(item: Translatable | null | undefined, lang: string): TrEntry | undefined {
  return (item?.translations ?? []).find((t) => t.lang === lang);
}

/** `item`'s translations with `field` of `lang` set to `value`, the entry
 *  created when missing. An entry left with no text at all is dropped, so
 *  clearing every field of a language really removes it. */
export function withField<T extends Translatable>(item: T, lang: string, field: TrField, value: string): T {
  const list = [...(item.translations ?? [])];
  const at = list.findIndex((t) => t.lang === lang);
  const next: TrEntry = { ...(at >= 0 ? list[at] : { lang }), [field]: value };
  const empty = !next.title?.trim() && !next.description?.trim() && !next.notes?.trim();
  if (at >= 0) {
    if (empty) list.splice(at, 1);
    else list[at] = next;
  } else if (!empty) {
    list.push(next);
  }
  return { ...item, translations: list };
}

/** Every language the draft has at least one translated field in, in the
 *  order they first appear. */
export function languagesIn(draft: TranslatableDraft): string[] {
  const seen: string[] = [];
  const visit = (item?: Translatable | null) => {
    for (const t of item?.translations ?? []) {
      if (t.lang && !seen.includes(t.lang) && (t.title?.trim() || t.description?.trim() || t.notes?.trim())) seen.push(t.lang);
    }
  };
  visit(draft);
  draft.steps?.forEach(visit);
  draft.ingredients?.forEach(visit);
  return seen;
}

/** How much of `lang` is written: of the fields the original fills, how
 *  many have a translation. */
export function completeness(draft: TranslatableDraft, lang: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const count = (original: string | null | undefined, item: Translatable, field: TrField) => {
    if (!original?.trim()) return;
    total++;
    if (entryFor(item, lang)?.[field]?.trim()) done++;
  };
  count(draft.title, draft, 'title');
  count(draft.description, draft, 'description');
  for (const s of draft.steps ?? []) {
    count(s.title, s, 'title');
    count(s.description, s, 'description');
    count(s.notes, s, 'notes');
  }
  for (const i of draft.ingredients ?? []) count(i.notes, i, 'notes');
  return { done, total };
}

/** The draft with `lang` taken out of every translatable thing. */
export function withoutLanguage<T extends TranslatableDraft>(draft: T, lang: string): T {
  const strip = <U extends Translatable>(item: U): U => ({ ...item, translations: (item.translations ?? []).filter((t) => t.lang !== lang) });
  return {
    ...strip(draft),
    ...(draft.steps ? { steps: draft.steps.map(strip) } : {}),
    ...(draft.ingredients ? { ingredients: draft.ingredients.map(strip) } : {}),
  };
}

export interface MachineTranslation {
  title: string;
  description: string | null;
  steps: Array<{ id: string; title: string | null; description: string; notes: string | null }>;
  ingredientNotes: Array<{ id: string; notes: string }>;
}

/** What to send for an AI translation of the draft: keys are positions
 *  ("s0", "i3"), since a step added in this edit has no id yet. */
export function machineTranslationInput(draft: TranslatableDraft): MachineTranslation {
  return {
    title: draft.title ?? '',
    description: draft.description ?? null,
    steps: (draft.steps ?? []).map((s, n) => ({ id: `s${n}`, title: s.title ?? null, description: s.description ?? '', notes: s.notes ?? null })),
    ingredientNotes: (draft.ingredients ?? []).flatMap((i, n) => (i.notes?.trim() ? [{ id: `i${n}`, notes: i.notes }] : [])),
  };
}

/** Writes an AI translation into the draft — only into fields that are
 *  still empty for `lang`, so nothing the user already wrote is replaced. */
export function applyMachineTranslation<T extends TranslatableDraft>(draft: T, lang: string, tr: MachineTranslation): T {
  const fill = <U extends Translatable>(item: U, field: TrField, value: string | null | undefined): U =>
    value?.trim() && !entryFor(item, lang)?.[field]?.trim() ? withField(item, lang, field, value) : item;

  let next: T = fill(draft, 'title', tr.title);
  next = fill(next, 'description', tr.description);
  const stepById = new Map(tr.steps.map((s) => [s.id, s]));
  const noteById = new Map(tr.ingredientNotes.map((n) => [n.id, n.notes]));
  if (draft.steps) {
    next = {
      ...next,
      steps: draft.steps.map((s, n) => {
        const t = stepById.get(`s${n}`);
        if (!t) return s;
        let out = fill(s, 'title', s.title?.trim() ? t.title : null);
        out = fill(out, 'description', t.description);
        return fill(out, 'notes', s.notes?.trim() ? t.notes : null);
      }),
    };
  }
  if (draft.ingredients) {
    next = { ...next, ingredients: draft.ingredients.map((i, n) => fill(i, 'notes', noteById.get(`i${n}`))) };
  }
  return next;
}

/** A library entry's name in `lang`, from its `{lang, text}` translations —
 *  ingredient names live in the shared library, not on the recipe, so the
 *  translation panel can show them but not edit them. Matches the base
 *  language too ("it" finds "it-IT"); null when there is none. */
export function libraryNameIn(translations: Array<{ lang: string; text: string }> | null | undefined, lang: string): string | null {
  const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];
  const want = lang.trim().toLowerCase();
  const list = (translations ?? []).filter((t) => t.text?.trim());
  const hit = list.find((t) => t.lang.trim().toLowerCase() === want) ?? list.find((t) => base(t.lang) === base(want));
  return hit ? hit.text.trim() : null;
}
