import { describe, it, expect } from 'vitest';
import { decide, type IncomingChange, type PathState } from './resolve';
import { formatHlc } from './hlc';

const stamp = (ms: number, device: string) => formatHlc({ ms, counter: 0, device });
const local = (value: unknown, ms: number, device: string, seq: number): PathState => ({ value, hlc: stamp(ms, device), device, seq });
const incoming = (path: string, value: unknown, ms: number, seq = 1): IncomingChange =>
  ({ device: 'B', seq, hlc: stamp(ms, 'B'), entityType: 'recipe', entityId: 'r1', path, value });

describe('decide', () => {
  it('applies a change to a path it has never seen', () => {
    expect(decide(undefined, incoming('title', 'Pane', 10), {})).toEqual({ action: 'apply', concurrent: false });
  });

  it('applies a newer change made with the local value in view', () => {
    expect(decide(local('Pane', 5, 'A', 3), incoming('title', 'Pagnotta', 10), { A: 3 })).toEqual({ action: 'apply', concurrent: false });
  });

  it('flags a newer change made without seeing the local one', () => {
    expect(decide(local('Pane', 5, 'A', 3), incoming('title', 'Pagnotta', 10), { A: 2 })).toEqual({ action: 'apply', concurrent: true });
  });

  it('keeps a newer local value, flagging it only when concurrent and different', () => {
    expect(decide(local('Pane', 20, 'A', 3), incoming('title', 'Pagnotta', 10), {})).toEqual({ action: 'keep', concurrent: true });
    expect(decide(local('Pane', 20, 'A', 3), incoming('title', 'Pane', 10), {})).toEqual({ action: 'ignore' });
    expect(decide(local('Pane', 20, 'A', 3), incoming('title', 'Pagnotta', 10), { A: 3 })).toEqual({ action: 'ignore' });
  });

  it('ignores a change it already applied', () => {
    const l: PathState = { value: 'Pane', hlc: stamp(10, 'B'), device: 'B', seq: 1 };
    expect(decide(l, incoming('title', 'Pane', 10), {})).toEqual({ action: 'ignore' });
  });

  it('never makes a set member a conflict', () => {
    expect(decide(local(true, 5, 'A', 3), incoming('tags[]"Dolce"', false, 10), {})).toEqual({ action: 'apply', concurrent: false });
  });

  it('does not flag a successive edit by the same device', () => {
    const l: PathState = { value: 'Pane', hlc: stamp(5, 'B'), device: 'B', seq: 1 };
    expect(decide(l, incoming('title', 'Pagnotta', 10, 2), {})).toEqual({ action: 'apply', concurrent: false });
  });
});
