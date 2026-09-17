// ════════════════════════════════════════════════════════════════════════
// "Can this device upload?" — the check that replaced one which could not
// tell.
//
// The bug being guarded against: a token from an entirely different
// service sat in the GitHub token field while "Test Connection" reported
// "Reachable — credentials accepted." every time. Two independent reasons,
// both pinned below:
//
//   1. the old check asked for git-upload-pack, which a PUBLIC repository
//      answers 200 to regardless of any token;
//   2. isomorphic-git does not send credentials until a server answers
//      401, so against that same 200 the token never left the device.
//
// So the two load-bearing assertions here are "asks receive-pack" and
// "sends Basic auth on the very first request". Everything else is the
// ladder that turns the answers into something a user can act on.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const nativeHttpRequest = vi.fn();
vi.mock('../nativeHttp', () => ({ nativeHttpRequest: (...a: unknown[]) => nativeHttpRequest(...a) }));

const { probeGitRemoteAccess, persistableProblem } = await import('./remoteAccessProbe');
import type { GitRemoteConfig } from './syncSettings';

const config: GitRemoteConfig = {
  url: 'https://github.com/MGriot/SmartChefSync-',
  username: null,
  token: 'ghp_EXAMPLE_NOT_A_REAL_TOKEN',
  corsProxy: null,
};
const anonymous: GitRemoteConfig = { ...config, token: null };

/** What a real git server sends: a pkt-line whose payload names the
 *  service. The probe treats this as proof a git server answered. */
function advertisement(service: string) {
  return {
    statusCode: 200,
    headers: { 'content-type': `application/x-${service}-advertisement` },
    body: new TextEncoder().encode(`001e# service=${service}\n0000`),
  };
}
function status(code: number) {
  return { statusCode: code, headers: {}, body: new Uint8Array() };
}
/** A 200 that is not a git server — a login wall, a share page. */
function htmlPage() {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
    body: new TextEncoder().encode('<!doctype html><html><body>Sign in</body></html>'),
  };
}

const urlOf = (call: number) => nativeHttpRequest.mock.calls[call][0].url as string;
const headersOf = (call: number) => nativeHttpRequest.mock.calls[call][0].headers as Record<string, string>;

beforeEach(() => {
  nativeHttpRequest.mockReset();
});

describe('what it asks the server', () => {
  it('asks for the receive-pack advertisement, not upload-pack', async () => {
    // upload-pack answers 200 to anyone for a public repo, so it cannot
    // answer the question "can this device WRITE?".
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    await probeGitRemoteAccess(config);

    expect(urlOf(0)).toBe('https://github.com/MGriot/SmartChefSync-/info/refs?service=git-receive-pack');
  });

  it('sends Basic auth on the very first request, unlike isomorphic-git', async () => {
    // isomorphic-git waits for a 401 before offering credentials. Against
    // a public repo it never gets one, so it never sends them — which is
    // how a bad token passed the old check.
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    await probeGitRemoteAccess(config);

    const expected = `Basic ${btoa(`${config.token}:${config.token}`)}`;
    expect(headersOf(0).Authorization).toBe(expected);
  });

  it('sends no Authorization header when no token is configured', async () => {
    nativeHttpRequest.mockResolvedValue(status(401));

    await probeGitRemoteAccess(anonymous);

    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it('strips a trailing slash so the refs path is not doubled', async () => {
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    await probeGitRemoteAccess({ ...config, url: 'https://github.com/MGriot/SmartChefSync-/' });

    expect(urlOf(0)).toBe('https://github.com/MGriot/SmartChefSync-/info/refs?service=git-receive-pack');
  });

  it('routes through a configured corsProxy, so the probe takes the same path as sync', async () => {
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    await probeGitRemoteAccess({ ...config, corsProxy: 'https://cors.test' });

    expect(urlOf(0)).toBe('https://cors.test/github.com/MGriot/SmartChefSync-/info/refs?service=git-receive-pack');
  });
});

describe('verdicts', () => {
  it('reports writable when receive-pack advertises, in a single request', async () => {
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    const result = await probeGitRemoteAccess(config);

    expect(result.kind).toBe('writable');
    expect(nativeHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('reports read-only on a 403 — the token is accepted, it just cannot write', async () => {
    nativeHttpRequest.mockResolvedValue(status(403));

    expect((await probeGitRemoteAccess(config)).kind).toBe('read-only');
  });

  it('reports read-only when the push is refused but the token still reads', async () => {
    // Some servers answer 401 rather than 403 for a refused write.
    nativeHttpRequest
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(advertisement('git-upload-pack'));

    expect((await probeGitRemoteAccess(config)).kind).toBe('read-only');
  });

  it('reports token-rejected when the server refuses the token on both endpoints', async () => {
    // ── The regression test for the confirmed bug. ──
    // Exactly what GitHub answers for a public repository plus a token from
    // another service, and exactly what used to render as a green
    // "credentials accepted": receive-pack 401, then upload-pack 401 too
    // once credentials are actually attached.
    nativeHttpRequest
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(status(401));

    const result = await probeGitRemoteAccess(config);

    expect(result.kind).toBe('token-rejected');
    // An authenticated read that is itself refused settles it — no point
    // asking anonymously as well.
    expect(nativeHttpRequest).toHaveBeenCalledTimes(2);
    expect(urlOf(1)).toContain('service=git-upload-pack');
    expect(headersOf(1).Authorization).toBeDefined();
  });

  it('falls back to an anonymous read to tell a bad token from a missing repo', async () => {
    // When the authed read is inconclusive (404 rather than 401), the only
    // way to know whether the REPO or the TOKEN is the problem is to ask
    // again with no credentials at all.
    nativeHttpRequest
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(advertisement('git-upload-pack'));

    const result = await probeGitRemoteAccess(config);

    expect(result.kind).toBe('token-rejected');
    expect(nativeHttpRequest).toHaveBeenCalledTimes(3);
    expect(headersOf(2).Authorization).toBeUndefined(); // the retry is anonymous
  });

  it('reports no-credentials when there is no token and the repo reads anonymously', async () => {
    // Reads fine, will never upload — the state that looked like success.
    nativeHttpRequest
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(advertisement('git-upload-pack'));

    expect((await probeGitRemoteAccess(anonymous)).kind).toBe('no-credentials');
  });

  it('reports not-found when even an anonymous read is refused', async () => {
    nativeHttpRequest
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(404));

    expect((await probeGitRemoteAccess(config)).kind).toBe('not-found');
  });

  it('reports unreachable when the request itself throws', async () => {
    nativeHttpRequest.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    expect((await probeGitRemoteAccess(config)).kind).toBe('unreachable');
  });

  it('reports unreachable for a 200 that is not a git advertisement', async () => {
    // A cloud-drive share link or a captive portal answers 200 and HTML.
    // Treating that as "writable" would be the worst possible answer.
    nativeHttpRequest.mockResolvedValue(htmlPage());

    expect((await probeGitRemoteAccess(config)).kind).toBe('unreachable');
  });

  it('asks for a URL before doing anything at all', async () => {
    const result = await probeGitRemoteAccess({ ...config, url: '   ' });

    expect(result.kind).toBe('unreachable');
    expect(nativeHttpRequest).not.toHaveBeenCalled();
  });
});

describe('the token it can judge without asking', () => {
  it('short-circuits a token that cannot be a GitHub credential, before any request', async () => {
    const result = await probeGitRemoteAccess({ ...config, token: 'AQ.Ab8_EXAMPLE_NOT_A_REAL_TOKEN' });

    expect(result.kind).toBe('malformed-token');
    expect(result.expectedPrefixes).toEqual(['ghp_', 'github_pat_']);
    // Nothing goes out: no latency, and no sending another service's live
    // credential to GitHub to find out what we already knew.
    expect(nativeHttpRequest).not.toHaveBeenCalled();
  });

  it('names both prefixes in the message', async () => {
    const result = await probeGitRemoteAccess({ ...config, token: 'AQ.Ab8RN6x' });

    expect(result.message).toMatch(/ghp_/);
    expect(result.message).toMatch(/github_pat_/);
  });

  it('still probes a self-hosted host it cannot judge', async () => {
    nativeHttpRequest.mockResolvedValue(advertisement('git-receive-pack'));

    const result = await probeGitRemoteAccess({ ...config, url: 'https://git.example.org/me/recipes.git', token: 'AQ.Ab8RN6x' });

    expect(result.kind).toBe('writable');
    expect(nativeHttpRequest).toHaveBeenCalled();
  });
});

describe('what gets remembered between screens', () => {
  it.each([
    ['token-rejected'],
    ['read-only'],
    ['no-credentials'],
    ['malformed-token'],
  ])('persists %s, which is a real permissions problem', (kind) => {
    expect(persistableProblem({ kind: kind as never, message: '' })).toBe(kind);
  });

  it.each([['writable'], ['not-found'], ['unreachable']])(
    'does not persist %s — transient or a half-typed URL, not a standing warning',
    (kind) => {
      expect(persistableProblem({ kind: kind as never, message: '' })).toBeNull();
    }
  );
});
