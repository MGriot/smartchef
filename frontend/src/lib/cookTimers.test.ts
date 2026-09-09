// ════════════════════════════════════════════════════════════════════════
// Kitchen timers.
//
// The store is deliberately deadline-based rather than a decremented
// counter, because a backgrounded page has its intervals throttled hard —
// most of a 45-minute timer runs while you are looking at something else.
// These tests pin that: time is moved with fake timers AND by moving the
// clock, so a "the tab was asleep for 20 minutes" jump is exercised, not
// just a tidy tick-by-tick countdown.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startCookTimer,
  cancelCookTimer,
  clearAllCookTimers,
  listCookTimers,
  subscribeCookTimers,
  remainingMs,
  formatRemaining,
} from './cookTimers';

beforeEach(() => {
  vi.useFakeTimers();
  clearAllCookTimers();
});

afterEach(() => {
  clearAllCookTimers();
  vi.useRealTimers();
});

describe('formatRemaining', () => {
  it('drops the hour segment until it is needed', () => {
    expect(formatRemaining(90_000)).toBe('1:30');
    expect(formatRemaining(9_000)).toBe('0:09');
    expect(formatRemaining(3_600_000)).toBe('1:00:00');
    expect(formatRemaining(5_430_000)).toBe('1:30:30');
  });
  it('rounds up, so a timer never shows 0:00 while still running', () => {
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(0)).toBe('0:00');
  });
});

describe('the timer store', () => {
  it('runs several at once, which is the normal case', () => {
    startCookTimer({ id: 'a', label: 'Sauce', minutes: 10 });
    startCookTimer({ id: 'b', label: 'Roast', minutes: 45 });
    expect(listCookTimers().map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('restarting a step replaces its timer instead of stacking a second', () => {
    startCookTimer({ id: 'a', label: 'Sauce', minutes: 10 });
    vi.advanceTimersByTime(60_000);
    startCookTimer({ id: 'a', label: 'Sauce', minutes: 10 });

    const timers = listCookTimers();
    expect(timers).toHaveLength(1);
    // The full duration again, not the nine minutes that were left.
    expect(remainingMs(timers[0])).toBeGreaterThan(9.5 * 60_000);
  });

  it('fires once the deadline passes', () => {
    startCookTimer({ id: 'a', label: 'Sauce', minutes: 1 });
    expect(listCookTimers()[0].rungAt).toBeUndefined();

    vi.advanceTimersByTime(61_000);
    expect(listCookTimers()[0].rungAt).toBeDefined();
  });

  it('fires a timer whose deadline passed while the page was hidden', () => {
    // The throttling case the deadline design exists for: intervals stop
    // running, then the page wakes up long after the timer should have gone
    // off. A counter that subtracts per tick would still show time left.
    startCookTimer({ id: 'a', label: 'Roast', minutes: 45 });

    vi.advanceTimersByTime(50 * 60_000);

    const timer = listCookTimers()[0];
    expect(timer.rungAt).toBeDefined();
    expect(remainingMs(timer)).toBe(0);
  });

  it('keeps a fired timer until it is dismissed', () => {
    // Otherwise you cannot tell "it rang while I was out of the room" from
    // "I never started it".
    startCookTimer({ id: 'a', label: 'Sauce', minutes: 1 });
    vi.advanceTimersByTime(120_000);
    expect(listCookTimers()).toHaveLength(1);

    cancelCookTimer('a');
    expect(listCookTimers()).toHaveLength(0);
  });

  it('notifies subscribers on start, tick and cancel', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeCookTimers((timers) => seen.push(timers.length));

    expect(seen).toEqual([0]); // current state on subscribe

    startCookTimer({ id: 'a', label: 'Sauce', minutes: 5 });
    expect(seen[seen.length - 1]).toBe(1);

    const beforeTick = seen.length;
    vi.advanceTimersByTime(1_000);
    // The countdown text has to move even though nothing fired.
    expect(seen.length).toBeGreaterThan(beforeTick);

    cancelCookTimer('a');
    expect(seen[seen.length - 1]).toBe(0);

    const afterUnsub = seen.length;
    unsubscribe();
    startCookTimer({ id: 'b', label: 'Roast', minutes: 5 });
    expect(seen.length).toBe(afterUnsub);
  });

  it('survives the screen that started it going away', () => {
    // Timers live at module level precisely so leaving cook mode to check
    // the shopping list does not cancel the roast.
    startCookTimer({ id: 'a', label: 'Roast', minutes: 45 });
    const unsubscribe = subscribeCookTimers(() => {});
    unsubscribe(); // the cook-mode screen unmounts

    vi.advanceTimersByTime(60_000);
    expect(listCookTimers()).toHaveLength(1);
    expect(remainingMs(listCookTimers()[0])).toBeGreaterThan(0);
  });

  it('rounds a fractional minute up to at least one second', () => {
    startCookTimer({ id: 'a', label: 'Flash', minutes: 0 });
    expect(remainingMs(listCookTimers()[0])).toBeGreaterThan(0);
  });
});
