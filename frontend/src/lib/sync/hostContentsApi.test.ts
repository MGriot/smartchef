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

    expect(files).toEqual([{ path: 'profiles/a.json', text: '{"name":"Ana"}' }]);
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

    await expect(listDirectoryFiles(config, 'profiles')).resolves.toEqual([]);
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

    expect(files).toEqual([{ path: 'profiles/a.json', text: '{"name":"Ana"}' }]);
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
