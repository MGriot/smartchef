// The git store's commit logic against real git repositories: each device
// is an isomorphic-git repo on disk, the "server" is a bare repository, and
// fetch/push go through the git command line over the file transport —
// the same non-fast-forward rule a GitHub/GitLab/Gitea server enforces.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitStore, V2_BRANCH, type GitRemoteOps } from './gitStore';

// Each case shells out to git several times; under a loaded full-suite run
// that outlasts the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

let root: string;
let server: string;

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function cliRemote(dir: string): GitRemoteOps {
  return {
    async fetch() {
      try {
        run(dir, 'fetch', '--quiet', server, `+refs/heads/${V2_BRANCH}:refs/remotes/origin/${V2_BRANCH}`);
        return run(dir, 'rev-parse', `refs/remotes/origin/${V2_BRANCH}`);
      } catch {
        return null; // no branch on the server yet
      }
    },
    async push() {
      try {
        run(dir, 'push', '--quiet', server, `refs/heads/${V2_BRANCH}:refs/heads/${V2_BRANCH}`);
        return 'ok';
      } catch {
        return 'rejected';
      }
    },
  };
}

function device(name: string) {
  const dir = nodePath.join(root, name);
  fs.mkdirSync(dir);
  return createGitStore({ fs, dir, remote: cliRemote(dir), message: `sync from ${name}` });
}

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const serverFiles = () => run(server, 'ls-tree', '-r', '--name-only', V2_BRANCH).split('\n').filter(Boolean).sort();

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sc-gitstore-'));
  server = nodePath.join(root, 'server.git');
  run(root, 'init', '--quiet', '--bare', server);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('git store', () => {
  it('creates the branch on first push and serves its files to another device', async () => {
    const a = device('A');
    await a.begin();
    expect(await a.list('devices')).toEqual([]);
    await a.put('format.json', text('{"v":1}'));
    await a.put('devices/A/head.json', text('{"seq":3}'));
    await a.put('devices/A/log/1-3.json.gz', text('log'));
    // Reads see what this cycle queued.
    expect(await a.list('devices/A')).toEqual(['head.json', 'log']);
    await a.finish();
    expect(serverFiles()).toEqual(['devices/A/head.json', 'devices/A/log/1-3.json.gz', 'format.json']);

    const b = device('B');
    await b.begin();
    expect(await b.list('devices')).toEqual(['A']);
    expect(read(await b.get('devices/A/head.json'))).toBe('{"seq":3}');
    expect(await b.get('devices/A/missing.json')).toBeNull();
  });

  it('when another device pushed first, re-commits on top of it instead of merging or losing either', async () => {
    const a = device('A');
    const b = device('B');
    await a.begin();
    await a.put('format.json', text('{"v":1}'));
    await a.finish();

    // Both read the same tip, then both write.
    await a.begin();
    await b.begin();
    await a.put('devices/A/head.json', text('{"seq":1}'));
    await b.put('devices/B/head.json', text('{"seq":7}'));
    await a.finish();
    await b.finish(); // rejected once, then rebuilt on A's commit

    expect(serverFiles()).toEqual(['devices/A/head.json', 'devices/B/head.json', 'format.json']);
    // History is linear: B's commit sits on A's.
    expect(run(server, 'log', '--format=%s', V2_BRANCH).split('\n')).toEqual(['sync from B', 'sync from A', 'sync from A']);
  });

  it('a device rewriting its own head replaces only that file', async () => {
    const a = device('A');
    await a.begin();
    await a.put('devices/A/head.json', text('{"seq":1}'));
    await a.put('blobs/abc.webp', text('img'));
    await a.finish();
    await a.begin();
    await a.put('devices/A/head.json', text('{"seq":2}'));
    await a.finish();
    const b = device('B');
    await b.begin();
    expect(read(await b.get('devices/A/head.json'))).toBe('{"seq":2}');
    expect(read(await b.get('blobs/abc.webp'))).toBe('img');
  });

  it('removes a file, and a folder left empty with it', async () => {
    const a = device('A');
    await a.begin();
    await a.put('devices/A/log/1-2.json.gz', text('old'));
    await a.put('devices/A/head.json', text('{}'));
    await a.put('snapshots/s1.meta.json', text('{}'));
    await a.finish();
    await a.begin();
    await a.remove!('devices/A/log/1-2.json.gz');
    await a.remove!('snapshots/s1.meta.json');
    expect(await a.get('devices/A/log/1-2.json.gz')).toBeNull();
    await a.finish();
    expect(serverFiles()).toEqual(['devices/A/head.json']);
  });

  it('a cycle with nothing to write makes no commit', async () => {
    const a = device('A');
    await a.begin();
    await a.put('format.json', text('{}'));
    await a.finish();
    await a.begin();
    await a.finish();
    expect(run(server, 'rev-list', '--count', V2_BRANCH)).toBe('1');
  });
});
