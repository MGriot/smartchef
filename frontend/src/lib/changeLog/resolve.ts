// ════════════════════════════════════════════════════════════════════════
// SmartChef — deciding what an incoming change does (sync v2 §3)
//
// One rule decides the data: per path, the change with the newest HLC
// wins. Every device applies it, in whatever order changes arrive, and
// ends with the same library. That alone would silently drop the older of
// two edits made at the same time on two devices, which ADR 0001 rules
// out, so the second question is whether the change is CONCURRENT with
// what this device holds:
//
//   the author of the incoming change had read the device that wrote the
//   local value up to `seen[writer]`; if the local value's own sequence
//   number is beyond that, the author never saw it — both sides changed
//   the field without knowing of the other.
//
// A concurrent change with a different value becomes a conflict for the
// user under the "ask" policy, exactly like a three-way merge conflict
// today; under "newest" the newest simply wins. Set members never conflict:
// two adds or an add and a remove are not a disagreement anyone needs to
// settle (the old set merge never asked either). Pure.
// ════════════════════════════════════════════════════════════════════════

import { compareHlc } from './hlc';
import { pathInfo, pathValuesEqual } from './fieldPaths';

/** What this device last recorded for one path, and who wrote it. */
export interface PathState {
  value: unknown;
  hlc: string;
  device: string;
  /** The writer's own sequence number for that change. */
  seq: number;
}

export interface IncomingChange {
  device: string;
  seq: number;
  hlc: string;
  entityType: string;
  entityId: string;
  path: string;
  value: unknown;
}

export type Decision =
  /** Older than, or the same change as, what is here already. */
  | { action: 'ignore' }
  /** The incoming value replaces the local one. `concurrent` when the
   *  author had not seen the local value and the two differ. */
  | { action: 'apply'; concurrent: boolean }
  /** The local value stays (it is newer), but it was concurrent with this
   *  one and they differ — still a disagreement to show under "ask". */
  | { action: 'keep'; concurrent: true };

export function decide(local: PathState | undefined, incoming: IncomingChange, seen: Record<string, number>): Decision {
  if (!local) return { action: 'apply', concurrent: false };
  const order = compareHlc(incoming.hlc, local.hlc);
  if (order === 0) return { action: 'ignore' };
  const info = pathInfo(incoming.path);
  const concurrent = info.kind !== 'member'
    && local.device !== incoming.device
    && (seen[local.device] ?? 0) < local.seq
    && !pathValuesEqual(incoming.path, local.value, incoming.value);
  if (order > 0) return { action: 'apply', concurrent };
  return concurrent ? { action: 'keep', concurrent: true } : { action: 'ignore' };
}
