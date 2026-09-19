import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real isomorphic-git fetch()/push()/getRemoteInfo() make actual network
// calls — mocked here (same pattern mergeBridge.test.ts uses) so these
// tests verify this module's OWN wiring (which params get passed, how
// results/errors get mapped) without needing a live git server. What
// isomorphic-git itself does with those params is its own, already-tested
// concern, not this module's.
vi.mock('../gitfs', () => ({ gitfs: {} }));

const fetchMock = vi.fn();
const pushMock = vi.fn();
const resolveRefMock = vi.fn();
const getRemoteInfoMock = vi.fn();
const addRemoteMock = vi.fn();

vi.mock('isomorphic-git', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  push: (...args: unknown[]) => pushMock(...args),
  resolveRef: (...args: unknown[]) => resolveRefMock(...args),
  getRemoteInfo: (...args: unknown[]) => getRemoteInfoMock(...args),
  addRemote: (...args: unknown[]) => addRemoteMock(...args),
}));

import { fetchGitRemote, pushGitRemote, gitBasicCredentials } from './gitRemoteTransport';
import type { GitRemoteConfig } from './syncSettings';

beforeEach(() => {
  fetchMock.mockReset();
  pushMock.mockReset();
  resolveRefMock.mockReset();
  getRemoteInfoMock.mockReset();
  addRemoteMock.mockReset();
  addRemoteMock.mockResolvedValue(undefined);
});

const baseConfig: GitRemoteConfig = { url: 'https://github.com/me/recipes.git', username: null, token: null, corsProxy: null };

describe('fetchGitRemote', () => {
  it('fetches into the shared "sync-folder" remote/tracking-ref name, single branch, no tags', async () => {
    fetchMock.mockResolvedValue({ fetchHead: 'abc123' });

    await fetchGitRemote('/dir', '/dir/.git', baseConfig);

    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      dir: '/dir',
      gitdir: '/dir/.git',
      url: baseConfig.url,
      remote: 'sync-folder',
      ref: 'main',
      remoteRef: 'main',
      singleBranch: true,
      tags: false,
    }));
  });

  it('reports fetched:true with the remote oid when the remote has commits', async () => {
    fetchMock.mockResolvedValue({ fetchHead: 'abc123' });

    const result = await fetchGitRemote('/dir', '/dir/.git', baseConfig);

    expect(result).toEqual({ fetched: true, remoteOid: 'abc123' });
  });

  it('reports fetched:false for a brand-new empty remote (fetchHead null) — not an error', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });

    const result = await fetchGitRemote('/dir', '/dir/.git', baseConfig);

    expect(result).toEqual({ fetched: false, remoteOid: null });
  });

  it('passes no onAuth when no token is configured', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });

    await fetchGitRemote('/dir', '/dir/.git', baseConfig);

    expect(fetchMock.mock.calls[0][0].onAuth).toBeUndefined();
  });

  it('wires onAuth to return the configured username/token, defaulting username to the token itself', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });
    const config: GitRemoteConfig = { ...baseConfig, token: 'ghp_secret' };

    await fetchGitRemote('/dir', '/dir/.git', config);

    const onAuth = fetchMock.mock.calls[0][0].onAuth;
    expect(onAuth()).toEqual({ username: 'ghp_secret', password: 'ghp_secret' });
  });

  it('uses an explicit username alongside the token when one is set', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });
    const config: GitRemoteConfig = { ...baseConfig, username: 'alice', token: 'ghp_secret' };

    await fetchGitRemote('/dir', '/dir/.git', config);

    expect(fetchMock.mock.calls[0][0].onAuth()).toEqual({ username: 'alice', password: 'ghp_secret' });
  });

  it('forwards the configured corsProxy', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });
    const config: GitRemoteConfig = { ...baseConfig, corsProxy: 'https://cors.example.com' };

    await fetchGitRemote('/dir', '/dir/.git', config);

    expect(fetchMock.mock.calls[0][0].corsProxy).toBe('https://cors.example.com');
  });

  it('maps onProgress to (loaded, total)', async () => {
    fetchMock.mockImplementation(async ({ onProgress }) => {
      await onProgress({ phase: 'Receiving objects', loaded: 3, total: 10 });
      return { fetchHead: 'abc' };
    });
    const onProgress = vi.fn();

    await fetchGitRemote('/dir', '/dir/.git', baseConfig, onProgress);

    expect(onProgress).toHaveBeenCalledWith(3, 10);
  });
});

describe('pushGitRemote', () => {
  it('reports pushed:false without calling push when there are no local commits yet', async () => {
    resolveRefMock.mockRejectedValue(new Error('no HEAD'));

    const result = await pushGitRemote('/dir', '/dir/.git', baseConfig);

    expect(result).toEqual({ pushed: false });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('pushes to the shared "sync-folder" remote/ref name when a local commit exists', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockResolvedValue({ ok: true });

    await pushGitRemote('/dir', '/dir/.git', baseConfig);

    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({
      dir: '/dir',
      gitdir: '/dir/.git',
      remote: 'sync-folder',
      ref: 'main',
      remoteRef: 'main',
    }));
  });

  it('never forces a push — a force would replace the other device’s commits on the server', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockResolvedValue({ ok: true });

    await pushGitRemote('/dir', '/dir/.git', baseConfig);

    expect(pushMock.mock.calls[0][0].force).toBeFalsy();
  });

  it('reports conflict:true when git refuses a non-fast-forward push, so the caller fetches, merges and retries', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockRejectedValue(Object.assign(new Error('Push rejected because it was not a simple fast-forward.'), { code: 'PushRejectedError', data: { reason: 'not-fast-forward' } }));

    expect(await pushGitRemote('/dir', '/dir/.git', baseConfig)).toEqual({ pushed: false, conflict: true });
  });

  it('still reports other push failures as transport errors', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockRejectedValue(Object.assign(new Error('HTTP Error: 403 Forbidden'), { code: 'HttpError', data: { statusCode: 403 } }));

    await expect(pushGitRemote('/dir', '/dir/.git', baseConfig)).rejects.toThrow();
  });

  it('reports pushed:true on a successful push', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockResolvedValue({ ok: true });

    expect(await pushGitRemote('/dir', '/dir/.git', baseConfig)).toEqual({ pushed: true });
  });

  it('reports conflict:true when the server rejects the push (non-fast-forward) — real git compare-and-swap', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockResolvedValue({ ok: false, error: 'failed to update ref (non-fast-forward)' });

    expect(await pushGitRemote('/dir', '/dir/.git', baseConfig)).toEqual({ pushed: false, conflict: true });
  });

  it('does not configure the remote when there is nothing to push yet — no local commits', async () => {
    resolveRefMock.mockRejectedValue(new Error('no HEAD'));

    await pushGitRemote('/dir', '/dir/.git', baseConfig);

    expect(addRemoteMock).not.toHaveBeenCalled();
  });
});

// git.fetch()'s own ref-writing step reads the fetch refspec to apply from
// local git config, which nothing else in this app ever populates — so
// both fetch and push must register the "sync-folder" remote in config
// first (git.addRemote(), force:true so it's idempotent and self-heals if
// the configured URL changes) or isomorphic-git throws its own
// NoRefspecError even after a fetch that otherwise succeeded.
describe('ensureRemoteConfigured (via fetchGitRemote/pushGitRemote)', () => {
  it('fetchGitRemote registers the remote before fetching', async () => {
    fetchMock.mockResolvedValue({ fetchHead: 'abc123' });

    await fetchGitRemote('/dir', '/dir/.git', baseConfig);

    expect(addRemoteMock).toHaveBeenCalledWith(expect.objectContaining({
      dir: '/dir',
      gitdir: '/dir/.git',
      remote: 'sync-folder',
      url: baseConfig.url,
      force: true,
    }));
  });

  it('pushGitRemote registers the remote before pushing', async () => {
    resolveRefMock.mockResolvedValue('local-oid');
    pushMock.mockResolvedValue({ ok: true });

    await pushGitRemote('/dir', '/dir/.git', baseConfig);

    expect(addRemoteMock).toHaveBeenCalledWith(expect.objectContaining({
      remote: 'sync-folder',
      url: baseConfig.url,
      force: true,
    }));
  });

  it('re-registers with a changed URL — self-heals if the user reconfigures the remote', async () => {
    fetchMock.mockResolvedValue({ fetchHead: null });
    const changedConfig: GitRemoteConfig = { ...baseConfig, url: 'https://gitlab.com/me/recipes.git' };

    await fetchGitRemote('/dir', '/dir/.git', changedConfig);

    expect(addRemoteMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://gitlab.com/me/recipes.git', force: true }));
  });
});

// testGitRemoteConnection() used to be tested here. It is gone: built on
// git.getRemoteInfo(), it could not send credentials to a public repo at
// all (isomorphic-git only offers them after a 401, which a public
// upload-pack advertisement never returns), so it reported success for
// tokens it had never transmitted. remoteAccessProbe.test.ts covers its
// replacement.
describe('gitBasicCredentials', () => {
  // Exported so remoteAccessProbe.ts can build the same Basic header by
  // hand. If these two ever disagree, "Test Connection" starts answering a
  // different question than sync asks — the exact class of bug that let a
  // Google OAuth token sit in the GitHub token field for a week.
  it('has nothing to offer when no token is configured', () => {
    expect(gitBasicCredentials(baseConfig)).toBeNull();
  });

  it('defaults the username to the token itself, matching the https://<token>@ shorthand GitHub documents', () => {
    expect(gitBasicCredentials({ ...baseConfig, token: 'ghp_secret' })).toEqual({
      username: 'ghp_secret',
      password: 'ghp_secret',
    });
  });

  it('uses an explicit username when one is set', () => {
    expect(gitBasicCredentials({ ...baseConfig, username: 'alice', token: 'ghp_secret' })).toEqual({
      username: 'alice',
      password: 'ghp_secret',
    });
  });
});
