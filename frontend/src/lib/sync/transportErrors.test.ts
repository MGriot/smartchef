// ════════════════════════════════════════════════════════════════════════
// A desktop failed to push for a week and showed nothing. Two causes, both
// covered here.
//
// The first is that fetching a PUBLIC repository needs no credentials at
// all, while pushing to one does — so a device with no token syncs down
// perfectly and fails every upload with 401. From the outside that reads as
// "sync works", right up until you notice the remote has not moved. The raw
// error is an opaque HttpError; these pin that it comes out naming the
// cause and the fix.
//
// The second is that the failure never reached a screen: reportTransportOutcome()
// early-returned on Electron. That guard is gone, and its absence is pinned
// in gitSync.paused.test.ts.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
const pushMock = vi.fn();
const resolveRefMock = vi.fn();

vi.mock('isomorphic-git', () => ({
  fetch: (...a: unknown[]) => fetchMock(...a),
  push: (...a: unknown[]) => pushMock(...a),
  resolveRef: (...a: unknown[]) => resolveRefMock(...a),
  addRemote: async () => {},
  clone: async () => {},
  getRemoteInfo: async () => ({}),
}));
vi.mock('../gitfs', () => ({ gitfs: { promises: {} } }));
vi.mock('./gitCache', () => ({ gitCache: () => ({}) }));
vi.mock('./nativeHttpClient', () => ({ nativeHttpClient: {} }));
vi.mock('./gitObjectTransport', () => ({ DEFAULT_REMOTE_TRACKING_REF_NAME: 'refs/remotes/sync-folder/main' }));

const { fetchGitRemote, pushGitRemote } = await import('./gitRemoteTransport');

const config = { url: 'https://github.com/me/lib', username: null, token: null, corsProxy: null };

/** isomorphic-git's HttpError shape. */
function httpError(statusCode: number, message = `HTTP Error: ${statusCode}`) {
  return Object.assign(new Error(message), { data: { statusCode } });
}

beforeEach(() => {
  fetchMock.mockReset();
  pushMock.mockReset();
  resolveRefMock.mockReset().mockResolvedValue('localoid');
});

describe('a push rejected for credentials', () => {
  it('says nothing was uploaded, and where to put a token', async () => {
    pushMock.mockRejectedValue(httpError(401));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow(
      /rejected this device.s credentials, so nothing has been uploaded/
    );
  });

  it('explains that reading needs no token but writing does', async () => {
    // The whole reason this went unnoticed: the fetch half kept working.
    pushMock.mockRejectedValue(httpError(401));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow(
      /public repository needs no token, but writing to one does/
    );
  });

  it('names the GitHub token prefixes, so a token from the wrong service is self-diagnosing', async () => {
    // The real failure was a Google OAuth token in the GitHub token field.
    // "Mistyped, expired or revoked" sends someone to re-check a token that
    // was never a GitHub credential; naming the shape ends that in a glance.
    pushMock.mockRejectedValue(httpError(401));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow(/ghp_ or github_pat_/);
  });

  it('names the missing scope on a 403 rather than the raw error', async () => {
    pushMock.mockRejectedValue(httpError(403));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow(/missing write access/);
  });

  it('explains that a private repository reports as missing on a 404', async () => {
    pushMock.mockRejectedValue(httpError(404));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow(/private repository is reported as missing/);
  });

  it('passes an unrecognised failure through untouched', async () => {
    // Inventing an explanation for something we do not understand would be
    // worse than the raw message.
    pushMock.mockRejectedValue(new Error('socket hang up'));

    await expect(pushGitRemote('/d', '/d/.git', config)).rejects.toThrow('socket hang up');
  });

  it('still reports a server-side rejection as a conflict, not an error', async () => {
    // A non-fast-forward is the caller's cue to re-pull and retry, and must
    // not be turned into a credentials message.
    pushMock.mockResolvedValue({ ok: false });

    await expect(pushGitRemote('/d', '/d/.git', config)).resolves.toEqual({ pushed: false, conflict: true });
  });

  it('reports "nothing to push" for a device with no commits yet', async () => {
    resolveRefMock.mockRejectedValue(new Error('NotFoundError'));

    await expect(pushGitRemote('/d', '/d/.git', config)).resolves.toEqual({ pushed: false });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('a fetch rejected for credentials', () => {
  it('is described too, for the private-repository case', async () => {
    fetchMock.mockRejectedValue(httpError(401));

    await expect(fetchGitRemote('/d', '/d/.git', config)).rejects.toThrow(/Add a personal access token/);
  });

  it('does not claim an upload failed, since none was attempted', async () => {
    fetchMock.mockRejectedValue(httpError(401));

    await expect(fetchGitRemote('/d', '/d/.git', config)).rejects.not.toThrow(/uploaded/);
  });

  it('names the token prefixes on the fetch path too', async () => {
    fetchMock.mockRejectedValue(httpError(401));

    await expect(fetchGitRemote('/d', '/d/.git', config)).rejects.toThrow(/ghp_ or github_pat_/);
  });
});
