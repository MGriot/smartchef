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
