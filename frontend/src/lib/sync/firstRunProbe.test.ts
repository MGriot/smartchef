// ════════════════════════════════════════════════════════════════════════
// First-run setup used to run a complete syncNow() before it could list a
// single profile: the whole history downloaded, then every recipe,
// ingredient, tool, tag and technique merged into SQLite and every image
// written to disk — all to answer "who is using this device?", which needs
// six small JSON files.
//
// These cover the parts of the replacement that can go quietly wrong:
// that it reads the profiles rather than merging anything (the merge path
// is the one that would silently strand the rest of the library — see the
// module header), that it honours deletion markers so a removed person is
// not offered in the picker, that one bad record does not cost the others,
// and that the throwaway clone is always cleaned up, including when the
// clone itself fails.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const shallowCloneTip = vi.fn();
const listFiles = vi.fn();
const readBlob = vi.fn();
const getSyncMode = vi.fn();
const getGitRemoteConfig = vi.fn();
const readdir = vi.fn();
const statMock = vi.fn();
const unlink = vi.fn();
const rmdir = vi.fn();
const listDirectoryFiles = vi.fn();
/** Whatever the probe is currently subscribed with, so a test can drive
 *  native download progress the way GitHttpPlugin.java does. */
let downloadProgressListener: ((loaded: number, total: number, done: boolean) => void) | null = null;

vi.mock('isomorphic-git', () => ({
  listFiles: (...a: unknown[]) => listFiles(...a),
  readBlob: (...a: unknown[]) => readBlob(...a),
}));
vi.mock('../gitfs', () => ({
  gitfs: { promises: {
    readdir: (...a: unknown[]) => readdir(...a),
    stat: (...a: unknown[]) => statMock(...a),
    unlink: (...a: unknown[]) => unlink(...a),
    rmdir: (...a: unknown[]) => rmdir(...a),
  } },
}));
vi.mock('./hiddenClone', () => ({ getHiddenCloneDir: async () => '/sync-clone' }));
vi.mock('./syncSettings', () => ({
  getSyncMode: (...a: unknown[]) => getSyncMode(...a),
  getGitRemoteConfig: (...a: unknown[]) => getGitRemoteConfig(...a),
}));
vi.mock('./gitRemoteTransport', () => ({ shallowCloneTip: (...a: unknown[]) => shallowCloneTip(...a) }));
vi.mock('./hostContentsApi', () => ({ listDirectoryFiles: (...a: unknown[]) => listDirectoryFiles(...a) }));
vi.mock('../gitHttpBridge', () => ({ observeDownloadProgress: (cb: (l: number, t: number, d: boolean) => void) => {
  downloadProgressListener = cb;
  return () => { downloadProgressListener = null; };
} }));

const { probeFirstRunProfiles } = await import('./firstRunProbe');

function blobOf(json: unknown) {
  return { blob: new TextEncoder().encode(JSON.stringify(json)) };
}

beforeEach(() => {
  shallowCloneTip.mockReset().mockResolvedValue('abc123');
  listFiles.mockReset().mockResolvedValue([]);
  readBlob.mockReset();
  getSyncMode.mockReset().mockResolvedValue('git-remote');
  getGitRemoteConfig.mockReset().mockResolvedValue({ url: 'https://example.test/lib.git' });
  readdir.mockReset().mockRejectedValue(new Error('ENOENT'));
  statMock.mockReset().mockResolvedValue(null);
  unlink.mockReset().mockResolvedValue(undefined);
  rmdir.mockReset().mockResolvedValue(undefined);
  // null = "not a host with a contents API", i.e. fall through to the
  // shallow clone. That is the path most of these cases exercise.
  listDirectoryFiles.mockReset().mockResolvedValue(null);
  downloadProgressListener = null;
});

describe('sync modes without a fast path', () => {
  it('reports folder mode as unsupported rather than guessing', async () => {
    getSyncMode.mockResolvedValue('folder');

    const result = await probeFirstRunProfiles();

    // The caller falls back to a full sync on `supported: false`. Returning
    // an empty profile list with supported:true would instead present a
    // populated library as empty and invite a duplicate profile.
    expect(result).toEqual({ supported: false, profiles: [] });
    expect(shallowCloneTip).not.toHaveBeenCalled();
  });

  it('reports unsupported when no git remote is configured', async () => {
    getGitRemoteConfig.mockResolvedValue(null);

    expect(await probeFirstRunProfiles()).toEqual({ supported: false, profiles: [] });
    expect(shallowCloneTip).not.toHaveBeenCalled();
  });
});

describe('reading profiles out of the fetched tip', () => {
  it('returns every profile, sorted by name, without merging anything', async () => {
    listFiles.mockResolvedValue([
      'profiles/p2.json',
      'profiles/p1.json',
      'recipes/r1.json',
      'ingredients/i1.json',
    ]);
    readBlob.mockImplementation(({ filepath }: { filepath: string }) =>
      Promise.resolve(blobOf(filepath.includes('p1')
        ? { name: 'Zoe', avatar_url: 'images/z.jpg', role: 'admin' }
        : { name: 'Ana', role: 'user' })));

    const result = await probeFirstRunProfiles();

    expect(result.supported).toBe(true);
    expect(result.profiles).toEqual([
      { id: 'p2', name: 'Ana', avatarUrl: undefined, role: 'user' },
      { id: 'p1', name: 'Zoe', avatarUrl: 'images/z.jpg', role: 'admin' },
    ]);
    // The whole point: only profile blobs are read. Reading recipes here
    // would be the cost this exists to skip.
    const read = readBlob.mock.calls.map((c) => (c[0] as { filepath: string }).filepath);
    expect(read).toEqual(['profiles/p2.json', 'profiles/p1.json']);
  });

  it('leaves out a profile that was deleted on another device', async () => {
    listFiles.mockResolvedValue(['profiles/gone.json', 'profiles/here.json']);
    readBlob.mockImplementation(({ filepath }: { filepath: string }) =>
      Promise.resolve(blobOf(filepath.includes('gone')
        ? { name: 'Removed', deleted_at: '2026-01-01T00:00:00Z' }
        : { name: 'Present' })));

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Present']);
  });

  it('skips a record with no name rather than showing a blank picker row', async () => {
    listFiles.mockResolvedValue(['profiles/bad.json', 'profiles/ok.json']);
    readBlob.mockImplementation(({ filepath }: { filepath: string }) =>
      Promise.resolve(blobOf(filepath.includes('bad') ? { role: 'user' } : { name: 'Real' })));

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Real']);
  });

  it('does not let one unreadable profile cost the others', async () => {
    listFiles.mockResolvedValue(['profiles/broken.json', 'profiles/fine.json']);
    readBlob.mockImplementation(({ filepath }: { filepath: string }) =>
      filepath.includes('broken')
        ? Promise.reject(new Error('missing object'))
        : Promise.resolve(blobOf({ name: 'Fine' })));

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Fine']);
  });

  it('treats a remote with no commits as an empty library, not a failure', async () => {
    shallowCloneTip.mockResolvedValue(null);

    const result = await probeFirstRunProfiles();

    expect(result).toEqual({ supported: true, profiles: [] });
  });
});

describe('the throwaway clone', () => {
  it('is removed after a successful probe', async () => {
    listFiles.mockResolvedValue([]);
    // One entry so the recursive walk actually has something to do.
    readdir.mockImplementation((path: string) =>
      path === '/sync-clone-probe' ? Promise.resolve(['config']) : Promise.reject(new Error('ENOENT')));
    statMock.mockResolvedValue({ isDirectory: () => false });

    await probeFirstRunProfiles();

    expect(unlink).toHaveBeenCalledWith('/sync-clone-probe/config');
    expect(rmdir).toHaveBeenCalledWith('/sync-clone-probe');
  });

  it('is removed even when the clone itself fails', async () => {
    // A clone that throws partway has still created the directory and
    // written some of the pack, so the cleanup walk finds real entries —
    // mocking readdir as ENOENT here would pass for the wrong reason.
    shallowCloneTip.mockRejectedValue(new Error('auth failed'));
    readdir.mockImplementation((path: string) =>
      path === '/sync-clone-probe' ? Promise.resolve(['.git']) : Promise.resolve([]));
    statMock.mockResolvedValue({ isDirectory: () => false });

    await expect(probeFirstRunProfiles()).rejects.toThrow('auth failed');

    // Half a clone left behind would make the next attempt fail on a
    // non-empty directory, turning one bad token into a permanent block.
    expect(unlink).toHaveBeenCalledWith('/sync-clone-probe/.git');
    expect(rmdir).toHaveBeenCalledWith('/sync-clone-probe');
  });

  it('clears a leftover probe before cloning, not after', async () => {
    const order: string[] = [];
    rmdir.mockImplementation((p: string) => { order.push(`rmdir:${p}`); return Promise.resolve(); });
    shallowCloneTip.mockImplementation(() => { order.push('clone'); return Promise.resolve('abc123'); });
    readdir.mockResolvedValueOnce([]).mockRejectedValue(new Error('ENOENT'));
    listFiles.mockResolvedValue([]);

    await probeFirstRunProfiles();

    expect(order[0]).toBe('rmdir:/sync-clone-probe');
    expect(order).toContain('clone');
  });
});

// ── Saying what it is doing ─────────────────────────────────────────────
// The slow case was reported as "maybe it is blocked", which it was not —
// there was simply nothing on screen to distinguish a working download from
// a wedged one. These pin the two things that make that answerable: phases
// reaching the caller, and a bound on how long it can sit there at all.
describe('progress reporting', () => {
  it('reports bytes from the native download, then unpacking, then reading', async () => {
    // Progress deliberately comes from the transport rather than from
    // isomorphic-git: its own onProgress parses sideband messages while
    // reading the body, and this app's body is already fully downloaded by
    // then, so it could only ever fire after the wait was over.
    // Modelled on GitHub's real upload-pack response: chunked, so total is
    // 0 throughout. The first version switched to "unpacking" on
    // `loaded >= total`, which never became true — the screen sat on
    // "Downloading… 2.1 MB" through everything after the last byte.
    shallowCloneTip.mockImplementation(async () => {
      downloadProgressListener?.(900_000, 0, false);
      downloadProgressListener?.(2_208_754, 0, true); // native side says the body is complete
      return 'abc123';
    });
    listFiles.mockResolvedValue(['profiles/p1.json']);
    readBlob.mockResolvedValue(blobOf({ name: 'Ana' }));

    const phases: unknown[] = [];
    await probeFirstRunProfiles((p) => phases.push(p));

    expect(phases).toEqual([
      { kind: 'connecting' },
      { kind: 'downloading', loaded: 900_000, total: 0 },
      { kind: 'preparing' },
      { kind: 'reading' },
    ]);
  });

  it('unsubscribes from download progress once the clone is done', async () => {
    listFiles.mockResolvedValue([]);

    await probeFirstRunProfiles();

    // Left subscribed, a later download would keep driving a screen that
    // has moved on.
    expect(downloadProgressListener).toBeNull();
  });

  it('works without a callback, since the probe has other callers', async () => {
    listFiles.mockResolvedValue([]);
    await expect(probeFirstRunProfiles()).resolves.toEqual({ supported: true, profiles: [] });
  });
});

describe('the overall deadline', () => {
  it('rejects rather than spinning forever when the clone never settles', async () => {
    vi.useFakeTimers();
    try {
      shallowCloneTip.mockReturnValue(new Promise(() => {})); // never settles
      const pending = probeFirstRunProfiles();
      const assertion = expect(pending).rejects.toThrow(/Timed out after 120s/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its timer on success, so a finished probe holds nothing open', async () => {
    vi.useFakeTimers();
    try {
      listFiles.mockResolvedValue([]);
      await probeFirstRunProfiles();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The host contents API fast path ────────────────────────────────────
// A depth-1 clone is the cheapest thing git will do, not the cheapest
// thing available: GitHub and GitLab hand over a directory for 5.6 KB with
// no packfile, against 2.1 MB and indexing ~500 objects in JS. These pin
// that it is preferred, that it is never fatal, and that an unrecognised
// host still works the old way.
describe('the host contents API fast path', () => {
  it('is used when available, and skips the clone entirely', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/b.json', text: JSON.stringify({ name: 'Bea', role: 'admin' }) },
      { path: 'profiles/a.json', text: JSON.stringify({ name: 'Ana' }) },
    ], tokenRejected: false });

    const { profiles, supported } = await probeFirstRunProfiles();

    expect(supported).toBe(true);
    expect(profiles.map((p) => p.name)).toEqual(['Ana', 'Bea']);
    expect(shallowCloneTip).not.toHaveBeenCalled();
  });

  it('applies the same deletion and no-name rules as the clone path', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/gone.json', text: JSON.stringify({ name: 'Removed', deleted_at: '2026-01-01T00:00:00Z' }) },
      { path: 'profiles/blank.json', text: JSON.stringify({ role: 'user' }) },
      { path: 'profiles/ok.json', text: JSON.stringify({ name: 'Real' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Real']);
  });

  it('does not let one malformed file cost the others', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/bad.json', text: 'not json at all' },
      { path: 'profiles/good.json', text: JSON.stringify({ name: 'Fine' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Fine']);
  });

  it('falls back to the clone when the API fails, rather than giving up', async () => {
    // Rate limiting, a token missing a scope, an endpoint that moved —
    // none of which should cost someone their setup when git still works.
    listDirectoryFiles.mockRejectedValue(new Error('403 rate limited'));
    listFiles.mockResolvedValue(['profiles/p1.json']);
    readBlob.mockResolvedValue(blobOf({ name: 'FromClone' }));

    const { profiles } = await probeFirstRunProfiles();

    expect(shallowCloneTip).toHaveBeenCalled();
    expect(profiles.map((p) => p.name)).toEqual(['FromClone']);
  });

  it('treats an empty profiles directory as an empty library, not a failure', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [], tokenRejected: false });

    expect(await probeFirstRunProfiles()).toEqual({ supported: true, profiles: [], tokenRejected: false });
    expect(shallowCloneTip).not.toHaveBeenCalled();
  });
});

// ── Who is the admin ────────────────────────────────────────────────────
// `role` is a later addition, so a profile whose entity file was written
// before it exists carries no role at all — which is the case for the one
// live profile in the real library this was built against. Without a
// fallback the picker shows the owner as an ordinary user, and they are
// imported as one; initLocalSchema() then promotes them on the NEXT launch,
// so the admin-only screens are missing exactly once, on the run where
// someone is most likely to go looking for them.
describe('resolving the admin flag', () => {
  it('marks the earliest-created profile admin when none says it is', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/newer.json', text: JSON.stringify({ name: 'Bea', created_at: '2026-03-01 10:00:00' }) },
      { path: 'profiles/older.json', text: JSON.stringify({ name: 'Ana', created_at: '2026-01-01 10:00:00' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.find((p) => p.name === 'Ana')?.role).toBe('admin');
    expect(profiles.find((p) => p.name === 'Bea')?.role).toBeUndefined();
  });

  it('leaves an explicit admin alone and promotes nobody else', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/a.json', text: JSON.stringify({ name: 'Ana', created_at: '2026-01-01 10:00:00', role: 'user' }) },
      { path: 'profiles/b.json', text: JSON.stringify({ name: 'Bea', created_at: '2026-03-01 10:00:00', role: 'admin' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.find((p) => p.name === 'Bea')?.role).toBe('admin');
    // Ana is older but explicitly a user — the fallback must not override
    // a library that has already decided.
    expect(profiles.find((p) => p.name === 'Ana')?.role).toBe('user');
  });

  it('sorts records with no created_at last rather than treating them as first', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/undated.json', text: JSON.stringify({ name: 'Undated' }) },
      { path: 'profiles/dated.json', text: JSON.stringify({ name: 'Dated', created_at: '2026-05-01 10:00:00' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    // A real timestamp is better evidence of "first" than the absence of one.
    expect(profiles.find((p) => p.name === 'Dated')?.role).toBe('admin');
  });

  it('applies on the clone path too, not only the API fast path', async () => {
    listDirectoryFiles.mockResolvedValue(null); // unrecognised host → clone
    listFiles.mockResolvedValue(['profiles/p1.json']);
    readBlob.mockResolvedValue(blobOf({ name: 'Solo', created_at: '2026-01-01 10:00:00' }));

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles[0].role).toBe('admin');
  });

  it('carries the avatar through unchanged, whatever shape it is', async () => {
    // Two real shapes in this library: a bundled asset path and, on older
    // records, an inline data URI. Neither is resolved here — the picker
    // renders both through ResolvedImage.
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/a.json', text: JSON.stringify({ name: 'Asset', avatar_url: '/assets/chef-5-C7tcP2r_.jpeg' }) },
      { path: 'profiles/b.json', text: JSON.stringify({ name: 'Inline', avatar_url: 'data:image/svg+xml,%3csvg%3e' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.find((p) => p.name === 'Asset')?.avatarUrl).toBe('/assets/chef-5-C7tcP2r_.jpeg');
    expect(profiles.find((p) => p.name === 'Inline')?.avatarUrl).toBe('data:image/svg+xml,%3csvg%3e');
  });

  it('does not offer a profile that was deleted, even if it was the admin', async () => {
    // The tombstoned duplicates in the real library are exactly this shape.
    listDirectoryFiles.mockResolvedValue({ files: [
      { path: 'profiles/dead.json', text: JSON.stringify({ name: 'Old', role: 'admin', deleted_at: '2026-09-06 19:35:44' }) },
      { path: 'profiles/live.json', text: JSON.stringify({ name: 'Current', created_at: '2026-01-01 10:00:00' }) },
    ], tokenRejected: false });

    const { profiles } = await probeFirstRunProfiles();

    expect(profiles.map((p) => p.name)).toEqual(['Current']);
    // …and with the only admin gone, the survivor becomes one rather than
    // leaving the library with no admin at all.
    expect(profiles[0].role).toBe('admin');
  });
});

describe('a rejected token', () => {
  it('is passed through to the caller so the setup screen can say so', async () => {
    listDirectoryFiles.mockResolvedValue({ files: [{ path: 'profiles/a.json', text: JSON.stringify({ name: 'Ana' }) }], tokenRejected: true });

    const result = await probeFirstRunProfiles();

    expect(result.tokenRejected).toBe(true);
    // …and onboarding still gets its profiles, on the fast path.
    expect(result.profiles.map((p) => p.name)).toEqual(['Ana']);
    expect(shallowCloneTip).not.toHaveBeenCalled();
  });
});
