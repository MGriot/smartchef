// ════════════════════════════════════════════════════════════════════════
// SmartChef — Reading a few files out of a remote without cloning it
//
// The first-run probe (firstRunProbe.ts) needs five small JSON files to
// answer "who is using this device?". Git has no way to hand over five
// files: the cheapest thing it will do is a depth-1 clone, which for a real
// library is a 2.1 MB packfile that isomorphic-git then indexes — hashing
// every object in JS, inside a WebView. That indexing, not the network, is
// what made the setup screen sit there.
//
// GitHub and GitLab both expose a plain HTTP API for exactly this. Measured
// against the real sync repository:
//
//     depth-1 clone            2.1 MB + indexing ~500 objects in JS
//     contents API             5.6 KB listing + five files of ~253 bytes
//                              336 ms, no packfile at all
//
// So when the remote is a host this understands, the probe reads the files
// directly and never touches git. Self-hosted remotes — which this cannot
// recognise, and which may be plain git-http-backend with no API at all —
// fall back to the clone, unchanged.
//
// Deliberately narrow: this is a read-only shortcut for onboarding, not a
// second transport. Nothing else in the app uses it, sync itself remains
// entirely git, and a failure here is never fatal — the caller falls back.
//
// Requests go through nativeHttp.ts rather than fetch() for the usual
// reason (CORS, and headers browsers reserve), not because these endpoints
// are special.
// ════════════════════════════════════════════════════════════════════════

import { nativeHttpRequest } from '../nativeHttp';
import type { GitRemoteConfig } from './syncSettings';

/** Matches gitRemoteTransport.ts's BRANCH — the one branch this app syncs. */
const BRANCH = 'main';

const REQUEST_TIMEOUT_MS = 30_000;

export interface RemoteFile {
  /** Path relative to the repository root, e.g. `profiles/<id>.json`. */
  path: string;
  text: string;
}

type Host =
  | { kind: 'github'; apiBase: string; owner: string; repo: string }
  | { kind: 'gitlab'; apiBase: string; projectPath: string };

/** Recognises the two hosts whose APIs this knows. Returns null for
 *  anything else — including a self-hosted GitLab, which is indistinguish-
 *  able from any other domain without probing it, and guessing wrong would
 *  trade a working clone for a confusing 404. */
export function detectHost(rawUrl: string): Host | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const segments = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/');
  if (segments.length < 2 || segments.some((s) => s === '')) return null;

  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    return { kind: 'github', apiBase: 'https://api.github.com', owner: segments[0], repo: segments.slice(1).join('/') };
  }
  if (url.hostname === 'gitlab.com' || url.hostname === 'www.gitlab.com') {
    return { kind: 'gitlab', apiBase: 'https://gitlab.com/api/v4', projectPath: segments.join('/') };
  }
  return null;
}

function authHeaders(host: Host, config: GitRemoteConfig): Record<string, string> {
  if (!config.token) return {};
  // Each host names its own header; sending the wrong one is simply
  // ignored, which would look like "this private repo does not exist".
  return host.kind === 'github'
    ? { Authorization: `Bearer ${config.token}` }
    : { 'PRIVATE-TOKEN': config.token };
}

/** A non-2xx answer, with its status kept so callers can branch on it
 *  rather than pattern-matching a message. */
class HttpStatusError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`${url} answered ${status}`);
  }
}

async function getText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await nativeHttpRequest({
    url,
    method: 'GET',
    // A User-Agent is not optional on GitHub's API — it rejects requests
    // without one — and is the sort of header a renderer fetch() could not
    // set anyway.
    headers: { 'User-Agent': 'SmartChef', Accept: 'application/json', ...headers },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new HttpStatusError(url, res.statusCode);
  }
  return new TextDecoder().decode(res.body);
}

interface GitHubEntry { name: string; path: string; type: string; download_url: string | null }
interface GitLabEntry { name: string; path: string; type: string }

export interface DirectoryListing {
  files: RemoteFile[];
  /** A token was configured and the host refused it, but the repository
   *  could still be read anonymously. Worth telling the user about:
   *  reading a public repository needs no credentials, so onboarding
   *  carries on fine, but every UPLOAD from this device will fail. */
  tokenRejected: boolean;
}

/** Lists and downloads every file directly inside `dirPath`.
 *
 *  Returns null — rather than throwing — when the host is not one this
 *  understands, so the caller can tell "no shortcut available" apart from
 *  "the shortcut failed", and fall back rather than give up. A directory
 *  that genuinely does not exist yet comes back as an empty listing: a
 *  library nobody has added a profile to is a real, non-error state.
 *
 *  ── When the host rejects the token ──
 *  GitHub does not fall back to anonymous access when a request carries a
 *  bad credential: an invalid, expired or revoked token gets 401 on the
 *  API and 404 on raw downloads, even for a PUBLIC repository that would
 *  have answered 200 with no token at all. Measured against the real
 *  library. Before this retry that sent every such device down the slow
 *  clone path — and, while the native layer was also corrupting large
 *  responses, into a hang — for a repository it could read perfectly well.
 *  So a rejected token is retried once without credentials, and the
 *  rejection is reported rather than silently worked around. */
export async function listDirectoryFiles(
  config: GitRemoteConfig,
  dirPath: string
): Promise<DirectoryListing | null> {
  const host = detectHost(config.url);
  if (!host) return null;

  const authed = authHeaders(host, config);
  try {
    return { files: await listWith(host, dirPath, authed), tokenRejected: false };
  } catch (err) {
    const rejected =
      Object.keys(authed).length > 0 &&
      err instanceof HttpStatusError &&
      (err.status === 401 || err.status === 403);
    if (!rejected) throw err;
    // A private repository will fail here too, and that failure propagates
    // to the caller exactly as before — this only rescues the case where the
    // credentials were the only problem.
    return { files: await listWith(host, dirPath, {}), tokenRejected: true };
  }
}

async function listWith(host: Host, dirPath: string, headers: Record<string, string>): Promise<RemoteFile[]> {
  if (host.kind === 'github') {
    const listUrl = `${host.apiBase}/repos/${host.owner}/${host.repo}/contents/${dirPath}?ref=${BRANCH}`;
    let entries: GitHubEntry[];
    try {
      entries = JSON.parse(await getText(listUrl, headers)) as GitHubEntry[];
    } catch (err) {
      // 404 is the expected shape for "no profiles directory yet".
      if (err instanceof HttpStatusError && err.status === 404) return [];
      throw err;
    }
    if (!Array.isArray(entries)) return [];
    const files = entries.filter((e) => e.type === 'file' && e.download_url);
    return Promise.all(
      files.map(async (e) => ({ path: e.path, text: await getText(e.download_url!, headers) }))
    );
  }

  const project = encodeURIComponent(host.projectPath);
  const treeUrl = `${host.apiBase}/projects/${project}/repository/tree?path=${encodeURIComponent(dirPath)}&ref=${BRANCH}&per_page=100`;
  let entries: GitLabEntry[];
  try {
    entries = JSON.parse(await getText(treeUrl, headers)) as GitLabEntry[];
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 404) return [];
    throw err;
  }
  if (!Array.isArray(entries)) return [];
  const files = entries.filter((e) => e.type === 'blob');
  return Promise.all(
    files.map(async (e) => ({
      path: e.path,
      text: await getText(
        `${host.apiBase}/projects/${project}/repository/files/${encodeURIComponent(e.path)}/raw?ref=${BRANCH}`,
        headers
      ),
    }))
  );
}
