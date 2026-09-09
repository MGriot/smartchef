// ════════════════════════════════════════════════════════════════════════
// SmartChef — Fetching a recipe page's HTML, in either runtime
//
// The structured-data extractor (recipeStructuredData.ts) needs the raw
// page. Getting it differs per runtime and neither can use a plain
// fetch() from the renderer:
//
//   - server mode: the browser cannot fetch arbitrary recipe sites
//     cross-origin, so POST /api/recipes/fetch-page does it — which is
//     also where the SSRF guard lives.
//   - standalone: there is no backend. Both native shells already expose a
//     generic HTTP primitive that bypasses the WebView (Electron's
//     main-process IPC, Android's GitHttpPlugin), the same ones geocoding
//     and git transport use.
// ════════════════════════════════════════════════════════════════════════

import { apiFetch, isNative } from '../lib/api';
import { isStandaloneMode } from '../lib/standalone';
import { isElectron, electronHttpRequest } from '../lib/electronBridge';

/** Same headers the backend sends — some sites serve a stripped page, or a
 *  bot wall, without a browser-shaped request. */
const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
};

const MAX_HTML_BYTES = 4_000_000;

/** Mirrors the backend's assertSafeImportUrl(). Standalone runs on the
 *  user's own device so there is no server to protect, but a typo'd or
 *  pasted-in `file://` or internal address should fail the same way in both
 *  modes rather than behaving differently depending on where the app is
 *  running. */
export function assertImportableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be imported.');
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === '::1' ||
    host.endsWith('.local');
  if (blocked) throw new Error('That address is on a private network and cannot be imported.');
  return url;
}

function decodeBody(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(
    bytes.length > MAX_HTML_BYTES ? bytes.slice(0, MAX_HTML_BYTES) : bytes,
  );
}

async function fetchViaNativeBridge(url: string): Promise<string> {
  if (isElectron()) {
    const res = await electronHttpRequest({ url, method: 'GET', headers: PAGE_HEADERS });
    if (res.statusCode >= 400) throw new Error(`The site returned HTTP ${res.statusCode}.`);
    return decodeBody(res.body);
  }

  // Android: the same native primitive gitRemoteTransport and geocoding use.
  const { GitHttp } = await import('../lib/gitHttpBridge');
  const { base64ToBytes } = await import('../lib/gitfs');
  const res = await GitHttp.request({ url, method: 'GET', headers: PAGE_HEADERS });
  if (res.statusCode >= 400) throw new Error(`The site returned HTTP ${res.statusCode}.`);
  return decodeBody(base64ToBytes(res.body));
}

/** The page's HTML, however this runtime can get it. Throws with a message
 *  worth showing the user — the Import screen surfaces it directly. */
export async function fetchPageHtml(rawUrl: string): Promise<string> {
  const url = assertImportableUrl(rawUrl);

  if (isNative() && (await isStandaloneMode())) {
    return fetchViaNativeBridge(url.toString());
  }

  const res = await apiFetch('/api/recipes/fetch-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.toString() }),
    timeoutMs: 30_000,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(typeof json.error === 'string' ? json.error : 'Could not fetch that page.');
  }
  return typeof json.data?.html === 'string' ? json.data.html : '';
}
