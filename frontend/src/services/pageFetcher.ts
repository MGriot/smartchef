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
import { nativeHttpRequest } from '../lib/nativeHttp';

/** Same headers the backend sends — some sites serve a stripped page, or a
 *  bot wall, without a browser-shaped request. */
const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
};

const MAX_HTML_BYTES = 4_000_000;

// ── Caption-only hosts (Instagram) ──────────────────────────────────────
// Instagram serves a browser User-Agent a ~650KB JavaScript shell whose
// entire visible text is the word "Instagram" — so an imported reel/post
// link used to reach the model as no content at all, and Smart Import
// produced an empty recipe with no explanation.
//
// The post's real text is published for link unfurlers, and only to a
// crawler-shaped request. Two things then matter, both verified against a
// live public reel:
//   - og:description is TRUNCATED mid-word (~200 chars), which loses the
//     ingredients — it is not usable for importing.
//   - <meta name="description"> carries the WHOLE caption, newlines and
//     all, which for a recipe account is the entire recipe.
// So a caption host needs both a different User-Agent and a different
// extraction path from an ordinary recipe site, which is what the two
// helpers below are for.
const CAPTION_ONLY_HOSTS = [/(?:^|\.)instagram\.com$/i];

export function isCaptionOnlyHost(url: URL): boolean {
  return CAPTION_ONLY_HOSTS.some((re) => re.test(url.hostname));
}

/** Instagram only fills the metadata in for a request that looks like a
 *  link unfurler, so this asks as one. That metadata is exactly what
 *  Instagram publishes for the purpose — it is the same request the
 *  preview in any chat app makes when someone pastes the link. */
const CRAWLER_HEADERS: Record<string, string> = {
  'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
};

/** Entity decode that PRESERVES newlines — unlike recipeStructuredData.ts's
 *  own stripHtml(), which collapses all whitespace because schema.org
 *  fields are prose. Here the line breaks are the structure: a caption's
 *  "Ingredients:" / "250g pasta" / "1 Boursin" reads as a list to the model
 *  only while those newlines survive. Numeric entities are decoded too (&#xb0;
 *  for the degree sign in an oven temperature is extremely common here). */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    // Last, or it would mangle the entities decoded above.
    .replace(/&amp;/gi, '&');
}

function metaContent(html: string, attr: 'name' | 'property', key: string): string | null {
  // Attribute order varies, so try content-last and content-first. `[^"]`
  // matches newlines in JS, which is what keeps a multi-line caption whole.
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*\\scontent=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*\\s${attr}=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}

/** The post's caption, for a host that only publishes its content as page
 *  metadata. Returns null for every ordinary site — importantly so: a
 *  normal recipe page's <meta name="description"> is a 160-character SEO
 *  blurb, and preferring that over the page body would turn every working
 *  import into an empty one. */
export function extractSocialCaption(rawUrl: string, html: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isCaptionOnlyHost(url)) return null;

  const raw = metaContent(html, 'name', 'description') ?? metaContent(html, 'property', 'og:description');
  if (!raw) return null;

  let caption = decodeEntities(raw).trim();

  // Instagram prefixes the caption with engagement counts and wraps it in
  // quotes: `13K likes, 118 comments - someone on June 7, 2023: "<caption>". `
  // The counts are noise the model would otherwise fold into the recipe
  // description. Best-effort: an unrecognised shape is left exactly as-is
  // rather than risking cutting into the recipe itself.
  const framed = caption.match(/^[\d.,KMkm]+\s+likes?,\s*[\d.,KMkm]+\s+comments?\s+-\s+[^:]+:\s*"([\s\S]*)"\.?\s*$/);
  if (framed) caption = framed[1].trim();

  return caption || null;
}

/** The cover image a page publishes about itself, absolute and ready to
 *  store. og:image is the right source for this and the only one worth
 *  trusting: it is the picture the site itself nominates for a link
 *  preview, so it is the dish rather than a logo or a tracking pixel — and
 *  unlike scraping <img> tags it needs no guessing about which of forty
 *  images on the page is the recipe.
 *
 *  Deliberately separate from the LLM: the model is shown the page as
 *  STRIPPED TEXT (see htmlToPlainText in llmParser.local.ts), so it has no
 *  way to see an image URL at all unless one is handed to it. This is what
 *  hands it one — and what stands in when the model returns nothing. */
export function extractPageImage(rawUrl: string, html: string): string | null {
  const raw =
    metaContent(html, 'property', 'og:image') ??
    metaContent(html, 'property', 'og:image:url') ??
    metaContent(html, 'name', 'twitter:image');
  if (!raw) return null;
  return absoluteImageUrl(decodeEntities(raw).trim(), rawUrl);
}

/** Resolves a possibly-relative image URL against the page it came from,
 *  and rejects anything that is not a real remote image. `data:` is turned
 *  away on purpose: a cover is stored as a URL string, and inlining a
 *  multi-megabyte base64 blob into that column is not what the field is
 *  for. */
export function absoluteImageUrl(candidate: string | null | undefined, baseUrl?: string): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const resolved = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

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

async function fetchViaNativeBridge(url: URL): Promise<string> {
  const res = await nativeHttpRequest({
    url: url.toString(),
    method: 'GET',
    // A caption host answers a browser UA with an empty JS shell and only
    // fills in the metadata for an unfurler — see CAPTION_ONLY_HOSTS.
    headers: isCaptionOnlyHost(url) ? CRAWLER_HEADERS : PAGE_HEADERS,
    timeoutMs: 30_000,
  });
  if (res.statusCode >= 400) throw new Error(`The site returned HTTP ${res.statusCode}.`);
  return decodeBody(res.body);
}

/** The page's HTML, however this runtime can get it. Throws with a message
 *  worth showing the user — the Import screen surfaces it directly. */
export async function fetchPageHtml(rawUrl: string): Promise<string> {
  const url = assertImportableUrl(rawUrl);

  if (isNative() && (await isStandaloneMode())) {
    return fetchViaNativeBridge(url);
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
