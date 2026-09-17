// ════════════════════════════════════════════════════════════════════════
// SmartChef — Can this device actually UPLOAD to the configured remote?
//
// ── Why this is not git.getRemoteInfo() ──
// The obvious implementation is isomorphic-git's own getRemoteInfo(), and
// that is exactly what "Test Connection" used to call. It cannot work.
// GitRemoteHTTP.discover() sends its first request with NO Authorization
// header and only calls onAuth once the server answers 401. A public
// repository's `git-upload-pack` advertisement answers 200 to an anonymous
// request, so the token was never put on the wire at all — and the settings
// screen then reported "credentials accepted" about credentials it had not
// sent. A token from a completely different service passed that check while
// every push 401'd.
//
// So this module speaks the ref-advertisement half of git's smart-HTTP
// protocol itself, through nativeHttpRequest, and ALWAYS attaches
// credentials when it has them.
//
// ── Why the receive-pack endpoint ──
// `GET <repo>/info/refs?service=git-receive-pack` is the exchange a real
// `git push` opens with. It is the only read-only request a server answers
// differently depending on WRITE permission, which is the whole question
// being asked. Measured against the real sync repository:
//
//     service=git-upload-pack,  no token      -> 200   (tells us nothing)
//     service=git-upload-pack,  bad token     -> 200   (ditto — see above)
//     service=git-receive-pack, no token      -> 401
//     service=git-receive-pack, bad token     -> 401
//     service=git-receive-pack, read-only PAT -> 403
//     service=git-receive-pack, write PAT     -> 200
//
// Nothing is pushed and no ref is touched: the server only lists what it
// has. The happy path is a single request.
// ════════════════════════════════════════════════════════════════════════

import { nativeHttpRequest } from '../nativeHttp';
import { gitBasicCredentials } from './gitRemoteTransport';
import type { GitRemoteAccessProblem, GitRemoteConfig } from './syncSettings';
import { checkTokenShape } from './tokenShape';

/** Long enough for a cold self-hosted server to wake up, short enough that
 *  a settings button does not appear hung. A ref advertisement is small;
 *  this is a latency ceiling, not a transfer budget. */
const PROBE_TIMEOUT_MS = 20_000;

type Service = 'git-receive-pack' | 'git-upload-pack';

export type RemoteAccessKind =
  /** Credentials accepted and the server advertised refs for push. */
  | 'writable'
  /** The server can be read with these credentials but refuses to be
   *  written to — a token missing `repo` / `Contents: read and write`. */
  | 'read-only'
  /** A token IS configured and the server refused it. */
  | 'token-rejected'
  /** No token configured. Fine for reading a public repo; every push will
   *  fail. */
  | 'no-credentials'
  /** Cannot be a credential for this host. Decided locally — no request. */
  | 'malformed-token'
  /** No such repository, or it is private and invisible to these
   *  credentials (git reports both the same way). */
  | 'not-found'
  /** DNS/TLS/timeout, or something answered that is not a git server. */
  | 'unreachable';

export interface RemoteAccessResult {
  kind: RemoteAccessKind;
  /** One sentence, ready to render. Always present. */
  message: string;
  /** For logs and tests, not for copy. */
  status?: number;
  /** 'malformed-token' only. */
  expectedPrefixes?: string[];
}

/** Banner copy for every state that is not 'writable'.
 *
 *  Lives here, beside the code that decides the state, so a new kind cannot
 *  be added without copy — the Record's key type makes that a type error. */
export const ACCESS_PROBLEM_COPY: Record<Exclude<RemoteAccessKind, 'writable'>, { title: string; body: string }> = {
  'token-rejected': {
    title: 'Your access token was rejected',
    body:
      'The library can still be read if the repository is public, so you can carry on — but this device won’t be ' +
      'able to upload anything until the token is fixed. It may be mistyped, expired or revoked, or missing write ' +
      'access (repo, or Contents: read and write for a fine-grained token) — or it may not be a GitHub token at ' +
      'all: GitHub tokens begin ghp_ or github_pat_. A token from another service reads a public repository fine ' +
      'and fails every upload.',
  },
  'read-only': {
    title: 'This token cannot upload',
    body:
      'The server accepted the token but refused to let it write. On GitHub that means the token is missing the ' +
      'repo scope, or Contents: read and write for a fine-grained token. Reading will keep working; nothing this ' +
      'device changes will reach your other devices.',
  },
  'no-credentials': {
    title: 'No access token set',
    body:
      'Reading a public repository needs no token, so setup looks complete — but writing to one does. Without a ' +
      'token this device can receive changes and will never send any. Add a personal access token with write ' +
      'access.',
  },
  'malformed-token': {
    title: 'That does not look like a GitHub token',
    body:
      'GitHub tokens begin ghp_ or github_pat_. A token from another service can still read a public repository, ' +
      'so sync will appear to work while every upload fails. Double-check you copied it from GitHub → Settings → ' +
      'Developer settings → Personal access tokens.',
  },
  'not-found': {
    title: 'Repository not found',
    body:
      'The server has no repository at this URL. Check the address — and if the repository is private, that this ' +
      'device’s token can see it, since git reports a private repository as missing rather than forbidden.',
  },
  unreachable: {
    title: 'Could not reach this git server',
    body:
      'Nothing answered at this address, or what answered was not a git server. Check the URL and this device’s ' +
      'connection.',
  },
};

/** The subset of states worth remembering between screens. 'not-found' and
 *  'unreachable' are deliberately absent: both are usually transient or a
 *  half-typed URL, and persisting them would leave a scary banner up after
 *  a flaky moment rather than after a real permissions problem. */
const PERSISTABLE: Partial<Record<RemoteAccessKind, GitRemoteAccessProblem>> = {
  'token-rejected': 'token-rejected',
  'read-only': 'read-only',
  'no-credentials': 'no-credentials',
  'malformed-token': 'malformed-token',
};

/** The GitRemoteAccessProblem to store for a result, or null when there is
 *  nothing worth remembering. */
export function persistableProblem(result: RemoteAccessResult): GitRemoteAccessProblem | null {
  return PERSISTABLE[result.kind] ?? null;
}

/** Mirrors isomorphic-git's own corsProxify() so a user who configured a
 *  proxy is not silently bypassed by this check — a probe that took a
 *  different route than sync would answer a different question. */
function proxify(url: string, corsProxy: string | null): string {
  if (!corsProxy) return url;
  if (corsProxy.endsWith('?')) return `${corsProxy}${url}`;
  const base = corsProxy.replace(/\/+$/, '');
  return `${base}/${url.replace(/^https?:\/\//, '')}`;
}

function refsUrl(config: GitRemoteConfig, service: Service): string {
  const base = config.url.trim().replace(/\/+$/, '');
  return `${proxify(base, config.corsProxy)}/info/refs?service=${service}`;
}

interface Advertisement {
  status: number;
  /** A 200 is not enough: a captive portal, a cloud-drive share link or a
   *  repo browser all return 200 and HTML. Only a real advertisement proves
   *  a git server is on the other end. */
  isGit: boolean;
}

/** One ref-advertisement request.
 *
 *  `withCredentials` is explicit rather than inferred from the config
 *  because the ladder below needs to ask the SAME question both ways — "is
 *  it the token being refused, or the repository?" — and the only way to
 *  tell is to repeat the request without them. */
async function advertise(config: GitRemoteConfig, service: Service, withCredentials: boolean): Promise<Advertisement> {
  const headers: Record<string, string> = {
    // GitHub rejects requests without one, and a browser fetch() could not
    // set it anyway — the same reason hostContentsApi.ts sends it.
    'User-Agent': 'SmartChef',
    Accept: `application/x-${service}-advertisement`,
  };

  if (withCredentials) {
    const credentials = gitBasicCredentials(config);
    if (credentials) headers.Authorization = basicAuth(credentials.username, credentials.password);
  }

  const res = await nativeHttpRequest({
    url: refsUrl(config, service),
    method: 'GET',
    headers,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  const contentType = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '').toLowerCase();
  // Either signal is sufficient: some self-hosted servers serve the right
  // bytes under a generic content type. The body opens with a pkt-line
  // whose payload is `# service=<name>`, so the marker sits a few bytes in.
  const head = new TextDecoder().decode(res.body.slice(0, 64));
  const isGit = contentType.includes(`x-${service}-advertisement`) || head.includes('# service=');

  return { status: res.statusCode, isGit };
}

/** btoa() throws on any character above U+00FF, which a mistyped or
 *  smart-quoted token can easily contain. That throw would otherwise
 *  surface as 'unreachable' — blaming the network for a bad paste. */
function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
}

function result(kind: RemoteAccessKind, status?: number): RemoteAccessResult {
  if (kind === 'writable') {
    return { kind, message: 'Reachable — this device can upload.', status };
  }
  const copy = ACCESS_PROBLEM_COPY[kind];
  return { kind, message: `${copy.title}. ${copy.body}`, status };
}

/** Works out what this device can actually do with the configured remote.
 *
 *  One request when the credentials work; at most three when they do not.
 *  Never writes anything. */
export async function probeGitRemoteAccess(config: GitRemoteConfig): Promise<RemoteAccessResult> {
  if (!config.url.trim()) {
    return { kind: 'unreachable', message: 'Enter a repository URL first.' };
  }

  // Before any network call: a token that cannot belong to this host is
  // answerable on the device, instantly — and without sending some other
  // service's credential to GitHub.
  const shape = checkTokenShape(config.url, config.token);
  if (shape) {
    return { ...result('malformed-token'), expectedPrefixes: shape.expectedPrefixes };
  }

  let push: Advertisement;
  try {
    push = await advertise(config, 'git-receive-pack', true);
  } catch {
    return result('unreachable');
  }

  if (push.status === 200) {
    return push.isGit ? result('writable', 200) : result('unreachable', 200);
  }
  // 403 is unambiguous: the server identified the caller and then refused
  // the write. Nothing else worth asking.
  if (push.status === 403) return result('read-only', 403);
  if (push.status !== 401 && push.status !== 404) return result('unreachable', push.status);

  // Push was refused. Distinguish "these credentials are bad" from "this
  // repository is not there" by asking for the read half.
  if (config.token) {
    let authedRead: Advertisement;
    try {
      authedRead = await advertise(config, 'git-upload-pack', true);
    } catch {
      return result('unreachable');
    }
    // The token reads fine and only the write was refused — some servers
    // answer 401 rather than 403 for that.
    if (authedRead.status === 200 && authedRead.isGit) return result('read-only', push.status);
    if (authedRead.status === 401 || authedRead.status === 403) return result('token-rejected', authedRead.status);
  }

  let anonRead: Advertisement;
  try {
    anonRead = await advertise(config, 'git-upload-pack', false);
  } catch {
    return result('unreachable');
  }

  if (anonRead.status === 200 && anonRead.isGit) {
    // The exact shape of the bug this module was written for: a public
    // repository that reads perfectly while the configured token is refused.
    return config.token ? result('token-rejected', push.status) : result('no-credentials', push.status);
  }

  return result('not-found', anonRead.status);
}
