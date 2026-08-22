import { describe, it, expect, vi } from 'vitest';
import { storeImage, readImage, hashBytes, isLocalImagePath, type ImageFs } from './localImages';

function createFakeImageFs(): ImageFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async exists(path) {
      return files.has(path);
    },
    async readFile(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: '${path}'`);
      return bytes;
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
  };
}

const bytesA = new TextEncoder().encode('image bytes A');
const bytesB = new TextEncoder().encode('image bytes B');

describe('hashBytes', () => {
  it('is deterministic for the same content', async () => {
    expect(await hashBytes(bytesA)).toBe(await hashBytes(bytesA));
  });

  it('differs for different content', async () => {
    expect(await hashBytes(bytesA)).not.toBe(await hashBytes(bytesB));
  });
});

describe('storeImage', () => {
  it('writes the image under a content-addressed path and returns it', async () => {
    const fs = createFakeImageFs();
    const relPath = await storeImage(bytesA, 'jpg', fs);

    expect(relPath).toMatch(/^images\/[0-9a-f]{64}\.jpg$/);
    expect(await fs.readFile(relPath)).toEqual(bytesA);
  });

  it('storing the same bytes twice reuses the same path (dedup)', async () => {
    const fs = createFakeImageFs();
    const first = await storeImage(bytesA, 'jpg', fs);
    const second = await storeImage(bytesA, 'jpg', fs);

    expect(second).toBe(first);
    expect(fs.files.size).toBe(1);
  });

  it('does not re-write bytes to disk when the content-addressed file already exists (skip-if-present)', async () => {
    const fs = createFakeImageFs();
    await storeImage(bytesA, 'jpg', fs);
    const writeSpy = vi.spyOn(fs, 'writeFile');

    await storeImage(bytesA, 'jpg', fs);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('different bytes get different content-addressed paths', async () => {
    const fs = createFakeImageFs();
    const pathA = await storeImage(bytesA, 'jpg', fs);
    const pathB = await storeImage(bytesB, 'jpg', fs);

    expect(pathA).not.toBe(pathB);
  });

  it('sanitizes an unusual extension hint down to a safe charset', async () => {
    const fs = createFakeImageFs();
    const relPath = await storeImage(bytesA, 'JPEG; charset=binary', fs);
    expect(relPath).toMatch(/^images\/[0-9a-f]{64}\.jpeg$/);
  });

  it('falls back to a default extension when no hint is usable', async () => {
    const fs = createFakeImageFs();
    const relPath = await storeImage(bytesA, '', fs);
    expect(relPath).toMatch(/^images\/[0-9a-f]{64}\.bin$/);
  });
});

describe('readImage', () => {
  it('reads back exactly what was stored', async () => {
    const fs = createFakeImageFs();
    const relPath = await storeImage(bytesA, 'png', fs);
    expect(await readImage(relPath, fs)).toEqual(bytesA);
  });
});

describe('isLocalImagePath', () => {
  it('is true for a storeImage()-shaped relative path', () => {
    expect(isLocalImagePath('images/abcdef1234.jpg')).toBe(true);
  });

  it('is false for an absolute http(s) URL', () => {
    expect(isLocalImagePath('https://example.com/photo.jpg')).toBe(false);
    expect(isLocalImagePath('http://example.com/photo.jpg')).toBe(false);
  });

  it('is false for a root-relative bundled asset path', () => {
    expect(isLocalImagePath('/assets/chef-5-abc123.jpeg')).toBe(false);
  });

  it('is false for null, undefined, or empty string', () => {
    expect(isLocalImagePath(null)).toBe(false);
    expect(isLocalImagePath(undefined)).toBe(false);
    expect(isLocalImagePath('')).toBe(false);
  });
});
