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
// Whole-request/whole-response, not streamed, on both platforms — see
// each bridge's own header for why. isomorphic-git's GitHttpRequest.body
// is an async iterator; drained into one buffer here before crossing to
// native code, then the native response is wrapped back into a
// single-chunk async iterator on the way out, satisfying isomorphic-git's
// expected shape without either side needing true streaming.
// ════════════════════════════════════════════════════════════════════════

import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { isElectron, electronHttpRequest } from '../electronBridge';
import { GitHttp } from '../gitHttpBridge';

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function request(req: GitHttpRequest): Promise<GitHttpResponse> {
  const method = req.method ?? 'GET';
  const headers = req.headers ?? {};
  const bodyBytes = await drainBody(req.body);

  if (isElectron()) {
    const res = await electronHttpRequest({ url: req.url, method, headers, body: bodyBytes });
    return { url: res.url, method, headers: res.headers, statusCode: res.statusCode, statusMessage: res.statusMessage, body: singleChunk(res.body) };
  }

  const res = await GitHttp.request({ url: req.url, method, headers, body: bodyBytes ? bytesToBase64(bodyBytes) : undefined });
  return {
    url: res.url,
    method,
    headers: res.headers,
    statusCode: res.statusCode,
    statusMessage: res.statusMessage,
    body: singleChunk(base64ToBytes(res.body)),
  };
}

/** Drop-in replacement for isomorphic-git/http/web's default export —
 *  same HttpClient shape, routed through native code instead of the
 *  WebView's fetch(). gitRemoteTransport.ts's only import from this file. */
export const nativeHttpClient: HttpClient = { request };
