// ════════════════════════════════════════════════════════════════════════
// SmartChef — Native HttpClient for isomorphic-git (Git Remote sync mode)
//
// isomorphic-git/http/web runs the request through the WebView's own
// fetch() — which, being web content, is subject to the browser's CORS
// policy. GitHub/GitLab's git-smart-HTTP endpoints don't send CORS
// headers (they're built for native git clients, not browser JS), so that
// request gets blocked before this app's code ever sees a response,
// typically surfacing as a bare "Failed to fetch". The usual workaround is
// a CORS proxy (a public one is a single point of failure this app
// doesn't control the uptime of; a self-hosted one is another service to
// run) — but both are only needed because the request goes through a
// *browser* fetch in the first place.
//
// This app already has a way around that: Electron's main process and
// Android's native plugin layer both run outside the WebView's sandbox
// entirely, so neither is subject to CORS (a browser-content policy, not
// a network-layer one — see electron/src/index.ts's `smartchef-http-request`
// handler and GitHttpPlugin.java's own header). Routing the request
// through native code the same way this app already does for the
// filesystem (electronFs()/gitfs.ts) and Android's folder access
// (SafMirror) reaches the git server directly — no proxy needed at all.
//
// Requests still cross whole: isomorphic-git's GitHttpRequest.body is an
// async iterator, drained into one buffer here before going to native code.
//
// RESPONSES no longer do, on Android. They used to be wrapped back into a
// single-chunk async iterator, which was fine right up until the request
// that matters most — a new device's FIRST fetch, which has no local
// history to negotiate against and so receives a pack covering the whole
// repository (~16 MB on a real library). One base64 field in one JSON
// message meant that response existed five or six times over in large
// contiguous allocations across Java and the WebView, and the renderer was
// killed partway through: the app died on the first-run profile check with
// nothing thrown and nothing logged, because the JS awaiting it never ran
// again. GitHttpPlugin.java now spills a large response to a file and this
// walks it back in bounded slices (spilledBody.ts). Small responses — every
// ref advertisement, every push ack — still cross inline as before.
// ════════════════════════════════════════════════════════════════════════

import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { isElectron, electronHttpRequest } from '../electronBridge';
import { GitHttp } from '../gitHttpBridge';
import { spilledBodyChunks } from '../spilledBody';

async function drainBody(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  if (chunks.length === 0) return undefined;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* singleChunk(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Built in fixed-size pieces rather than one character at a time. The
 *  per-character `binary += String.fromCharCode(bytes[i])` this replaces is
 *  quadratic in practice once the body is megabytes rather than kilobytes —
 *  a push of a first-run pack spent longer here, allocating and discarding
 *  progressively longer strings, than it did on the network. 8 KB per
 *  apply() call stays well inside the argument-count limit that makes the
 *  obvious `String.fromCharCode(...bytes)` throw on a large array. */
const BASE64_CHUNK_BYTES = 8192;

function bytesToBase64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES)));
  }
  return btoa(pieces.join(''));
}

/** Neither native bridge below imposes any deadline of its own, so a remote
 *  that accepts a connection and then never answers left this promise
 *  pending forever. That is not merely a slow sync: gitSync.ts runs every
 *  git operation through ONE shared queue, so a single stuck request wedged
 *  that queue permanently — no further commit, push or pull for the rest of
 *  the session, and (until saves stopped awaiting it) a frozen editor on
 *  every subsequent save.
 *
 *  Generous on purpose: a real push of a large pack over a slow link is
 *  legitimately slow, and this bounds ONE HTTP request, not a whole sync
 *  cycle, so a multi-request fetch can still take much longer in total.
 *
 *  Honest limitation: neither bridge exposes cancellation, so this rejects
 *  the promise but does not abort the in-flight native request. That is
 *  enough for what actually matters here — the queue is released and the
 *  next operation proceeds — but the socket may linger until the OS gives
 *  up on it.
 *
 *  Raised from 60s once response bodies started streaming to a file: the
 *  native call now spans the whole download rather than returning as soon
 *  as the body is buffered, and the request that matters most — a new
 *  device's first fetch, which has no local history to negotiate against
 *  and so pulls the entire repository — is legitimately a multi-megabyte
 *  transfer over whatever connection a phone happens to have. Timing that
 *  out is worse than waiting: the caller treats a failed probe as "this
 *  library has no profiles" and offers to create one, which is how a
 *  device ends up minting a duplicate profile on a library that already
 *  has the user in it. */
const REQUEST_TIMEOUT_MS = 180_000;

function withTimeout<T>(work: Promise<T>, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SmartChef sync: no response from ${url} after ${REQUEST_TIMEOUT_MS / 1000}s`)),
      REQUEST_TIMEOUT_MS
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function request(req: GitHttpRequest): Promise<GitHttpResponse> {
  const method = req.method ?? 'GET';
  const headers = req.headers ?? {};
  const bodyBytes = await drainBody(req.body);

  if (isElectron()) {
    const res = await withTimeout(electronHttpRequest({ url: req.url, method, headers, body: bodyBytes }), req.url);
    return { url: res.url, method, headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage, body: singleChunk(res.body) };
  }

  const res = await withTimeout(
    GitHttp.request({ url: req.url, method, headers, body: bodyBytes ? bytesToBase64(bodyBytes) : undefined }),
    req.url
  );
  return {
    url: res.url,
    method,
    headers: res.headers,
    statusCode: res.statusCode,
    statusMessage: res.statusMessage,
    body: res.bodyFile
      ? spilledBodyChunks(res.bodyFile, res.bodyLength)
      : singleChunk(base64ToBytes(res.body ?? '')),
  };
}

/** Drop-in replacement for isomorphic-git/http/web's default export —
 *  same HttpClient shape, routed through native code instead of the
 *  WebView's fetch(). gitRemoteTransport.ts's only import from this file. */
export const nativeHttpClient: HttpClient = { request };
