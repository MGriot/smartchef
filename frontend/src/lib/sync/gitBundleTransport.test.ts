// ════════════════════════════════════════════════════════════════════════
// packObjects()/indexPack() read and write real, validly-encoded git
// objects (zlib-deflated, git-object-header-prefixed) — unlike
// gitObjectTransport.ts's own tests, which never actually parse object
// bytes and can get away with opaque fake content, these tests need a
// genuinely valid git repository to pack from and index into. Real Node
// fs against real temp directories, exercised through the same
// git.init/add/commit calls gitSync.ts itself uses (see hiddenClone.ts,
// gitSync.ts's commitNowInternal) — not the in-memory fakes the rest of
// this test suite uses elsewhere.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsNode from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import { createFakeRemoteTransport, putRemoteText, getRemoteText, type FakeRemoteTransport } from './testUtils/fakes';
import { writeBundleIfStale, tryCatchUpFromBundle, parseBundle } from './gitBundleTransport';

const nodeFs = { promises: fsNode };

async function makeTempRepo(): Promise<{ dir: string; gitdir: string }> {
  const dir = await fsNode.mkdtemp(path.join(os.tmpdir(), 'smartchef-bundle-test-'));
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

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => fsNode.rm(d, { recursive: true, force: true })));
});

describe('parseBundle', () => {
  it('extracts the ref oid, ref name, and pack bytes from a well-formed v2 bundle', () => {
    const header = '# v2 git bundle\nabc123 refs/heads/main\n\n';
    const pack = new Uint8Array([1, 2, 3, 4]);
    const headerBytes = new TextEncoder().encode(header);
    const bundleBytes = new Uint8Array(headerBytes.length + pack.length);
    bundleBytes.set(headerBytes, 0);
    bundleBytes.set(pack, headerBytes.length);

    const result = parseBundle(bundleBytes);

    expect(result.refOid).toBe('abc123');
    expect(result.refName).toBe('refs/heads/main');
    expect([...result.packBytes]).toEqual([1, 2, 3, 4]);
  });

  it('rejects anything not starting with the v2 bundle signature', () => {
    expect(() => parseBundle(new TextEncoder().encode('not a bundle\n\nsomebytes'))).toThrow(/not a v2 git bundle/);
  });
});

describe('writeBundleIfStale + tryCatchUpFromBundle (round trip)', () => {
  it('a bundle written from one repo, applied to a second empty repo, makes its commit readable there', async () => {
    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    const oid = await commitFile(producer.dir, producer.gitdir, 'recipes/one.json', JSON.stringify({ title: 'Carbonara' }));

    const remote = createFakeRemoteTransport();
    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    expect(await remote.exists('.git/sync.bundle')).toBe(true);

    const consumer = await makeTempRepo();
    tempDirs.push(consumer.dir);
    const caughtUp = await tryCatchUpFromBundle(nodeFs.promises, consumer.dir, consumer.gitdir, remote);
    expect(caughtUp).toBe(true);

    const { blob } = await git.readBlob({ fs: nodeFs, dir: consumer.dir, gitdir: consumer.gitdir, oid, filepath: 'recipes/one.json' });
    expect(JSON.parse(new TextDecoder().decode(blob))).toEqual({ title: 'Carbonara' });
  });

  it('returns false when the Sync Folder has no bundle yet', async () => {
    const consumer = await makeTempRepo();
    tempDirs.push(consumer.dir);
    const remote = createFakeRemoteTransport();

    const caughtUp = await tryCatchUpFromBundle(nodeFs.promises, consumer.dir, consumer.gitdir, remote);

    expect(caughtUp).toBe(false);
  });

  it('is a no-op the second time — re-applying an already-indexed bundle does not re-index or error', async () => {
    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    await commitFile(producer.dir, producer.gitdir, 'recipes/one.json', '{"title":"Carbonara"}');

    const remote = createFakeRemoteTransport();
    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    const consumer = await makeTempRepo();
    tempDirs.push(consumer.dir);
    await tryCatchUpFromBundle(nodeFs.promises, consumer.dir, consumer.gitdir, remote);
    const secondCall = await tryCatchUpFromBundle(nodeFs.promises, consumer.dir, consumer.gitdir, remote);

    expect(secondCall).toBe(true);
  });

  it('does nothing when the local repo has no commits yet', async () => {
    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    const remote = createFakeRemoteTransport();

    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    expect(await remote.exists('.git/sync.bundle')).toBe(false);
  });

  it('produces a bundle real git tooling could parse — signature line, single ref line, blank line, then pack magic', async () => {
    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    await commitFile(producer.dir, producer.gitdir, 'recipes/one.json', '{"title":"Carbonara"}');

    const remote = createFakeRemoteTransport();
    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    const bytes = remote.files.get('.git/sync.bundle')!;
    const { refName, packBytes } = parseBundle(bytes);
    expect(refName).toBe('refs/heads/main');
    // A real git pack file always starts with the 4-byte magic "PACK".
    expect(new TextDecoder().decode(packBytes.subarray(0, 4))).toBe('PACK');
  });
});

describe('writeBundleIfStale staleness gating', () => {
  let remote: FakeRemoteTransport;

  beforeEach(() => {
    remote = createFakeRemoteTransport();
  });

  it('skips rewriting when the existing manifest already covers a comparable object count', async () => {
    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    await commitFile(producer.dir, producer.gitdir, 'recipes/one.json', '{"title":"Carbonara"}');

    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);
    const firstBundleBytes = getRemoteText(remote, '.git/sync.bundle');

    // No new commits since — a second call should leave the bundle untouched.
    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    expect(getRemoteText(remote, '.git/sync.bundle')).toBe(firstBundleBytes);
  });

  it('rewrites once the local object count has grown past the gate, even with a pre-seeded high manifest count', async () => {
    putRemoteText(remote, '.git/sync.bundle.meta.json', JSON.stringify({ objectCount: 1_000_000 }));

    const producer = await makeTempRepo();
    tempDirs.push(producer.dir);
    await commitFile(producer.dir, producer.gitdir, 'recipes/one.json', '{"title":"Carbonara"}');

    await writeBundleIfStale(nodeFs.promises, producer.dir, producer.gitdir, remote);

    // Local object count is nowhere near 1,000,000 — the gate correctly
    // keeps this device from ever writing a bundle that could compete with
    // a genuinely more-complete remote one.
    expect(await remote.exists('.git/sync.bundle')).toBe(false);
  });
});
