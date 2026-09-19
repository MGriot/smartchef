// ════════════════════════════════════════════════════════════════════════
// SmartChef — healing unresolvable unit/category references before a merge
//
// Units and ingredient categories were seeded with random ids on every
// device before ADR 0006 gave them portable ones (`unit-g`, `cat-other`).
// Files written in that era, or by a device whose rows still point at its
// old ids, carry a `unit_id` with no `unit_symbol` (or a `category_id` with
// no `category_name`). No other device can resolve such a reference, so:
//   - the receiving device stored the id as-is, the join to `units` came
//     back empty, and every quantity showed without its unit;
//   - the merge compared "pz" on one side with `c81f0baf…` on the other and
//     recorded a conflict for content both devices actually agree on. With
//     no timestamp to decide it, the conflict stayed pending, and a pending
//     conflict keeps the REMOTE value in the tree — so the unresolvable ids
//     were republished by the very device that could have fixed them.
//
// A reference nobody can resolve is not an edit, it is "unknown". Before the
// three sides are compared, each unknown reference borrows the resolvable
// value the other sides hold for the same row. Pure: values in, values out.
// ════════════════════════════════════════════════════════════════════════

import { portableUnitId } from '../../services/syncExtras.local';

type Row = Record<string, unknown>;
type Entity = Record<string, unknown>;

export interface HealedSides {
  base: Entity;
  local: Entity;
  remote: Entity;
  /** Fields whose LOCAL value changed by healing — this device's own rows
   *  hold unresolvable references there and must be rewritten. */
  localHealed: string[];
  /** Fields whose REMOTE value changed by healing — the tree must carry
   *  the healed value, or the unresolvable ids travel on. */
  remoteHealed: string[];
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseRows(value: unknown): Row[] | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return Array.isArray(v) ? (v as Row[]) : null;
}

/** A unit reference no device can resolve: an id with no symbol beside it. */
export function hasUnknownUnit(row: Row): boolean {
  return present(row.unit_id) && !present(row.unit_symbol);
}

/** `unitId → symbol` from recipe steps' ingredient amounts, which have
 *  always carried both — the only place an old random id's meaning
 *  survives in the files. */
export function unitSymbolsFromSteps(...stepLists: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const steps of stepLists) {
    for (const step of parseRows(steps) ?? []) {
      for (const amount of parseRows(step?.step_ingredients) ?? []) {
        if (present(amount?.unitId) && present(amount?.unitSymbol)) out.set(amount.unitId, amount.unitSymbol);
      }
    }
  }
  return out;
}

function sameRow(a: Row, b: Row): boolean {
  if (present(a.id) && a.id === b.id) return true;
  return a.ingredient_id != null && a.ingredient_id === b.ingredient_id
    && a.sub_recipe_id == b.sub_recipe_id && a.sort_order == b.sort_order;
}

/** Returns `rows` with every unknown unit filled from a matching donor row
 *  or the step map, or null when nothing needed healing. */
function healIngredientRows(rows: Row[], donors: Row[][], stepSymbols: Map<string, string>): Row[] | null {
  let changed = false;
  const out = rows.map((row) => {
    if (!row || typeof row !== 'object' || !hasUnknownUnit(row)) return row;
    for (const donorRows of donors) {
      const donor = donorRows.find((d) => d && sameRow(row, d) && present(d.unit_symbol));
      if (donor) {
        changed = true;
        return { ...row, unit_id: donor.unit_id ?? portableUnitId(donor.unit_symbol as string), unit_symbol: donor.unit_symbol };
      }
    }
    const symbol = stepSymbols.get(row.unit_id as string);
    if (symbol) {
      changed = true;
      return { ...row, unit_id: portableUnitId(symbol), unit_symbol: symbol };
    }
    return row;
  });
  return changed ? out : null;
}

/** Heals one recipe `ingredients` value against the others. Keeps the
 *  representation (JSON string vs array) the value came in. */
export function healIngredientsValue(value: unknown, ...others: unknown[]): unknown {
  const rows = parseRows(value);
  if (!rows) return value;
  const donors = others.map(parseRows).filter((r): r is Row[] => !!r);
  const healed = healIngredientRows(rows, donors, new Map());
  if (!healed) return value;
  return typeof value === 'string' ? JSON.stringify(healed) : healed;
}

/** Heals every side of one entity before it is merged. */
export function healEntitySides(entityType: string, base: Entity, local: Entity, remote: Entity): HealedSides {
  const sides = { base: { ...base }, local: { ...local }, remote: { ...remote } };
  const localHealed: string[] = [];
  const remoteHealed: string[] = [];
  const order = ['local', 'remote', 'base'] as const;

  if (entityType === 'recipe') {
    const stepSymbols = unitSymbolsFromSteps(local.steps, remote.steps, base.steps);
    const parsed = Object.fromEntries(order.map((s) => [s, parseRows(sides[s].ingredients)])) as Record<(typeof order)[number], Row[] | null>;
    for (const side of order) {
      const rows = parsed[side];
      if (!rows) continue;
      const donors = order.filter((o) => o !== side).map((o) => parsed[o]).filter((r): r is Row[] => !!r);
      const healed = healIngredientRows(rows, donors, stepSymbols);
      if (!healed) continue;
      sides[side].ingredients = typeof sides[side].ingredients === 'string' ? JSON.stringify(healed) : healed;
      if (side === 'local') localHealed.push('ingredients');
      if (side === 'remote') remoteHealed.push('ingredients');
    }
  }

  if (entityType === 'ingredient') {
    // A category id with no name beside it is one this side couldn't
    // resolve; a cleared category has no id either.
    const unknown = (e: Entity) => present(e.category_id) && !present(e.category_name);
    const donor = order.map((s) => sides[s]).find((e) => present(e.category_name));
    if (donor) {
      for (const side of order) {
        if (!unknown(sides[side])) continue;
        sides[side].category_name = donor.category_name;
        if (side === 'local') localHealed.push('category_name');
        if (side === 'remote') remoteHealed.push('category_name');
      }
    }
  }

  return { ...sides, localHealed, remoteHealed };
}
