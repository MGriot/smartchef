// ════════════════════════════════════════════════════════════════════════
// SmartChef — a duration a language model returned, as whole minutes
//
// The import prompt asks for numbers of minutes, but models also answer
// "30", "1h 30", "1 ora e 30 minuti", "2 days" or an ISO "PT1H30M" (the
// form recipe pages use). The parser used to keep only a JSON number, so
// every other spelling lost the time without a trace. This reads all of
// them; anything it cannot read as a duration stays undefined, never a
// guess. Pure: no i18n, no I/O.
// ════════════════════════════════════════════════════════════════════════

const UNIT_MINUTES: Array<[RegExp, number]> = [
  [/^(w|wk|wks|week|weeks|settiman[ae]|sett)$/i, 60 * 24 * 7],
  [/^(d|day|days|giorn[oi]|g)$/i, 60 * 24],
  [/^(h|hr|hrs|hour|hours|or[ae]|ore)$/i, 60],
  [/^(m|min|mins|minute|minutes|minut[oi])$/i, 1],
];

function unitMinutes(unit: string): number | null {
  for (const [pattern, minutes] of UNIT_MINUTES) if (pattern.test(unit)) return minutes;
  return null;
}

/** Whole minutes for a model's duration value, or undefined. */
export function parseMinutes(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;

  // A bare number ("30", "1,5" is not minutes-like and is left alone).
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));

  // ISO 8601: PT1H30M, P1DT2H, PT45M.
  const iso = /^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?)?$/.exec(text);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * 1440 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  }

  // "1h 30", "1 ora e 30 minuti", "2 days", "1h30m": number + unit pairs; a
  // trailing bare number after an hour part counts as minutes ("1h30").
  let total = 0;
  let matched = false;
  let lastUnit = 0;
  const pairs = /(\d+(?:[.,]\d+)?)\s*([a-zàèéìòù]+)?/g;
  for (const m of text.matchAll(pairs)) {
    const amount = Number(m[1].replace(',', '.'));
    const unit = m[2] ? unitMinutes(m[2]) : null;
    if (m[2] && unit === null && !/^(e|and|et|y)$/.test(m[2])) return undefined; // an unknown word: not a duration
    if (unit !== null) {
      total += amount * unit;
      lastUnit = unit;
      matched = true;
    } else if (lastUnit === 60) {
      total += amount;
      matched = true;
    } else {
      return undefined;
    }
  }
  return matched ? Math.round(total) : undefined;
}
