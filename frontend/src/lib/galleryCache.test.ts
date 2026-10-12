import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { galleryKey, readGallery, writeGallery, resetGalleryCache } from './galleryCache';

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  });
  resetGalleryCache();
});

afterEach(() => vi.unstubAllGlobals());

const plain = { lang: 'en', sort: 'newest' };

describe('galleryKey', () => {
  it('does not depend on the order filters were picked in', () => {
    expect(galleryKey({ ...plain, tags: ['b', 'a'] })).toBe(galleryKey({ ...plain, tags: ['a', 'b'] }));
  });

  it('tells different queries apart', () => {
    const keys = new Set([
      galleryKey(plain),
      galleryKey({ ...plain, q: 'pasta' }),
      galleryKey({ ...plain, tags: ['a'] }),
      galleryKey({ ...plain, regions: ['a'] }),
      galleryKey({ ...plain, seasonalOnly: true }),
      galleryKey({ ...plain, sort: 'oldest' }),
      galleryKey({ ...plain, lang: 'it' }),
    ]);
    expect(keys.size).toBe(7);
  });

  it('ignores whitespace around the search text', () => {
    expect(galleryKey({ ...plain, q: ' pasta ' })).toBe(galleryKey({ ...plain, q: 'pasta' }));
  });
});

describe('readGallery / writeGallery', () => {
  it('misses before anything was written', () => {
    expect(readGallery(plain)).toBeNull();
  });

  it('returns what the same query wrote, not another query\'s list', () => {
    writeGallery(plain, [{ id: '1' }]);
    expect(readGallery(plain)).toEqual([{ id: '1' }]);
    expect(readGallery({ ...plain, sort: 'oldest' })).toBeNull();
  });

  it('keeps the unfiltered list across a restart, but not a filtered one', () => {
    writeGallery(plain, [{ id: '1' }]);
    writeGallery({ ...plain, q: 'pasta' }, [{ id: '2' }]);
    resetGalleryCache(); // new app start: memory empty, disk kept
    expect(readGallery(plain)).toEqual([{ id: '1' }]);
    expect(readGallery({ ...plain, q: 'pasta' })).toBeNull();
    expect(readGallery({ ...plain, sort: 'oldest' })).toBeNull();
  });

  it('survives a blocked or full localStorage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } });
    expect(readGallery(plain)).toBeNull();
    expect(() => writeGallery(plain, [{ id: '1' }])).not.toThrow();
    expect(readGallery(plain)).toEqual([{ id: '1' }]); // still held in memory
  });

  it('caps the memory kept per session', () => {
    for (let i = 0; i < 30; i++) writeGallery({ ...plain, q: `q${i}` }, [{ id: String(i) }]);
    expect(readGallery({ ...plain, q: 'q0' })).toBeNull();
    expect(readGallery({ ...plain, q: 'q29' })).toEqual([{ id: '29' }]);
  });
});
