// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Merge with AI" for several saved recipes
//
// The same dish saved more than once. The first recipe is the one that is
// kept; the model looks at the ingredients and steps of the others and says,
// for each one, whether it adds something (keep), repeats something already
// there (duplicate of ...) or does not belong (drop, with a reason).
//
// The point of this module is that the model can never make anything
// disappear on its own. It only ADVISES; the review dialog starts every
// row the model did not call "keep" unticked, shows it with its reason, and
// the user decides. And whatever the model fails to mention, or says
// something unusable about (an unknown reference, a duplicate pointing at
// nothing, a drop without a reason), comes back as a plain "keep" —
// the safe default. Pure, so the rules are testable without a model.
// ════════════════════════════════════════════════════════════════════════

export interface MergeAiIngredient {
  /** The recipe_ingredients row id, used to move the row if it is ticked. */
  id: string;
  label: string;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
}

export interface MergeAiStep {
  id: string;
  title: string | null;
  /** Plain text: {{ing:N}} tokens already turned back into words. */
  text: string;
  durationMin: number | null;
}

export interface MergeAiRecipe {
  id: string;
  title: string;
  ingredients: MergeAiIngredient[];
  steps: MergeAiStep[];
}

export type MergeAiAction = 'keep' | 'duplicate' | 'drop';
export type MergeAiGroup = 'ingredients' | 'steps';

export interface MergeAiItem {
  group: MergeAiGroup;
  /** Index of the recipe in the request (0 = the kept one). */
  recipeIndex: number;
  itemIndex: number;
  rowId: string;
  /** What the row says, ready to show. */
  text: string;
  action: MergeAiAction;
  /** For a duplicate: the row it repeats. */
  of: { recipeIndex: number; itemIndex: number; text: string } | null;
  reason: string | null;
  /** False when the model said nothing usable about the row. */
  judged: boolean;
}

export interface MergeAiProposal {
  /** Rows of the recipes to be folded in (index >= 1); the kept recipe's own rows are never in question. */
  items: MergeAiItem[];
  warnings: string[];
}

/** One row as the model reads it. */
export function describeIngredient(i: MergeAiIngredient): string {
  const amount = [i.quantity != null ? String(+i.quantity.toFixed(3)) : '', i.unit ?? ''].filter(Boolean).join(' ');
  return [amount, i.label, i.notes ? `(${i.notes})` : ''].filter(Boolean).join(' ');
}

export function describeStep(s: MergeAiStep): string {
  return s.title ? `${s.title} — ${s.text}` : s.text;
}

const refOf = (r: number, i: number) => `${r}.${i}`;

export function buildMergeManyRequest(recipes: MergeAiRecipe[]) {
  return {
    recipes: recipes.map((r, ri) => ({
      index: ri,
      kept: ri === 0,
      title: r.title,
      ingredients: r.ingredients.map((ing, i) => ({ ref: refOf(ri, i), text: describeIngredient(ing) })),
      steps: r.steps.map((s, i) => ({ ref: refOf(ri, i), text: describeStep(s), durationMin: s.durationMin })),
    })),
  };
}

export function buildMergeManySystemPrompt(): string {
  return `You help to fold several saved copies of the SAME dish into ONE recipe of a recipe-management app. You receive "recipes": the first one (index 0, "kept": true) is the recipe that stays; the others are copies that will be deleted, but the user may carry some of their ingredients and steps over to the kept one.

For every ingredient and every step of the recipes with index 1 or more, decide:
- "keep": it adds something the kept recipe lacks, or it is a different version worth keeping.
- "duplicate": it says the same thing as another row (in the kept recipe or in another copy). Give "of": the "ref" of that other row.
- "drop": it does not belong (not part of this dish, an advert, a note about something else, an unreadable fragment). Give a short "reason".

ABSOLUTE RULES:
- When in doubt, answer "keep". Never use "drop" for a row just because it differs from the kept recipe: another quantity, another wording or an extra detail is a "keep" (or a "duplicate" when it is really the same row).
- Rows of the kept recipe (index 0) are not judged; use them only as the target of an "of".
- Cover EVERY row of the copies exactly once. Copy each "ref" exactly as given.
- "reason": one short sentence, in the language of the recipe, for each "duplicate" and "drop".

Respond EXCLUSIVELY with JSON:
{"ingredients":[{"ref":"1.0","action":"keep"|"duplicate"|"drop","of":"0.2"|null,"reason":string|null}],"steps":[{"ref":"1.0","action":"keep"|"duplicate"|"drop","of":"0.1"|null,"reason":string|null}],"warnings":[]}`;
}

function parseRef(ref: unknown): { r: number; i: number } | null {
  if (typeof ref !== 'string') return null;
  const m = /^(\d+)\.(\d+)$/.exec(ref.trim());
  return m ? { r: Number(m[1]), i: Number(m[2]) } : null;
}

const clean = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

export function interpretMergeManyResponse(parsed: any, recipes: MergeAiRecipe[]): MergeAiProposal {
  const items: MergeAiItem[] = [];
  const warnings: string[] = Array.isArray(parsed?.warnings)
    ? [...new Set(parsed.warnings.map((w: unknown) => clean(w)).filter((w: string | null): w is string => !!w))].slice(0, 8) as string[]
    : [];

  for (const group of ['ingredients', 'steps'] as const) {
    const textOf = (r: number, i: number): string | null => {
      const row = recipes[r]?.[group][i];
      return row ? (group === 'ingredients' ? describeIngredient(row as MergeAiIngredient) : describeStep(row as MergeAiStep)) : null;
    };
    // What the model said about each row; the last answer wins, an
    // unknown or repeated reference is ignored.
    const said = new Map<string, any>();
    for (const row of Array.isArray(parsed?.[group]) ? parsed[group] : []) {
      const ref = parseRef(row?.ref);
      if (!ref || ref.r < 1 || !textOf(ref.r, ref.i)) continue;
      said.set(refOf(ref.r, ref.i), row);
    }

    for (let r = 1; r < recipes.length; r++) {
      for (let i = 0; i < recipes[r][group].length; i++) {
        const row = said.get(refOf(r, i));
        const base = {
          group, recipeIndex: r, itemIndex: i, rowId: recipes[r][group][i].id, text: textOf(r, i)!,
        };
        let action: MergeAiAction = row?.action === 'duplicate' || row?.action === 'drop' ? row.action : 'keep';
        const reason = clean(row?.reason);
        let of: MergeAiItem['of'] = null;

        if (action === 'duplicate') {
          const target = parseRef(row?.of);
          const ofText = target ? textOf(target.r, target.i) : null;
          // Must point at a different, existing row.
          if (target && ofText && !(target.r === r && target.i === i)) of = { recipeIndex: target.r, itemIndex: target.i, text: ofText };
          else action = 'keep';
        }
        // Throwing something away needs a stated reason.
        if (action === 'drop' && !reason) action = 'keep';

        items.push({ ...base, action, of, reason: action === 'keep' ? null : reason, judged: !!row && (action !== 'keep' || row?.action === 'keep') });
      }
    }
  }
  return { items, warnings };
}

/** What ticking decides: the rows of each copy to carry over. Only rows
 *  ticked in the dialog are listed; the rest go with the deleted copy. */
export function picksFor(
  recipes: MergeAiRecipe[],
  items: MergeAiItem[],
  ticked: ReadonlySet<string>,
): Array<{ sourceId: string; ingredientIds: string[]; stepIds: string[] }> {
  return recipes.slice(1).map((recipe, k) => {
    const r = k + 1;
    const ids = (group: MergeAiGroup) => items
      .filter((it) => it.group === group && it.recipeIndex === r && ticked.has(itemKey(it)))
      .map((it) => it.rowId);
    return { sourceId: recipe.id, ingredientIds: ids('ingredients'), stepIds: ids('steps') };
  });
}

export const itemKey = (it: Pick<MergeAiItem, 'group' | 'recipeIndex' | 'itemIndex'>) => `${it.group}:${it.recipeIndex}.${it.itemIndex}`;

/** The rows the dialog opens with ticked: the ones the model called "keep". */
export function defaultTicked(items: MergeAiItem[]): Set<string> {
  return new Set(items.filter((it) => it.action === 'keep').map(itemKey));
}
