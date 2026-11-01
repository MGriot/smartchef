// ════════════════════════════════════════════════════════════════════════
// SmartChef — reading durations out of a quote, for the AI editor actions
//
// "Check with AI" and "Merge text with AI" (lib/recipeCheck.ts,
// lib/recipeMerge.ts) only accept a time the model proves with a quote, and
// used to accept it only when the number itself was in the quote (or its
// hours, ×60). "1 ora e 30 minuti" and "1h30" state 90 minutes without ever
// writing 90, so the commonest way a recipe gives a time was thrown away.
// This reads those compound durations; numbers spelt out in words stay
// unread on purpose — the quote must still show the figures.
//
// The other way to a recipe's overall time is adding up its steps. The model
// names which steps it added; sumStepDurations() redoes the sum, so the
// total is never the model's arithmetic.
// ════════════════════════════════════════════════════════════════════════

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
// Longer forms after the short ones: the (?!\p{L}) after each makes "h" give
// way to "hours", "m" to "minuti".
const HOUR = String.raw`(?:h|hrs?|hours?|or[ae]|horas?|heures?)`;
const MIN = String.raw`(?:m|mn|mins?|minut[eoi]s?|minutos?)`;
const JOIN = String.raw`(?:,|e|and|y|et)`;

const DURATION_RE = new RegExp(
  `${NUM}\\s*${HOUR}(?!\\p{L})(?:(\\s*${JOIN}\\s*|\\s*)(\\d{1,2})\\s*(${MIN}(?!\\p{L}))?)?|${NUM}\\s*${MIN}(?!\\p{L})`,
  'giu',
);

const toNumber = (s: string) => Number(s.replace(',', '.'));

/** Every duration the text writes in figures, in minutes: "1h30" → 90,
 *  "1 ora e 30 minuti" → 90, "2 ore" → 120, "45 min" → 45. */
export function durationsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of (text || '').matchAll(DURATION_RE)) {
    if (m[1] !== undefined) {
      // After a joining word the minutes need their unit: "1 ora e 2 uova"
      // is an hour and two eggs, not 62 minutes.
      const joined = !!m[2]?.trim();
      const minutes = m[3] !== undefined && (!joined || m[4] !== undefined) ? Number(m[3]) : 0;
      out.push(Math.round(toNumber(m[1]) * 60 + minutes));
    } else if (m[5] !== undefined) {
      out.push(Math.round(toNumber(m[5])));
    }
  }
  return out;
}

/** The sum of the durations of steps `indices`, or null when the list is not
 *  a usable one: empty, a repeated or unknown step, or a step with no
 *  duration (it cannot be added up, and the model must not have guessed it). */
export function sumStepDurations(durations: Array<number | null | undefined>, indices: unknown): number | null {
  if (!Array.isArray(indices) || indices.length === 0) return null;
  const seen = new Set<number>();
  let total = 0;
  for (const i of indices) {
    if (!Number.isInteger(i) || seen.has(i as number)) return null;
    const d = durations[i as number];
    if (d == null || !(d > 0)) return null;
    seen.add(i as number);
    total += d;
  }
  return total;
}
