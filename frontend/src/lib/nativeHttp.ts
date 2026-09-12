// ════════════════════════════════════════════════════════════════════════
// SmartChef — One HTTP request from native code, either shell
//
// Standalone mode has no backend, so anything the app used to reach
// "through the server" it now has to reach itself — and a plain fetch()
// from the renderer can't, for two reasons that apply to every one of
// these calls: browser CORS (which arbitrary recipe sites and some
// provider endpoints don't grant) and the headers browsers reserve for
// themselves (User-Agent above all).
//
// Both shells already expose the same escape hatch — Electron's
// main-process IPC (electronBridge.ts) and Android's GitHttpPlugin
// (gitHttpBridge.ts) — and by now four callers want it: git transport,
// geocoding, recipe-page fetching (pageFetcher.ts) and cloud/Ollama LLM
// calls (llmParser.local.ts). This is that per-shell branch, written once.
// ════════════════════════════════════════════════════════════════════════

import { isElectron, electronHttpRequest } from './electronBridge';

export interface NativeHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Abort ceiling, enforced by the native side (the renderer can't abort
   *  an in-flight IPC call or plugin call, so an AbortSignal here would be
   *  a lie). Omitted means "whatever the shell's own default is" — which
   *  for Electron is no ceiling at all, deliberately, since git clone/push
   *  has always run unbounded there. */
  timeoutMs?: number;
}

export interface NativeHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Makes the request through whichever native primitive this shell has.
 *  Does NOT throw on a non-2xx — the status is returned for the caller to
 *  interpret, since a provider's error body is usually the only useful
 *  part of a failed LLM call. */
export async function nativeHttpRequest(req: NativeHttpRequest): Promise<NativeHttpResponse> {
  if (isElectron()) {
    const res = await electronHttpRequest(req);
    return { statusCode: res.statusCode, headers: res.headers, body: res.body };
  }

  const { GitHttp } = await import('./gitHttpBridge');
  const { base64ToBytes, bytesToBase64 } = await import('./gitfs');
  const res = await GitHttp.request({
    url: req.url,
    method: req.method,
    headers: req.headers,
    // The Capacitor plugin bridge is JSON-only, so bytes cross it base64'd
    // — unlike Electron's IPC, which structured-clones a Uint8Array as-is.
    ...(req.body ? { body: bytesToBase64(req.body) } : {}),
  });
  return { statusCode: res.statusCode, headers: res.headers, body: base64ToBytes(res.body) };
}

/** POST a JSON body and read a JSON response, the shape every LLM provider
 *  call in llmParser.local.ts needs. Returns the raw text alongside the
 *  parsed value so an error path can quote what the provider actually said
 *  even when it wasn't JSON at all (an HTML error page, a bare string). */
export async function nativeHttpPostJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<{ statusCode: number; text: string; json: unknown }> {
  const res = await nativeHttpRequest({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: new TextEncoder().encode(JSON.stringify(payload)),
    timeoutMs,
  });
  const text = new TextDecoder('utf-8').decode(res.body);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { statusCode: res.statusCode, text, json };
}
