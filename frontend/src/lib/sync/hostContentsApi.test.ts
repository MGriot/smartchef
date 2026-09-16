// ════════════════════════════════════════════════════════════════════════
// The onboarding shortcut that avoids cloning to read five small files.
//
// Two things here are easy to get wrong in ways that are invisible until
// someone's setup breaks: which URLs are recognised (guessing that an
// unknown domain speaks GitLab's API would trade a working clone for a
// confusing 404), and which auth header each host wants (sending the wrong
// one is silently ignored, so a private library looks like it does not
// exist). Both are pinned below.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const nativeHttpRequest = vi.fn();
vi.mock('../nativeHttp', () => ({ nativeHttpRequest: (...a: unknown[]) => nativeHttpRequest(...a) }));

const { detectHost, listDirectoryFiles } = await import('./hostContentsApi');

function jsonResponse(value: unknown) {
  return { statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
}
function textResponse(text: string) {
  return { statusCode: 200, headers: {}, body: new TextEncoder().encode(text) };
}

beforeEach(() => {
  nativeHttpRequest.mockReset();
});

describe('detectHost', () => {
  it('recognises github with and without .git, and with a trailing slash', () => {
    for (const url of [
      'https://github.com/MGriot/SmartChefSync-',
      'https://github.com/MGriot/SmartChefSync-.git',
      'https://github.com/MGriot/SmartChefSync-/',
    ]) {
      expect(detectHost(url)).toMatchObject({ kind: 'github', owner: 'MGriot', repo: 'SmartChefSync-' });
    }
  });

  it('recognises gitlab.com, keeping nested group paths intact', () => {
    expect(detectHost('https://gitlab.com/group/sub/recipes.git')).toMatchObject({
      kind: 'gitlab',
      projectPath: 'group/sub/recipes',
    });
  });

  it('returns null for a self-hosted or unknown host', () => {
    // Deliberate: a self-hosted GitLab is indistinguishable from plain
    // git-http-backend without probing, and guessing wrong costs a working
    // clone. Unknown means "use git", not "fail".
    expect(detectHost('https://git.example.org/me/recipes.git')).toBeNull();
    expect(detectHost('https://gitlab.example.org/me/recipes.git')).toBeNull();
  });

  it('returns null for things that are not usable https URLs', () => {
    expect(detectHost('git@github.com:MGriot/x.git')).toBeNull();
    expect(detectHost('https://github.com/onlyowner')).toBeNull();
    expect(detectHost('not a url')).toBeNull();
    expect(detectHost('')).toBeNull();
  });
});

describe('listDirectoryFiles on GitHub', () => {
  const config = { url: 'https://github.com/MGriot/SmartChefSync-', username: null, token: null, corsProxy: null };

  it('lists the directory and fetches each file', async () => {
    nativeHttpRequest
      .mockResolvedValueOnce(jsonResponse([
        { name: 'a.json', path: 'profiles/a.json', type: 'file', download_url: 'https://raw.test/a.json' },
        { name: 'nested', path: 'profiles/nested', type: 'dir', download_url: null },
      ]))
      .mockResolvedValueOnce(textResponse('{"name":"Ana"}'));

    const files = await listDirectoryFiles(config, 'profiles');

    expect(files).toEqual({ files: [{ path: 'profiles/a.json', text: '{"name":"Ana"}' }], tokenRejected: false });
    const listUrl = (nativeHttpRequest.mock.calls[0][0] as { url: string }).url;
    expect(listUrl).toBe('https://api.github.com/repos/MGriot/SmartChefSync-/contents/profiles?ref=main');
  });

  it('sends a User-Agent, which the GitHub API rejects requests without', async () => {
    nativeHttpRequest.mockResolvedValue(jsonResponse([]));

    await listDirectoryFiles(config, 'profiles');

    expect((nativeHttpRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers)
      .toMatchObject({ 'User-Agent': 'SmartChef' });
  });

  it('uses a Bearer token when one is configured', async () => {
    nativeHttpRequest.mockResolvedValue(jsonResponse([]));

    await listDirectoryFiles({ ...config, token: 'ghp_secret' }, 'profiles');

    expect((nativeHttpRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers)
      .toMatchObject({ Authorization: 'Bearer ghp_secret' });
  });

  it('sends no auth header at all when there is no token', async () => {
    nativeHttpRequest.mockResolvedValue(jsonResponse([]));

    await listDirectoryFiles(config, 'profiles');

    expect((nativeHttpRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers.Authorization)
      .toBeUndefined();
  });

  it('treats a missing directory as empty, not as an error', async () => {
    // A library nobody has added a profile to yet is a real state, and the
    // caller must not fall back to a clone that would find nothing either.
    nativeHttpRequest.mockResolvedValue({ statusCode: 404, headers: {}, body: new Uint8Array() });

    await expect(listDirectoryFiles(config, 'profiles')).resolves.toEqual({ files: [], tokenRejected: false });
  });

  it('propagates a real failure so the caller can fall back to git', async () => {
    nativeHttpRequest.mockResolvedValue({ statusCode: 403, headers: {}, body: new Uint8Array() });

    await expect(listDirectoryFiles(config, 'profiles')).rejects.toThrow(/403/);
  });
});

describe('listDirectoryFiles on GitLab', () => {
  const config = { url: 'https://gitlab.com/group/sub/recipes', username: null, token: null, corsProxy: null };

  it('url-encodes the project path and fetches each blob raw', async () => {
    nativeHttpRequest
      .mockResolvedValueOnce(jsonResponse([
        { name: 'a.json', path: 'profiles/a.json', type: 'blob' },
        { name: 'sub', path: 'profiles/sub', type: 'tree' },
      ]))
      .mockResolvedValueOnce(textResponse('{"name":"Ana"}'));

    const files = await listDirectoryFiles(config, 'profiles');

    expect(files).toEqual({ files: [{ path: 'profiles/a.json', text: '{"name":"Ana"}' }], tokenRejected: false });
    const urls = nativeHttpRequest.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(urls[0]).toContain('/projects/group%2Fsub%2Frecipes/repository/tree');
    expect(urls[1]).toContain('/repository/files/profiles%2Fa.json/raw?ref=main');
  });

  it('uses PRIVATE-TOKEN rather than a Bearer header', async () => {
    // The wrong header is not rejected, it is ignored — which surfaces as
    // "this private library does not exist".
    nativeHttpRequest.mockResolvedValue(jsonResponse([]));

    await listDirectoryFiles({ ...config, token: 'glpat_secret' }, 'profiles');

    const headers = (nativeHttpRequest.mock.calls[0][0] as { headers: Record<string, string> }).headers;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat_secret');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('an unrecognised host', () => {
  it('returns null without making any request, so the caller clones', async () => {
    const result = await listDirectoryFiles(
      { url: 'https://git.example.org/me/recipes.git', username: null, token: null, corsProxy: null },
      'profiles'
    );

    expect(result).toBeNull();
    expect(nativeHttpRequest).not.toHaveBeenCalled();
  });
});

// ── A token the host refuses ────────────────────────────────────────────
// GitHub does not fall back to anonymous access when a request carries a bad
// credential. Measured against the real public library: an invalid token
// gets 401 from the contents API and 404 from raw downloads, where no token
// at all gets 200. Before the retry below, every device with a stale token
// went down the slow clone path for a repository it could read perfectly
// well — which is exactly the device that got stuck on setup.
describe('when the host rejects the configured token', () => {
  const config = { url: 'https://github.com/MGriot/SmartChefSync-', username: null, token: 'ghp_expired', corsProxy: null };
  const unauthorised = { statusCode: 401, headers: {}, body: new Uint8Array() };

  function authed(call: unknown[]): boolean {
    return 'Authorization' in (call[0] as { headers: Record<string, string> }).headers;
  }

  it('retries without credentials and still reads a public repository', async () => {
    nativeHttpRequest.mockImplementation(async (req: { url: string; headers: Record<string, string> }) => {
      if (req.headers.Authorization) return unauthorised;
      return req.url.includes('/contents/')
        ? jsonResponse([{ name: 'a.json', path: 'profiles/a.json', type: 'file', download_url: 'https://raw.test/a.json' }])
        : textResponse('{"name":"Ana"}');
    });

    const result = await listDirectoryFiles(config, 'profiles');

    expect(result?.files).toEqual([{ path: 'profiles/a.json', text: '{"name":"Ana"}' }]);
  });

  it('reports the rejection instead of quietly working around it', async () => {
    // Reading needs no token, so onboarding carries on — but every upload
    // from this device will fail, and that needs saying.
    nativeHttpRequest.mockImplementation(async (req: { headers: Record<string, string> }) =>
      req.headers.Authorization ? unauthorised : jsonResponse([]));

    const result = await listDirectoryFiles(config, 'profiles');

    expect(result?.tokenRejected).toBe(true);
  });

  it('does not send the rejected token again on the file downloads', async () => {
    // GitHub answers 404 on raw.githubusercontent.com for a bad token, which
    // would otherwise look like missing files.
    nativeHttpRequest.mockImplementation(async (req: { url: string; headers: Record<string, string> }) => {
      if (req.headers.Authorization) return req.url.includes('raw') ? { statusCode: 404, headers: {}, body: new Uint8Array() } : unauthorised;
      return req.url.includes('/contents/')
        ? jsonResponse([{ name: 'a.json', path: 'profiles/a.json', type: 'file', download_url: 'https://raw.test/a.json' }])
        : textResponse('{"name":"Ana"}');
    });

    await listDirectoryFiles(config, 'profiles');

    const downloads = nativeHttpRequest.mock.calls.filter((c) => (c[0] as { url: string }).url.includes('raw.test'));
    expect(downloads.length).toBe(1);
    expect(authed(downloads[0])).toBe(false);
  });

  it('still fails for a private repository, where anonymous reads are refused too', async () => {
    // The retry must only rescue "the credentials were the only problem" —
    // not paper over a repository this device genuinely cannot see.
    nativeHttpRequest.mockResolvedValue(unauthorised);

    await expect(listDirectoryFiles(config, 'profiles')).rejects.toThrow(/401/);
  });

  it('does not retry when no token was configured in the first place', async () => {
    nativeHttpRequest.mockResolvedValue(unauthorised);

    await expect(listDirectoryFiles({ ...config, token: null }, 'profiles')).rejects.toThrow(/401/);
    expect(nativeHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('reports no rejection when the token works', async () => {
    nativeHttpRequest.mockResolvedValue(jsonResponse([]));

    const result = await listDirectoryFiles(config, 'profiles');

    expect(result?.tokenRejected).toBe(false);
    expect(authed(nativeHttpRequest.mock.calls[0])).toBe(true);
  });
});
