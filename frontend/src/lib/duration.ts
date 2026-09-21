// ════════════════════════════════════════════════════════════════════════
// SmartChef — how long a recipe takes, said the way a person would say it
//
// A mirto is 15 days of maceration. The stats band used to render that as
// "360h", and the step below it as "720 minutes", because the two places
// that format a duration were unrelated: a private `formatTime` in
// RecipeDetail.tsx that stopped at hours, and a bare i18n plural
// (`recipeDetail.durationMinutes`) with no helper at all. Neither was
// wrong for a 40-minute pasta; both were useless past a day.
//
// Everything is stored in minutes and that does not change. This is
// presentation only: pick the largest unit that leaves a whole number of
// the next one down, and show at most two units — "2h 30m", "3 days",
// "2 weeks 1 day". A cook does not need "15 days 4 hours 22 minutes".
//
// Weeks stop at four: "6 weeks" is clearer than "1 month 2 weeks", and
// months are ambiguous in a way the others are not (28? 30? 31?), so this
// deliberately does not use them.
// ════════════════════════════════════════════════════════════════════════

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 60 * 24;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

export interface DurationPart {
  unit: 'week' | 'day' | 'hour' | 'minute';
  count: number;
}

/** The at-most-two units a duration should be shown in. Exported
 *  separately from the formatting so a caller can render them however it
 *  likes — and so this can be tested without i18next. */
export function durationParts(totalMinutes: number): DurationPart[] {
  const total = Math.max(0, Math.round(totalMinutes));
  if (total === 0) return [];

  if (total >= MINUTES_PER_WEEK) {
    const weeks = Math.floor(total / MINUTES_PER_WEEK);
    const days = Math.floor((total % MINUTES_PER_WEEK) / MINUTES_PER_DAY);
    return days ? [{ unit: 'week', count: weeks }, { unit: 'day', count: days }] : [{ unit: 'week', count: weeks }];
  }
  if (total >= MINUTES_PER_DAY) {
    const days = Math.floor(total / MINUTES_PER_DAY);
    const hours = Math.floor((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
    return hours ? [{ unit: 'day', count: days }, { unit: 'hour', count: hours }] : [{ unit: 'day', count: days }];
  }
  if (total >= MINUTES_PER_HOUR) {
    const hours = Math.floor(total / MINUTES_PER_HOUR);
    const minutes = total % MINUTES_PER_HOUR;
    return minutes ? [{ unit: 'hour', count: hours }, { unit: 'minute', count: minutes }] : [{ unit: 'hour', count: hours }];
  }
  return [{ unit: 'minute', count: total }];
}

/** Translates each part and joins them. `t` is i18next's, kept as a
 *  parameter so this module stays free of the i18n singleton (it is
 *  imported by the print path and by list cards that render before
 *  i18next has a namespace loaded).
 *
 *  `short` picks the compact forms the stats cards use ("2h 30m"); the
 *  long forms ("2 hours 30 minutes") read better inside a sentence, which
 *  is what a step's duration line is. */
export function formatDurationWith(
  t: (key: string, options?: Record<string, unknown>) => string,
  minutes: number | null | undefined,
  { short = false, empty = '—' }: { short?: boolean; empty?: string } = {},
): string {
  if (minutes === null || minutes === undefined || minutes <= 0) return empty;
  const suffix = short ? 'Short' : '';
  return durationParts(minutes)
    .map((part) => t(`duration.${part.unit}${suffix}`, { count: part.count }))
    .join(' ');
}
