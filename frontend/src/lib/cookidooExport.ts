// ════════════════════════════════════════════════════════════════════════
// SmartChef — Cookidoo (Bimby/Thermomix) recipe-creator export
//
// Cookidoo's "Crea ricetta" form has no import: every field is typed or
// pasted by hand. So the useful thing this can produce is not a file
// format but *text shaped like that form* — one block per field, in the
// form's own order, using its own field names, so the user pastes each
// block straight into the matching input.
//
// The form's fields, in order (Cookidoo web, IT locale):
//   Titolo · Immagine · Tempo di preparazione · Tempo totale · Porzioni ·
//   Ingredienti · Passaggi della preparazione · Dispositivi & accessori ·
//   Consigli
// "Immagine" is an upload widget and has no text equivalent, so it is the
// one field with no section here.
//
// Deliberately label-injected rather than importing i18n: this stays a
// pure function so it can be unit-tested against fixed strings, and the
// caller (RecipeDetail.tsx) passes `t(...)` values for the user's actual
// language. Cookidoo's own field names differ per locale, which is exactly
// why the labels have to come from the locale files rather than be baked
// in here.
// ════════════════════════════════════════════════════════════════════════

export interface CookidooIngredient {
  ingredientName?: string | null;
  ingredientPluralName?: string | null;
  subRecipeTitle?: string | null;
  quantity?: number | null;
  quantityText?: string | null;
  unitSymbol?: string | null;
  isOptional?: boolean;
  notes?: string | null;
  translatedNotes?: string | null;
  groupName?: string | null;
}

export interface CookidooStep {
  stepNumber: number;
  title?: string | null;
  translatedTitle?: string | null;
  description: string;
  translatedDescription?: string | null;
  durationMin?: number | null;
  notes?: string | null;
  translatedNotes?: string | null;
}

export interface CookidooNamed {
  name: string;
  translated_name?: string | null;
}

export interface CookidooRecipeInput {
  title: string;
  translated_title?: string | null;
  description?: string | null;
  translated_description?: string | null;
  tips?: string | null;
  storage_instructions?: string | null;
  servings: number;
  prep_time_min?: number | null;
  cook_time_min?: number | null;
  rest_time_min?: number | null;
  ingredients?: CookidooIngredient[];
  steps?: CookidooStep[];
  tools?: CookidooNamed[];
  techniques?: CookidooNamed[];
}

/** Every visible string, supplied by the caller from the locale files so
 *  the output matches the Cookidoo form the user is actually looking at. */
export interface CookidooLabels {
  title: string;
  prepTime: string;
  totalTime: string;
  servings: string;
  servingsValue: (n: number) => string;
  ingredients: string;
  steps: string;
  devices: string;
  tips: string;
  optional: string;
  hourShort: string;
  minuteShort: string;
  storagePrefix: string;
  techniquesPrefix: string;
}

export interface CookidooSection {
  /** Stable identifier for the UI's per-section copy buttons — never shown. */
  key: 'title' | 'prepTime' | 'totalTime' | 'servings' | 'ingredients' | 'steps' | 'devices' | 'tips';
  /** The Cookidoo field name this block belongs in. */
  label: string;
  text: string;
}

export interface CookidooExport {
  sections: CookidooSection[];
  /** Every section as one document, `Label\nvalue` separated by blank
   *  lines — for "copy everything" and for the .txt download. */
  fullText: string;
}

/** At most 2 decimals, trailing zeros stripped: 200 -> "200", 1.5 -> "1.5",
 *  0.333… -> "0.33". Scaling a recipe to an odd serving count otherwise
 *  produces amounts like "66.66666666666667 g". */
export function formatQuantity(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** "45 min", "1 h", "1 h 30 min". Cookidoo's own time fields read this way. */
export function formatDuration(totalMin: number, labels: Pick<CookidooLabels, 'hourShort' | 'minuteShort'>): string {
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes} ${labels.minuteShort}`;
  if (minutes === 0) return `${hours} ${labels.hourShort}`;
  return `${hours} ${labels.hourShort} ${minutes} ${labels.minuteShort}`;
}

function pickName(name: string, pluralName: string | null | undefined, quantity: number | null | undefined): string {
  // Same rule as lib/ingredientDisplay.ts's pickIngredientName(), inlined
  // to keep this module dependency-free.
  const isPlural = typeof quantity === 'number' && quantity !== 0 && Math.abs(quantity - 1) > 1e-9;
  return isPlural && pluralName ? pluralName : name;
}

function ingredientLine(ing: CookidooIngredient, scale: number, labels: CookidooLabels): string {
  const scaled = typeof ing.quantity === 'number' ? ing.quantity * scale : null;
  const name = ing.ingredientName
    ? pickName(ing.ingredientName, ing.ingredientPluralName, scaled)
    : ing.subRecipeTitle ?? '';

  // `quantityText` is the free-text amount ("q.b.", "a pinch") used when
  // there's no numeric quantity — it can't be scaled, so it passes through.
  const amount = scaled !== null
    ? [formatQuantity(scaled), ing.unitSymbol ?? ''].filter(Boolean).join(' ')
    : ing.quantityText ?? '';

  const parts = [amount, name].filter(part => part.trim().length > 0);
  let line = parts.join(' ');

  const notes = ing.translatedNotes || ing.notes;
  if (notes?.trim()) line += `, ${notes.trim()}`;
  if (ing.isOptional) line += ` (${labels.optional})`;
  return line;
}

function buildIngredientsText(recipe: CookidooRecipeInput, scale: number, labels: CookidooLabels): string {
  const ingredients = recipe.ingredients ?? [];
  if (ingredients.length === 0) return '';

  const lines: string[] = [];
  let currentGroup: string | null = null;
  for (const ing of ingredients) {
    // Cookidoo supports ingredient group headings ("Per l'impasto"), and
    // they're a plain line above their members there too — so a group only
    // needs emitting when it changes, exactly as the recipe stores it.
    const group = ing.groupName?.trim() || null;
    if (group !== currentGroup) {
      if (group) {
        if (lines.length > 0) lines.push('');
        lines.push(group);
      }
      currentGroup = group;
    }
    lines.push(ingredientLine(ing, scale, labels));
  }
  return lines.join('\n');
}

function buildStepsText(recipe: CookidooRecipeInput, labels: CookidooLabels): string {
  const steps = recipe.steps ?? [];
  if (steps.length === 0) return '';

  return steps
    .slice()
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((step, i) => {
      const title = (step.translatedTitle || step.title || '').trim();
      const description = (step.translatedDescription || step.description || '').trim();
      const notes = (step.translatedNotes || step.notes || '').trim();

      let body = title && description ? `${title}: ${description}` : title || description;
      if (typeof step.durationMin === 'number' && step.durationMin > 0) {
        body += ` (${formatDuration(step.durationMin, labels)})`;
      }
      if (notes) body += `\n   ${notes}`;
      // Renumbered from the array order rather than trusting stepNumber:
      // a recipe edited by deleting a middle step can leave gaps, and a
      // numbered list pasted into Cookidoo should read 1, 2, 3.
      return `${i + 1}. ${body}`;
    })
    .join('\n');
}

function buildTipsText(recipe: CookidooRecipeInput, labels: CookidooLabels): string {
  const blocks: string[] = [];
  if (recipe.tips?.trim()) blocks.push(recipe.tips.trim());
  if (recipe.storage_instructions?.trim()) {
    blocks.push(`${labels.storagePrefix}: ${recipe.storage_instructions.trim()}`);
  }
  // Techniques have no Cookidoo field of their own; they're closest in
  // spirit to "Consigli" (notes and variants) so they ride along there
  // rather than being silently dropped from the export.
  const techniques = (recipe.techniques ?? []).map(x => x.translated_name || x.name).filter(Boolean);
  if (techniques.length > 0) {
    blocks.push(`${labels.techniquesPrefix}: ${techniques.join(', ')}`);
  }
  return blocks.join('\n\n');
}

export interface BuildCookidooExportOptions {
  /** Servings the user is currently viewing. Ingredient amounts are scaled
   *  to it, matching what the recipe page shows — exporting a recipe you've
   *  scaled to 6 portions and getting the 4-portion amounts back would be
   *  the surprising behaviour. Defaults to the recipe's own servings. */
  servings?: number;
}

export function buildCookidooExport(
  recipe: CookidooRecipeInput,
  labels: CookidooLabels,
  options: BuildCookidooExportOptions = {}
): CookidooExport {
  const baseServings = recipe.servings > 0 ? recipe.servings : 1;
  const targetServings = options.servings && options.servings > 0 ? options.servings : baseServings;
  const scale = targetServings / baseServings;

  const prep = recipe.prep_time_min ?? 0;
  const cook = recipe.cook_time_min ?? 0;
  const rest = recipe.rest_time_min ?? 0;
  // Cookidoo's "Tempo totale" is wall-clock start-to-finish, so resting
  // counts even though it isn't active work — unlike "Tempo di
  // preparazione", which is the hands-on part only.
  const total = prep + cook + rest;

  const candidates: CookidooSection[] = [
    { key: 'title', label: labels.title, text: (recipe.translated_title || recipe.title || '').trim() },
    { key: 'prepTime', label: labels.prepTime, text: prep > 0 ? formatDuration(prep, labels) : '' },
    { key: 'totalTime', label: labels.totalTime, text: total > 0 ? formatDuration(total, labels) : '' },
    { key: 'servings', label: labels.servings, text: labels.servingsValue(targetServings) },
    { key: 'ingredients', label: labels.ingredients, text: buildIngredientsText(recipe, scale, labels) },
    { key: 'steps', label: labels.steps, text: buildStepsText(recipe, labels) },
    {
      key: 'devices',
      label: labels.devices,
      text: (recipe.tools ?? []).map(x => x.translated_name || x.name).filter(Boolean).join('\n'),
    },
    { key: 'tips', label: labels.tips, text: buildTipsText(recipe, labels) },
  ];

  // An empty field is nothing to paste, so it's dropped rather than
  // emitted as a bare heading the user has to scroll past.
  const sections = candidates.filter(s => s.text.trim().length > 0);

  return {
    sections,
    fullText: sections.map(s => `${s.label}\n${s.text}`).join('\n\n'),
  };
}
