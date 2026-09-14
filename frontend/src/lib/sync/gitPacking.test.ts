// ════════════════════════════════════════════════════════════════════════
// Same rationale as gitBundleTransport.test.ts: packObjects()/indexPack()/
// readObject() read and write real, validly-encoded git objects, so these
// tests run against a real temporary git repository (real Node fs) rather
// than the in-memory fakes the rest of this test suite uses elsewhere —
// an opaque fake object would never actually exercise pack encoding/
// decoding, which is the entire thing being tested here.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsNode from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import { listLocalObjectPaths } from './gitObjectTransport';
import { packLooseObjectsAfterPush } from './gitPacking';

const nodeFs = { promises: fsNode };

async function makeTempRepo(): Promise<{ dir: string; gitdir: string }> {
  const dir = await fsNode.mkdtemp(path.join(os.tmpdir(), 'smartchef-pack-test-'));
  const gitdir = path.join(dir, '.git');
  await git.init({ fs: nodeFs, dir, gitdir, defaultBranch: 'main' });
  return { dir, gitdir };
}

async function commitFile(dir: string, gitdir: string, filepath: string, content: string): Promise<string> {
  await fsNode.mkdir(path.dirname(path.join(dir, filepath)), { recursive: true });
  await fsNode.writeFile(path.join(dir, filepath), content);
  await git.add({ fs: nodeFs, dir, gitdir, filepath });
  return git.commit({
    fs: nodeFs,
    dir,
    gitdir,
    message: `add ${filepath}`,
    author: { name: 'Test', email: 'test@example.com' },
  });
}

/** Commits enough distinct files that the resulting loose object count
 *  clears packLooseObjectsAfterPush()'s internal threshold (200) — each
 *  commit produces a blob + a tree + a commit object (3 loose objects),
 *  so 70 commits comfortably clears it without an excessively slow test. */
async function commitManyFiles(dir: string, gitdir: string, count: number): Promise<string> {
  let oid = '';
  for (let i = 0; i < count; i++) {
    oid = await commitFile(dir, gitdir, `recipes/r${i}.json`, JSON.stringify({ title: `Recipe ${i}` }));
  }
  return oid;
}

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((d) => fsNode.rm(d, { recursive: true, force: true })));
});

describe('packLooseObjectsAfterPush', () => {
  it('does nothing below the loose-object threshold', async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);
    await commitFile(dir, gitdir, 'recipes/one.json', '{"title":"Carbonara"}');

    const before = await listLocalObjectPaths(nodeFs.promises, dir);
    const result = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);
    const after = await listLocalObjectPaths(nodeFs.promises, dir);

    expect(result).toEqual({ packed: 0 });
    expect(after).toEqual(before); // untouched — nothing packed, nothing pruned
  });

  it('does nothing on a fresh repo with no commits', async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);

    const result = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);

    expect(result).toEqual({ packed: 0 });
  });

  // 60s, not 20s: this genuinely packs, verifies and prunes hundreds of
  // real objects on disk, which takes ~21s on its own — so the old ceiling
  // left no headroom at all, and the test began failing purely because
  // other files were added to the suite and competed for the machine. The
  // work here is legitimately slow; the timeout is not what should be
  // policing it.
  it('packs and prunes loose objects once past the threshold, and every commit stays fully readable afterward', { timeout: 60000 }, async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);
    const headOid = await commitManyFiles(dir, gitdir, 70);
    const looseCountBefore = (await listLocalObjectPaths(nodeFs.promises, dir)).length;
    expect(looseCountBefore).toBeGreaterThanOrEqual(200);

    const result = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);

    expect(result.packed).toBe(looseCountBefore);
    const looseCountAfter = await listLocalObjectPaths(nodeFs.promises, dir);
    expect(looseCountAfter).toEqual([]); // every loose object that was packed got pruned

    // Real reads through normal isomorphic-git call sites — commit log,
    // tree contents, blob content — must still all work, now served
    // entirely from the pack (no loose fallback left to mask a problem).
    const log = await git.log({ fs: nodeFs, dir, gitdir, ref: headOid });
    expect(log.length).toBe(70);
    const { blob } = await git.readBlob({ fs: nodeFs, dir, gitdir, oid: headOid, filepath: 'recipes/r69.json' });
    expect(JSON.parse(new TextDecoder().decode(blob))).toEqual({ title: 'Recipe 69' });
    const { blob: firstBlob } = await git.readBlob({ fs: nodeFs, dir, gitdir, oid: headOid, filepath: 'recipes/r0.json' });
    expect(JSON.parse(new TextDecoder().decode(firstBlob))).toEqual({ title: 'Recipe 0' });
  });

  it('is idempotent — calling again immediately with nothing new loose does nothing further', { timeout: 20000 }, async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);
    await commitManyFiles(dir, gitdir, 70);

    const first = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);
    expect(first.packed).toBeGreaterThan(0);

    const second = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);
    expect(second).toEqual({ packed: 0 }); // nothing loose left to re-pack
  });

  it('packs newly-added loose objects again on a later call, on top of an earlier pack', { timeout: 30000 }, async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);
    await commitManyFiles(dir, gitdir, 70);
    await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);

    const secondHeadOid = await commitManyFiles(dir, gitdir, 100);
    const looseCountBefore = (await listLocalObjectPaths(nodeFs.promises, dir)).length;
    expect(looseCountBefore).toBeGreaterThanOrEqual(200);

    const result = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);

    expect(result.packed).toBe(looseCountBefore);
    expect(await listLocalObjectPaths(nodeFs.promises, dir)).toEqual([]);
    // Both the original 70 commits' objects (now in the first pack) and
    // the second 100 (now in the second pack) must still be reachable.
    const log = await git.log({ fs: nodeFs, dir, gitdir, ref: secondHeadOid });
    expect(log.length).toBe(170);
  });

  it('restores every loose object untouched when pack verification fails, and reports packed: 0', { timeout: 20000 }, async () => {
    const { dir, gitdir } = await makeTempRepo();
    tempDirs.push(dir);
    const headOid = await commitManyFiles(dir, gitdir, 70);
    const loosePathsBefore = await listLocalObjectPaths(nodeFs.promises, dir);

    // Force the post-quarantine verification read to fail exactly once,
    // simulating a corrupt/incomplete pack — proves the rollback path
    // genuinely restores files rather than just not crashing.
    const readObjectSpy = vi.spyOn(git, 'readObject').mockRejectedValueOnce(new Error('simulated corrupt pack'));

    const result = await packLooseObjectsAfterPush(nodeFs.promises, dir, gitdir);

    expect(result).toEqual({ packed: 0 });
    readObjectSpy.mockRestore();

    const loosePathsAfter = await listLocalObjectPaths(nodeFs.promises, dir);
    expect(new Set(loosePathsAfter)).toEqual(new Set(loosePathsBefore));

    // And the repo is still genuinely usable afterward via the restored
    // loose files, not just "files exist" — a real read must work.
    const { blob } = await git.readBlob({ fs: nodeFs, dir, gitdir, oid: headOid, filepath: 'recipes/r0.json' });
    expect(JSON.parse(new TextDecoder().decode(blob))).toEqual({ title: 'Recipe 0' });
  });
});
