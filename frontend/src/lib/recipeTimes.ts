// ════════════════════════════════════════════════════════════════════════
// SmartChef — a recipe's overall times, worked out from its steps
//
// Most recipes an AI reads never state "preparation 20 min, cooking 45":
// the durations are in the steps ("cuoci per 20 minuti"). The model is
// rightly forbidden to invent a time, so the recipe-level fields came back
// empty and the detail page showed "—" four times over, with every number
// it needed sitting in the steps.
//
// Adding up durations the recipe states is not inventing. The model only
// says what kind of time each timed step is (hands-on, cooking, waiting);
// the arithmetic is done here, and a time the recipe does state is never
// replaced by a sum. Pure: no i18n, no I/O.
// ════════════════════════════════════════════════════════════════════════

export type TimeKind = 'prep' | 'cook' | 'rest';

export interface RecipeTimes {
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
}

export interface TimedStep {
  durationMin?: number | null;
  timeKind?: unknown;
  /** The step's own words, used to tell the kind when the model did not. */
  description?: string | null;
}

// Waiting is looked for first: "lasciate raffreddare la torta cotta" is a
// rest, although it also names cooking.
const REST_RE = /\b(ripos|lievit|marin|raffredd|rassod|ammoll|ammorbid|in frigo|frigorifero|congel|rest(?:ing)?\b|chill|cool(?:s|ing)?\b|rise\b|rising|proof|soak|marinat|refriger|freez|set aside|repos|lever|refroid|tremper|reposar|enfriar|remojar)/i;
const COOK_RE = /\b(cuoc|cott|cuci|forno|inforn|boll|lessa|sobboll|frigg|fritt|rosol|soffrigg|tosta|griglia|arrost|brasa|stufa|saltat|vapore|bake|baking|boil|simmer|fry|frying|roast|grill|saut|sear|steam|braise|cook|oven|cuire|cuisson|four|bouill|mijot|frire|rôtir|cocer|cocina|horno|hervir|freír|asar)/i;

/** The kind of time a step's duration is: the model's answer when it gave a
 *  valid one, otherwise read from the step's wording (hands-on by default). */
export function timeKindOf(step: TimedStep): TimeKind {
  const said = typeof step.timeKind === 'string' ? step.timeKind.trim().toLowerCase() : '';
  if (said === 'prep' || said === 'cook' || said === 'rest') return said;
  const text = step.description ?? '';
  if (REST_RE.test(text)) return 'rest';
  if (COOK_RE.test(text)) return 'cook';
  return 'prep';
}

const positive = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;

/** The minutes the steps add up to, per kind. */
export function sumStepTimes(steps: TimedStep[]): Required<RecipeTimes> {
  const sums: Required<RecipeTimes> = { prepTimeMin: 0, cookTimeMin: 0, restTimeMin: 0 };
  for (const step of steps) {
    const minutes = positive(step.durationMin);
    if (!minutes) continue;
    const kind = timeKindOf(step);
    if (kind === 'prep') sums.prepTimeMin += minutes;
    else if (kind === 'cook') sums.cookTimeMin += minutes;
    else sums.restTimeMin += minutes;
  }
  return sums;
}

/** The recipe-level times: what the recipe states, and for each one it does
 *  not state, the sum of the step durations of that kind (when there is one). */
export function deriveRecipeTimes(stated: RecipeTimes, steps: TimedStep[]): RecipeTimes {
  const sums = sumStepTimes(steps);
  return {
    prepTimeMin: positive(stated.prepTimeMin) ?? positive(sums.prepTimeMin),
    cookTimeMin: positive(stated.cookTimeMin) ?? positive(sums.cookTimeMin),
    restTimeMin: positive(stated.restTimeMin) ?? positive(sums.restTimeMin),
  };
}

/** Every step duration added up: the total to show for a recipe saved with
 *  no overall times at all. 0 when no step has one. */
export function totalStepMinutes(steps: Array<{ durationMin?: number | null; duration_min?: number | null }>): number {
  return steps.reduce((total, s) => total + (positive(s.durationMin ?? s.duration_min) ?? 0), 0);
}
