// ════════════════════════════════════════════════════════════════════════
// SmartChef — Unit, temperature and tin conversion
//
// Purely for DISPLAY. Nothing here writes: a recipe stores what its author
// wrote, and switching the toggle re-renders it in other units without
// touching a row. That is deliberate — a stored conversion would round
// once, permanently, and "500 g" would become "17.6 oz" forever.
//
// Deliberately independent of the `units` table. The seeded catalogue is
// metric-only (g, kg, ml, l, tbsp, tsp, cup) with no imperial rows at all,
// so a conversion driven by `to_base_factor` alone would have nothing to
// convert *to*. This table is keyed by symbol and covers both systems, so
// the feature needs no migration and survives someone deleting a unit from
// their Library.
// ════════════════════════════════════════════════════════════════════════

export type Dimension = 'mass' | 'volume' | 'length';
export type MeasurementSystem = 'metric' | 'imperial';

interface UnitDef {
  dimension: Dimension;
  /** Multiplier to the dimension's base: grams, millilitres, millimetres. */
  toBase: number;
  system: MeasurementSystem;
  /** Canonical symbol to render, so "gr"/"grammi"/"g" all print as "g". */
  symbol: string;
  /** Belongs to no system: spoons are shared kitchen vocabulary, and an
   *  Italian "cucchiaio" and a US "tbsp" are both 15 ml in practice.
   *  Restating "1 tbsp" as "0.5 fl oz" helps nobody, so these are never
   *  rewritten in either direction. */
  neutral?: boolean;
}

// US customary volumes throughout (the ones recipes use). A US cup is
// 236.588 ml; the UK's is 284 ml and its teaspoon differs too, which is
// precisely why a recipe that says "1 cup" and one that says "240 ml" are
// not interchangeable without saying which cup you meant.
const UNITS: Record<string, UnitDef> = {
  // ── mass, metric ──
  mg: { dimension: 'mass', toBase: 0.001, system: 'metric', symbol: 'mg' },
  g: { dimension: 'mass', toBase: 1, system: 'metric', symbol: 'g' },
  gr: { dimension: 'mass', toBase: 1, system: 'metric', symbol: 'g' },
  grammi: { dimension: 'mass', toBase: 1, system: 'metric', symbol: 'g' },
  kg: { dimension: 'mass', toBase: 1000, system: 'metric', symbol: 'kg' },
  kilogrammi: { dimension: 'mass', toBase: 1000, system: 'metric', symbol: 'kg' },
  // ── mass, imperial ──
  oz: { dimension: 'mass', toBase: 28.349523125, system: 'imperial', symbol: 'oz' },
  lb: { dimension: 'mass', toBase: 453.59237, system: 'imperial', symbol: 'lb' },
  lbs: { dimension: 'mass', toBase: 453.59237, system: 'imperial', symbol: 'lb' },

  // ── volume, metric ──
  ml: { dimension: 'volume', toBase: 1, system: 'metric', symbol: 'ml' },
  millilitri: { dimension: 'volume', toBase: 1, system: 'metric', symbol: 'ml' },
  cl: { dimension: 'volume', toBase: 10, system: 'metric', symbol: 'cl' },
  dl: { dimension: 'volume', toBase: 100, system: 'metric', symbol: 'dl' },
  l: { dimension: 'volume', toBase: 1000, system: 'metric', symbol: 'l' },
  litri: { dimension: 'volume', toBase: 1000, system: 'metric', symbol: 'l' },
  // ── volume, spoons (system-neutral — see UnitDef.neutral) ──
  tsp: { dimension: 'volume', toBase: 5, system: 'metric', symbol: 'tsp', neutral: true },
  tbsp: { dimension: 'volume', toBase: 15, system: 'metric', symbol: 'tbsp', neutral: true },
  cucchiaino: { dimension: 'volume', toBase: 5, system: 'metric', symbol: 'tsp', neutral: true },
  cucchiaio: { dimension: 'volume', toBase: 15, system: 'metric', symbol: 'tbsp', neutral: true },
  // ── volume, imperial ──
  cup: { dimension: 'volume', toBase: 236.588, system: 'imperial', symbol: 'cup' },
  cups: { dimension: 'volume', toBase: 236.588, system: 'imperial', symbol: 'cup' },
  tazza: { dimension: 'volume', toBase: 236.588, system: 'imperial', symbol: 'cup' },
  'fl oz': { dimension: 'volume', toBase: 29.5735, system: 'imperial', symbol: 'fl oz' },
  floz: { dimension: 'volume', toBase: 29.5735, system: 'imperial', symbol: 'fl oz' },
  pint: { dimension: 'volume', toBase: 473.176, system: 'imperial', symbol: 'pint' },
  quart: { dimension: 'volume', toBase: 946.353, system: 'imperial', symbol: 'quart' },

  // ── length, for tins ──
  mm: { dimension: 'length', toBase: 1, system: 'metric', symbol: 'mm' },
  cm: { dimension: 'length', toBase: 10, system: 'metric', symbol: 'cm' },
  in: { dimension: 'length', toBase: 25.4, system: 'imperial', symbol: 'in' },
  inch: { dimension: 'length', toBase: 25.4, system: 'imperial', symbol: 'in' },
  inches: { dimension: 'length', toBase: 25.4, system: 'imperial', symbol: 'in' },
};

export function lookupUnit(symbol: string | null | undefined): UnitDef | null {
  if (!symbol) return null;
  return UNITS[symbol.trim().toLowerCase()] ?? null;
}

/** Value in `from` units expressed in `to` units, or null when the two
 *  aren't the same kind of thing (or either is unknown — "pz", "q.b." and
 *  anything else countable or vague has no conversion and must be left
 *  exactly as written). */
export function convert(value: number, from: string, to: string): number | null {
  const a = lookupUnit(from);
  const b = lookupUnit(to);
  if (!a || !b || a.dimension !== b.dimension) return null;
  return (value * a.toBase) / b.toBase;
}

/** Ladders, largest first, for picking a readable unit. */
const LADDERS: Record<Dimension, Record<MeasurementSystem, string[]>> = {
  mass: { metric: ['kg', 'g'], imperial: ['lb', 'oz'] },
  volume: { metric: ['l', 'ml'], imperial: ['quart', 'pint', 'cup', 'fl oz'] },
  length: { metric: ['cm', 'mm'], imperial: ['in'] },
};

/** Rounds for a kitchen, not a laboratory: three significant-ish figures
 *  near 1, whole numbers once the value is large. 236.588 ml reads as
 *  237 ml; 0.5 stays 0.5. */
export function roundForDisplay(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  if (abs >= 100) return Math.round(value);
  if (abs >= 10) return Math.round(value * 10) / 10;
  if (abs >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}

export interface ConvertedQuantity {
  value: number;
  symbol: string;
}

/**
 * Restates a quantity in the requested system, choosing a unit a cook would
 * actually say: 1 200 g becomes 1.2 kg, not 1200 g; 0.4 kg becomes 400 g.
 *
 * Returns null — meaning "render it unchanged" — when the unit is unknown,
 * dimensionless (pieces), or already in the requested system. Callers rely
 * on that: silently rewriting "2 pz" or "q.b." would be worse than doing
 * nothing.
 */
export function toSystem(
  value: number,
  symbol: string,
  system: MeasurementSystem,
): ConvertedQuantity | null {
  const unit = lookupUnit(symbol);
  if (!unit) return null;
  if (unit.neutral) return null;
  if (unit.system === system) return null;

  const ladder = LADDERS[unit.dimension][system];
  const base = value * unit.toBase;

  // Largest unit the value fills at least one of; otherwise the smallest,
  // so a tiny amount reads as "3 ml" rather than "0.003 l".
  for (const candidate of ladder) {
    const def = UNITS[candidate];
    if (base / def.toBase >= 1) {
      return { value: roundForDisplay(base / def.toBase), symbol: def.symbol };
    }
  }
  const smallest = UNITS[ladder[ladder.length - 1]];
  return { value: roundForDisplay(base / smallest.toBase), symbol: smallest.symbol };
}

/** The same tidy-up within one system: 1 200 g → 1.2 kg. */
export function normaliseMagnitude(value: number, symbol: string): ConvertedQuantity | null {
  const unit = lookupUnit(symbol);
  if (!unit || unit.neutral) return null;
  const ladder = LADDERS[unit.dimension][unit.system];
  if (!ladder.includes(unit.symbol)) return null;
  const base = value * unit.toBase;
  for (const candidate of ladder) {
    const def = UNITS[candidate];
    if (base / def.toBase >= 1) {
      const next = { value: roundForDisplay(base / def.toBase), symbol: def.symbol };
      return next.symbol === unit.symbol ? null : next;
    }
  }
  return null;
}

// ── Temperature ─────────────────────────────────────────────────────────
//
// Affine, not a factor — °F has an offset — so it deliberately cannot go
// through `toBase` above. Getting this wrong is the classic conversion bug:
// 180 °C is 356 °F, not 324.

export type TemperatureScale = 'C' | 'F' | 'gas';

/** UK gas marks. Gas 1 is 275 °F and each mark is 25 °F, except the two
 *  below it which are quarter and half marks at 225/250 °F. */
const GAS_MARKS: Array<{ mark: string; c: number }> = [
  { mark: '¼', c: 107 },
  { mark: '½', c: 121 },
  { mark: '1', c: 135 },
  { mark: '2', c: 149 },
  { mark: '3', c: 163 },
  { mark: '4', c: 177 },
  { mark: '5', c: 191 },
  { mark: '6', c: 204 },
  { mark: '7', c: 218 },
  { mark: '8', c: 232 },
  { mark: '9', c: 246 },
];

export function celsiusToFahrenheit(c: number): number {
  return c * 9 / 5 + 32;
}

export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

/** Nearest gas mark, since ovens have no in-between settings. Returns null
 *  outside the range gas marks cover rather than inventing "gas 14". */
export function celsiusToGasMark(c: number): string | null {
  if (c < 95 || c > 260) return null;
  let best = GAS_MARKS[0];
  for (const entry of GAS_MARKS) {
    if (Math.abs(entry.c - c) < Math.abs(best.c - c)) best = entry;
  }
  return best.mark;
}

export function gasMarkToCelsius(mark: string): number | null {
  return GAS_MARKS.find((g) => g.mark === mark.trim())?.c ?? null;
}

/** Oven temperatures are set in 5° steps; a converted 356.0000001 °F helps
 *  nobody. */
export function roundOvenTemperature(value: number): number {
  return Math.round(value / 5) * 5;
}

// ── Tin sizes ───────────────────────────────────────────────────────────
//
// Baking a 20 cm recipe in a 23 cm tin is a real question with an arithmetic
// answer: scale by the ratio of the areas, because depth is what you want
// to keep constant. Diameter alone would under-scale badly — 20→23 cm is a
// 32% increase in area, not 15%.

export type Tin =
  | { shape: 'round'; diameterCm: number }
  | { shape: 'rect'; widthCm: number; lengthCm: number };

export function tinAreaCm2(tin: Tin): number {
  return tin.shape === 'round'
    ? Math.PI * (tin.diameterCm / 2) ** 2
    : tin.widthCm * tin.lengthCm;
}

/** How much to multiply a recipe by when moving it from one tin to another.
 *  null if either tin is nonsense, so a caller never scales by 0 or ∞. */
export function tinScaleFactor(from: Tin, to: Tin): number | null {
  const a = tinAreaCm2(from);
  const b = tinAreaCm2(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.round((b / a) * 100) / 100;
}

/** Tins people actually own, for the picker. */
export const COMMON_TINS: Array<{ label: string; tin: Tin }> = [
  { label: '15 cm round (6")', tin: { shape: 'round', diameterCm: 15 } },
  { label: '18 cm round (7")', tin: { shape: 'round', diameterCm: 18 } },
  { label: '20 cm round (8")', tin: { shape: 'round', diameterCm: 20 } },
  { label: '23 cm round (9")', tin: { shape: 'round', diameterCm: 23 } },
  { label: '25 cm round (10")', tin: { shape: 'round', diameterCm: 25 } },
  { label: '28 cm round (11")', tin: { shape: 'round', diameterCm: 28 } },
  { label: '20 × 20 cm square', tin: { shape: 'rect', widthCm: 20, lengthCm: 20 } },
  { label: '23 × 23 cm square', tin: { shape: 'rect', widthCm: 23, lengthCm: 23 } },
  { label: '20 × 30 cm tray', tin: { shape: 'rect', widthCm: 20, lengthCm: 30 } },
  { label: '23 × 33 cm tray (9×13")', tin: { shape: 'rect', widthCm: 23, lengthCm: 33 } },
  { label: '900 g loaf (2 lb)', tin: { shape: 'rect', widthCm: 11, lengthCm: 21 } },
];
