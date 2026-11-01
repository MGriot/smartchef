import { describe, it, expect } from 'vitest';
import { HlcClock, compareHlc, formatHlc, parseHlc, MAX_DRIFT_MS } from './hlc';

describe('HlcClock', () => {
  it('follows wall time, and counts within one millisecond', () => {
    let now = 1000;
    const c = new HlcClock('A', null, () => now);
    const a = c.tick();
    const b = c.tick();
    now = 2000;
    const d = c.tick();
    expect(parseHlc(a)).toEqual({ ms: 1000, counter: 0, device: 'A' });
    expect(parseHlc(b)).toEqual({ ms: 1000, counter: 1, device: 'A' });
    expect(parseHlc(d)).toEqual({ ms: 2000, counter: 0, device: 'A' });
    expect([d, a, b].sort(compareHlc)).toEqual([a, b, d]);
  });

  it('never goes backwards when the wall clock does', () => {
    let now = 5000;
    const c = new HlcClock('A', null, () => now);
    const first = c.tick();
    now = 1000;
    expect(compareHlc(c.tick(), first)).toBeGreaterThan(0);
  });

  it('stamps after anything it received, even from a device whose clock is ahead', () => {
    const behind = new HlcClock('A', null, () => 1000);
    const ahead = new HlcClock('B', null, () => 60_000);
    const theirs = ahead.tick();
    behind.receive(theirs);
    expect(compareHlc(behind.tick(), theirs)).toBeGreaterThan(0);
  });

  it('resumes after a restart from the last stamp it gave out', () => {
    const c = new HlcClock('A', formatHlc({ ms: 9000, counter: 3, device: 'A' }), () => 1000);
    expect(parseHlc(c.tick())).toEqual({ ms: 9000, counter: 4, device: 'A' });
  });

  it('ignores a stamp from absurdly far in the future', () => {
    const c = new HlcClock('A', null, () => 1000);
    c.receive(formatHlc({ ms: 1000 + MAX_DRIFT_MS + 1, counter: 0, device: 'B' }));
    expect(parseHlc(c.tick())!.ms).toBe(1000);
  });

  it('breaks a full tie by device id', () => {
    expect(compareHlc(formatHlc({ ms: 1, counter: 0, device: 'A' }), formatHlc({ ms: 1, counter: 0, device: 'B' }))).toBeLessThan(0);
  });
});
