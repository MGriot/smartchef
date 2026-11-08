// ════════════════════════════════════════════════════════════════════════
// SmartChef — Hybrid Logical Clock for the sync v2 change log
// (docs/plans/2026-11-01-sync-v2-change-log.md §2)
//
// Every change a device records is stamped with one of these. Two stamps
// from anywhere compare the same way on every device, so "the newest change
// to a field wins" gives every device the same answer whatever order the
// changes arrive in.
//
// Wall time alone is not enough: a phone with its clock a minute behind
// would lose every edit to a desktop, and two edits in the same millisecond
// would tie. An HLC keeps wall time as its first part but never goes
// backwards (it takes the larger of its own last stamp and any stamp it has
// seen), breaks same-millisecond ties with a counter, and breaks the last
// tie — two devices, same ms, same counter — with the device id.
//
// A stamp is one fixed-width string, `<ms:15>:<counter:5>:<device>`, so it
// sorts as plain text and is stored and indexed as TEXT.
// ════════════════════════════════════════════════════════════════════════

const MS_WIDTH = 15;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 36 ** COUNTER_WIDTH - 1;
/** A device whose clock runs this far ahead of anything else is not
 *  believed: its stamps would win every field for that long. */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export interface Hlc {
  ms: number;
  counter: number;
  device: string;
}

export function formatHlc(h: Hlc): string {
  return `${String(h.ms).padStart(MS_WIDTH, '0')}:${h.counter.toString(36).padStart(COUNTER_WIDTH, '0')}:${h.device}`;
}

export function parseHlc(s: string): Hlc | null {
  const m = /^(\d{15}):([0-9a-z]{5}):(.+)$/.exec(s);
  return m ? { ms: Number(m[1]), counter: parseInt(m[2], 36), device: m[3] } : null;
}

/** <0, 0, >0 like a sort comparator. The fixed width makes this plain
 *  string order. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The clock of one device: its last stamp, advanced by tick() for its own
 *  changes and by receive() for every stamp it reads from another device. */
export class HlcClock {
  private last: Hlc;

  constructor(readonly device: string, last?: string | null, private readonly now: () => number = Date.now) {
    const parsed = last ? parseHlc(last) : null;
    this.last = parsed ? { ...parsed, device } : { ms: 0, counter: 0, device };
  }

  /** A stamp for a change made on this device, later than every stamp this
   *  clock has issued or received. */
  tick(): string {
    const wall = this.now();
    if (wall > this.last.ms) this.last = { ms: wall, counter: 0, device: this.device };
    else this.last = { ms: this.last.ms, counter: this.bump(this.last.counter), device: this.device };
    return formatHlc(this.last);
  }

  /** Moves this clock past a stamp read from another device, so the next
   *  local change is stamped after it. Refuses a stamp too far in the
   *  future rather than dragging this clock there. */
  receive(stamp: string): void {
    const remote = parseHlc(stamp);
    if (!remote || remote.ms > this.now() + MAX_DRIFT_MS) return;
    if (remote.ms > this.last.ms) this.last = { ms: remote.ms, counter: remote.counter, device: this.device };
    else if (remote.ms === this.last.ms && remote.counter > this.last.counter) this.last = { ...this.last, counter: remote.counter };
  }

  private bump(counter: number): number {
    if (counter >= MAX_COUNTER) throw new Error('HLC counter overflow: more than 60 million stamps in one millisecond');
    return counter + 1;
  }
}
