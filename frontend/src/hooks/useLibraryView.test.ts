// The hook is the only place a Library screen's view preferences live, and
// every read and write is guarded because localStorage throws outright in a
// private window rather than returning null. No jsdom in this suite, so the
// storage is stubbed and the hook's helpers are exercised through it.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

let store: Record<string, string>;
let throwing = false;

beforeEach(() => {
  store = {};
  throwing = false;
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (throwing) throw new Error('blocked'); return store[k] ?? null; },
    setItem: (k: string, v: string) => { if (throwing) throw new Error('blocked'); store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});

// The stub is a global: left in place it would follow this worker into
// whatever file runs next.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('react');
});

/** Runs the hook's initialisers the way React would, without a renderer:
 *  useState reduced to "call the initialiser once", useEffect to a no-op. */
async function initialState(section = 'ingredients') {
  vi.doMock('react', async (orig) => {
    const react = await orig<typeof import('react')>();
    return {
      ...react,
      useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
      useEffect: () => {},
    };
  });
  vi.resetModules();
  const { useLibraryView } = await import('./useLibraryView');
  return { result: useLibraryView(section as never) };
}

describe('useLibraryView', () => {
  it('groups by category until told otherwise', async () => {
    const { result } = await initialState();
    expect(result.grouped).toBe(true);
  });

  it('remembers the flat list', async () => {
    store['smartchef.library.ingredients.grouped'] = 'flat';
    const { result } = await initialState();
    expect(result.grouped).toBe(false);
  });

  it('keeps each section separate', async () => {
    store['smartchef.library.ingredients.grouped'] = 'flat';
    const { result } = await initialState('tools');
    expect(result.grouped).toBe(true);
  });

  it('falls back to grouped when storage is blocked', async () => {
    throwing = true;
    const { result } = await initialState();
    expect(result.grouped).toBe(true);
    expect(result.view).toBe('grid');
  });
});
