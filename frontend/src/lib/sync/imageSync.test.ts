// ════════════════════════════════════════════════════════════════════════
// Same rationale as gitPacking.test.ts: materializeImagesFromCommit() reads
// real blobs out of a real commit, so these run against a real temporary git
// repository on real Node fs rather than an in-memory fake — a fake blob
// store would not exercise the listFiles/readBlob path that is the whole
// point of the function.
//
// `gitfs` is this app's per-platform PromiseFsClient (Electron IPC / Android
// Capacitor Filesystem), neither of which exists under vitest — it is mocked
// to plain Node fs, which is the same shape isomorphic-git consumes.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsNode from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from 'isomorphic-git';

vi.mock('../gitfs', () => ({ gitfs: { promises: fsNode } }));

import type { ImageFs } from '../localImages';

const { copyImagesIntoClone, copyImagesOutOfClone, materializeImagesFromCommit } = await import('./imageSync');

const nodeFs = { promises: fsNode };

/** Stand-in for Local Storage's per-platform image store — same fake shape
 *  localImages.test.ts uses, so both files exercise the same contract. */
function createFakeImageFs(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [p, content] of Object.entries(seed)) files.set(p, new TextEncoder().encode(content));
  return {
    files,
    async exists(p: string) { return files.has(p); },
    async readFile(p: string) {
      const bytes = files.get(p);
      if (!bytes) throw new Error(`ENOENT: '${p}'`);
      return bytes;
    },
    async writeFile(p: string, data: Uint8Array) { files.set(p, data); },
    async list() { return [...files.keys()]; },
  };
}

let tempDirs: string[] = [];

async function makeTempClone(): Promise<{ dir: string; gitdir: string }> {
  const dir = await fsNode.mkdtemp(path.join(os.tmpdir(), 'smartchef-imgsync-'));
  tempDirs.push(dir);
  const gitdir = path.join(dir, '.git');
  await git.init({ fs: nodeFs, dir, gitdir, defaultBranch: 'main' });
  await fsNode.mkdir(path.join(dir, 'images'), { recursive: true });
  return { dir, gitdir };
}

beforeEach(() => { tempDirs = []; });
afterEach(async () => {
  for (const dir of tempDirs) await fsNode.rm(dir, { recursive: true, force: true });
});

describe('copyImagesIntoClone', () => {
  it('copies every stored image the clone does not have yet', async () => {
    const { dir } = await makeTempClone();
    const fs = createFakeImageFs({ 'images/aaa.jpg': 'A', 'images/bbb.png': 'B' });

    const result = await copyImagesIntoClone(dir, fs as unknown as ImageFs);

    expect(result).toEqual({ copied: 2, failed: 0 });
    expect(await fsNode.readFile(path.join(dir, 'images/aaa.jpg'), 'utf8')).toBe('A');
    expect(await fsNode.readFile(path.join(dir, 'images/bbb.png'), 'utf8')).toBe('B');
  });

  it('skips images the clone already carries, so repeat cycles are free', async () => {
    const { dir } = await makeTempClone();
    const fs = createFakeImageFs({ 'images/aaa.jpg': 'A' });
    await copyImagesIntoClone(dir, fs as unknown as ImageFs);

    const readSpy = vi.spyOn(fs, 'readFile');
    const second = await copyImagesIntoClone(dir, fs as unknown as ImageFs);

    expect(second).toEqual({ copied: 0, failed: 0 });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('reports a failed file without abandoning the rest', async () => {
    const { dir } = await makeTempClone();
    const fs = createFakeImageFs({ 'images/good.jpg': 'ok', 'images/bad.jpg': 'x' });
    vi.spyOn(fs, 'readFile').mockImplementation(async (p: string) => {
      if (p === 'images/bad.jpg') throw new Error('unreadable');
      return new TextEncoder().encode('ok');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await copyImagesIntoClone(dir, fs as unknown as ImageFs);

    expect(result.copied).toBe(1);
    expect(result.failed).toBe(1);
    expect(await fsNode.readFile(path.join(dir, 'images/good.jpg'), 'utf8')).toBe('ok');
  });

  it('is a no-op when nothing is stored locally', async () => {
    const { dir } = await makeTempClone();
    const result = await copyImagesIntoClone(dir, createFakeImageFs() as unknown as ImageFs);
    expect(result).toEqual({ copied: 0, failed: 0 });
  });
});

describe('copyImagesOutOfClone', () => {
  it('writes images the clone has but Local Storage does not', async () => {
    const { dir } = await makeTempClone();
    await fsNode.writeFile(path.join(dir, 'images/remote.jpg'), 'from another device');
    const fs = createFakeImageFs();

    const result = await copyImagesOutOfClone(dir, fs as unknown as ImageFs);

    expect(result).toEqual({ copied: 1, failed: 0 });
    expect(new TextDecoder().decode(fs.files.get('images/remote.jpg')!)).toBe('from another device');
  });

  it('leaves an image Local Storage already has untouched', async () => {
    const { dir } = await makeTempClone();
    await fsNode.writeFile(path.join(dir, 'images/shared.jpg'), 'clone copy');
    const fs = createFakeImageFs({ 'images/shared.jpg': 'local copy' });

    const result = await copyImagesOutOfClone(dir, fs as unknown as ImageFs);

    expect(result.copied).toBe(0);
    // Content-addressed paths make these identical in practice; the point is
    // that replication never overwrites what is already there.
    expect(new TextDecoder().decode(fs.files.get('images/shared.jpg')!)).toBe('local copy');
  });
});

describe('materializeImagesFromCommit', () => {
  it('extracts images from a commit into both the clone and Local Storage', async () => {
    const { dir, gitdir } = await makeTempClone();
    await fsNode.writeFile(path.join(dir, 'images/committed.jpg'), 'photo bytes');
    await git.add({ fs: nodeFs, dir, gitdir, filepath: 'images' });
    const oid = await git.commit({
      fs: nodeFs, dir, gitdir, message: 'add image',
      author: { name: 'Test', email: 'test@example.com' },
    });

    // Simulate the state after a fetch: the objects are present but the
    // working tree and Local Storage have never seen the file.
    await fsNode.rm(path.join(dir, 'images/committed.jpg'));
    const fs = createFakeImageFs();

    const result = await materializeImagesFromCommit(dir, gitdir, oid, fs as unknown as ImageFs);

    expect(result).toEqual({ copied: 1, failed: 0 });
    expect(new TextDecoder().decode(fs.files.get('images/committed.jpg')!)).toBe('photo bytes');
    expect(await fsNode.readFile(path.join(dir, 'images/committed.jpg'), 'utf8')).toBe('photo bytes');
  });

  it('ignores the entity JSON files in the same commit', async () => {
    const { dir, gitdir } = await makeTempClone();
    await fsNode.mkdir(path.join(dir, 'recipes'), { recursive: true });
    await fsNode.writeFile(path.join(dir, 'recipes/r1.json'), '{"title":"Focaccia"}');
    await fsNode.writeFile(path.join(dir, 'images/cover.webp'), 'cover bytes');
    await git.add({ fs: nodeFs, dir, gitdir, filepath: ['recipes', 'images'] });
    const oid = await git.commit({
      fs: nodeFs, dir, gitdir, message: 'recipe + cover',
      author: { name: 'Test', email: 'test@example.com' },
    });
    const fs = createFakeImageFs();

    await materializeImagesFromCommit(dir, gitdir, oid, fs as unknown as ImageFs);

    expect([...fs.files.keys()]).toEqual(['images/cover.webp']);
  });

  it('does no work when the commit carries no images', async () => {
    const { dir, gitdir } = await makeTempClone();
    await fsNode.mkdir(path.join(dir, 'recipes'), { recursive: true });
    await fsNode.writeFile(path.join(dir, 'recipes/r1.json'), '{}');
    await git.add({ fs: nodeFs, dir, gitdir, filepath: 'recipes' });
    const oid = await git.commit({
      fs: nodeFs, dir, gitdir, message: 'no images',
      author: { name: 'Test', email: 'test@example.com' },
    });

    const result = await materializeImagesFromCommit(dir, gitdir, oid, createFakeImageFs() as unknown as ImageFs);

    expect(result).toEqual({ copied: 0, failed: 0 });
  });
});
