// ════════════════════════════════════════════════════════════════════════
// The gallery's "still downloading your library" banner and its live
// refill both hang off this, and both have a failure mode that is only
// visible in the details:
//
//  - `running` must clear even when a cycle THROWS, or one unreachable
//    remote leaves a spinner up for the rest of the session.
//  - `appliedRevision` must move only when a cycle actually wrote
//    something, or every idle five-minute tick refetches every open screen.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

const {
  getSyncStatus,
  subscribeSyncStatus,
  reportSyncStarted,
  reportSyncFinished,
  stalePush,
} = await import('./syncStatus');

beforeEach(() => {
  // Settle back to a known state between cases — the module is a singleton.
  reportSyncFinished(0);
});

describe('running', () => {
  it('is published to subscribers when a cycle starts and finishes', () => {
    const seen: boolean[] = [];
    const stop = subscribeSyncStatus((s) => seen.push(s.running));

    reportSyncStarted();
    reportSyncFinished(0);
    stop();

    expect(seen).toEqual([true, false]);
    expect(getSyncStatus().running).toBe(false);
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const stop = subscribeSyncStatus(() => { calls++; });
    reportSyncStarted();
    stop();
    reportSyncFinished(0);

    expect(calls).toBe(1);
  });

  it('keeps telling the other subscribers when one throws', () => {
    let reached = false;
    const stopBad = subscribeSyncStatus(() => { throw new Error('boom'); });
    const stopGood = subscribeSyncStatus(() => { reached = true; });

    expect(() => reportSyncStarted()).not.toThrow();
    expect(reached).toBe(true);

    stopBad();
    stopGood();
  });
});

describe('appliedRevision', () => {
  it('does not move for a cycle that applied nothing', () => {
    const before = getSyncStatus().appliedRevision;

    reportSyncStarted();
    reportSyncFinished(0);

    expect(getSyncStatus().appliedRevision).toBe(before);
  });

  it('moves once per cycle that applied entities', () => {
    const before = getSyncStatus().appliedRevision;

    reportSyncStarted();
    reportSyncFinished(12);
    reportSyncStarted();
    reportSyncFinished(3);

    expect(getSyncStatus().appliedRevision).toBe(before + 2);
  });

  it('is a monotonic counter, so a subscriber can use it as a refetch key', () => {
    const seen: number[] = [];
    const stop = subscribeSyncStatus((s) => seen.push(s.appliedRevision));

    reportSyncStarted();
    reportSyncFinished(5);
    stop();

    // Never decreases, and the finish is distinguishable from the start.
    expect(seen[1]).toBe(seen[0] + 1);
  });
});

// ── Detecting a device that receives but never sends ────────────────────
// The failure this exists for: a desktop completed sync cycles for a week —
// fetching correctly the whole time — while every push was rejected for
// credentials. lastSyncAt kept advancing, so nothing looked wrong. A push
// timestamp that stops advancing is the signal that does not lie.
describe('stalePush', () => {
  const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();

  it('flags a device that has synced recently but not pushed in days', () => {
    expect(stalePush(hoursAgo(0), hoursAgo(24 * 7))).toBe(true);
  });

  it('says nothing about a device pushing normally', () => {
    // A healthy device advances the push timestamp on every cycle it has
    // commits for, so these two stay close together.
    expect(stalePush(hoursAgo(0), hoursAgo(0))).toBe(false);
    expect(stalePush(hoursAgo(0), hoursAgo(2))).toBe(false);
  });

  it('tolerates a quiet day before complaining', () => {
    expect(stalePush(hoursAgo(0), hoursAgo(23))).toBe(false);
    expect(stalePush(hoursAgo(0), hoursAgo(25))).toBe(true);
  });

  it('stays silent when the device has never pushed', () => {
    // Deliberate: a device that has genuinely never had anything to send
    // would otherwise be accused of failing on its first launch. The pause
    // banner covers that case, with the actual reason.
    expect(stalePush(hoursAgo(0), null)).toBe(false);
  });

  it('stays silent before the first completed sync', () => {
    expect(stalePush(null, hoursAgo(100))).toBe(false);
    expect(stalePush(null, null)).toBe(false);
  });

  it('does not treat an unparseable timestamp as a failure', () => {
    expect(stalePush('not a date', hoursAgo(100))).toBe(false);
    expect(stalePush(hoursAgo(0), 'not a date')).toBe(false);
  });
});
