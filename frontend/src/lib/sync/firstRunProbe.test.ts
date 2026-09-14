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
