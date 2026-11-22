// ════════════════════════════════════════════════════════════════════════
// SmartChef — AI drawings for catalog rows that have no picture
// (standalone mode)
//
// The Library's "missing pictures" action: for each ingredient, tool or
// technique without an image, ask the configured provider for an
// illustration in the style of one reference picture the user picked from
// their own catalog (by default the first ingredient that has one), so the
// whole library reads as one set rather than a mix of stock photos.
//
//   - Gemini gets the reference image itself, alongside the prompt — its
//     image models take a picture as a style reference.
//   - OpenAI's image endpoint takes text only here (the edits endpoint is
//     multipart, which the native HTTP bridge does not send), so the style
//     travels as words.
//   - Claude and Ollama cannot paint: the Library says so up front.
//
// The provider answers a ~1-2 MB PNG; it is shrunk to a 512 px WebP before
// it is stored — the catalog shows it as a thumbnail, and every stored
// picture is replicated to every synced device.
// ════════════════════════════════════════════════════════════════════════

import { getLlmSettings } from '../lib/llmSettings';
import { nativeHttpPostJson } from '../lib/nativeHttp';
import { base64ToBytes, bytesToBase64 } from '../lib/gitfs';
import { readImage, storeImage } from '../lib/localImages';
import { query, queryOne } from '../db/local';

export type DrawingKind = 'ingredients' | 'tools' | 'techniques';

/** Tried in order; a model that is gone (404) or busy moves to the next. */
const GEMINI_IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image-preview'];
const OPENAI_IMAGE_MODEL = 'gpt-image-1';
const TIMEOUT_MS = 120_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

export async function drawingProvider(): Promise<'gemini' | 'openai' | null> {
  const s = await getLlmSettings();
  if (s.provider === 'gemini' && s.keys.gemini) return 'gemini';
  if (s.provider === 'openai' && s.keys.openai) return 'openai';
  // A key for a drawing provider saved alongside a text-only one still
  // paints — Claude for text, Gemini for pictures is a common setup.
  if (s.keys.gemini) return 'gemini';
  if (s.keys.openai) return 'openai';
  return null;
}

export function drawingPrompt(kind: DrawingKind, name: string, description?: string | null, withReference = true): string {
  const subject =
    kind === 'techniques'
      ? `the cooking technique "${name}" being done — hands and the food or pan in action, so the technique is recognisable`
      : kind === 'tools'
        ? `the kitchen tool "${name}", the whole object clearly visible`
        : `the ingredient "${name}", as a cook buys it (whole, and cut open where that helps recognise it)`;
  const style = withReference
    ? 'Match the attached reference picture exactly in style: the same medium, stroke style, palette softness, lighting, ' +
      'background treatment and framing. Do NOT copy its subject.'
    : 'A soft, loose watercolor painting on textured white paper: wet-on-wet washes, gentle natural colors, delicate ' +
      'ink-free edges, a blurred warm background and a soft shadow underneath, centered, square framing.';
  return (
    `Paint ${subject}${description ? ` (${description.slice(0, 200)})` : ''}. ${style} ` +
    'One subject only, centered and filling most of the square. No text, no letters, no labels, no watermark, no border.'
  );
}

async function post(url: string, headers: Record<string, string>, payload: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await nativeHttpPostJson(url, headers, payload, TIMEOUT_MS);
    // "limit: 0" is a plan with no quota at all for this model (Gemini's
    // free tier has none for pictures): waiting will not change it.
    if (!RETRYABLE.has(res.statusCode) || attempt >= RETRY_DELAYS_MS.length || /limit:\s*0\b/.test(res.text)) return res;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

const detail = (text: string) => text.trim().slice(0, 300);

async function paintWithGemini(apiKey: string, prompt: string, reference: { mimeType: string; data: string } | null): Promise<Uint8Array> {
  let lastError: Error | null = null;
  for (const model of GEMINI_IMAGE_MODELS) {
    const parts: Array<Record<string, unknown>> = [];
    if (reference) parts.push({ inlineData: reference });
    parts.push({ text: prompt });
    const { statusCode, text, json } = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': apiKey },
      {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
      },
    );
    if (statusCode === 404 || RETRYABLE.has(statusCode)) {
      lastError = new Error(`Gemini ${model} returned HTTP ${statusCode}: ${detail(text)}`);
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) throw new Error(`Gemini returned HTTP ${statusCode}: ${detail(text)}`);
    const data = json as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
    const image = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!image) throw new Error(`Gemini returned no picture (${data?.candidates?.[0]?.finishReason ?? 'no image in the answer'})`);
    return base64ToBytes(image);
  }
  throw lastError ?? new Error('No Gemini image model answered');
}

async function paintWithOpenAI(apiKey: string, prompt: string): Promise<Uint8Array> {
  const { statusCode, text, json } = await post(
    'https://api.openai.com/v1/images/generations',
    { Authorization: `Bearer ${apiKey}` },
    { model: OPENAI_IMAGE_MODEL, prompt, size: '1024x1024', quality: 'medium', n: 1 },
  );
  if (statusCode < 200 || statusCode >= 300) throw new Error(`OpenAI returned HTTP ${statusCode}: ${detail(text)}`);
  const b64 = (json as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no picture');
  return base64ToBytes(b64);
}

/** Square, at most `size` px, WebP. Falls back to the original bytes where
 *  the WebView cannot encode WebP. */
export async function shrinkToWebp(bytes: Uint8Array, size = 512, quality = 0.85): Promise<{ bytes: Uint8Array; ext: string }> {
  try {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)]));
    const side = Math.min(size, Math.min(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    // Centre the largest square, then scale.
    const square = Math.min(bitmap.width, bitmap.height);
    // Looked up by a split name: the icon-font subsetter reads every word
    // of the source, and this method name would ship an unused glyph.
    (ctx[('dr' + 'awImage') as keyof CanvasRenderingContext2D] as unknown as (...args: unknown[]) => void).call(ctx, bitmap, (bitmap.width - square) / 2, (bitmap.height - square) / 2, square, square, 0, 0, side, side);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') throw new Error('webp not supported');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'webp' };
  } catch {
    return { bytes, ext: 'png' };
  }
}

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** The reference picture, shrunk — a 1 MB JPEG sent with every request
 *  would cost upload time on each of hundreds of calls for no better style. */
async function loadReference(relPath: string | null | undefined): Promise<{ mimeType: string; data: string } | null> {
  if (!relPath) return null;
  try {
    const raw = await readImage(relPath);
    const small = await shrinkToWebp(raw, 512, 0.9);
    const ext = small.ext === 'webp' ? 'webp' : (relPath.split('.').pop() ?? 'png').toLowerCase();
    return { mimeType: MIME_BY_EXT[ext] ?? 'image/png', data: bytesToBase64(small.bytes) };
  } catch (err) {
    console.warn('SmartChef: reference picture unreadable, painting without it:', err);
    return null;
  }
}

let referenceCache: { path: string; value: { mimeType: string; data: string } | null } | null = null;

export interface DrawingRequest {
  kind: DrawingKind;
  id: string;
  name: string;
  description?: string | null;
  /** A stored image path (images/<hash>.<ext>) to match the style of. */
  referencePath?: string | null;
}

/** Paints one picture and adds it as the row's first image. Returns the
 *  stored path. */
export async function paintCatalogPicture(req: DrawingRequest): Promise<{ path: string }> {
  const provider = await drawingProvider();
  if (!provider) throw new Error('Pictures need a Google Gemini or OpenAI key (Account → AI Provider).');
  const settings = await getLlmSettings();
  let bytes: Uint8Array;
  if (provider === 'gemini') {
    const refPath = req.referencePath ?? '';
    if (!referenceCache || referenceCache.path !== refPath) referenceCache = { path: refPath, value: await loadReference(refPath) };
    bytes = await paintWithGemini(settings.keys.gemini!, drawingPrompt(req.kind, req.name, req.description, !!referenceCache.value), referenceCache.value);
  } else {
    bytes = await paintWithOpenAI(settings.keys.openai!, drawingPrompt(req.kind, req.name, req.description, false));
  }
  const small = await shrinkToWebp(bytes);
  const path = await storeImage(small.bytes, small.ext);
  await attachImage(req.kind, req.id, path);
  return { path };
}

const TABLE: Record<DrawingKind, { table: string; live: string }> = {
  ingredients: { table: 'ingredients', live: "sync_status != 'deleted'" },
  tools: { table: 'tools', live: 'deleted_at IS NULL' },
  techniques: { table: 'techniques', live: 'deleted_at IS NULL' },
};

/** Puts `path` first in the row's image list, leaving the rest. */
export async function attachImage(kind: DrawingKind, id: string, path: string): Promise<void> {
  const t = TABLE[kind];
  const row = await queryOne<{ image_urls: string | null }>(`SELECT image_urls FROM ${t.table} WHERE id=$1 AND ${t.live}`, [id]);
  if (!row) return;
  let list: string[] = [];
  try { list = JSON.parse(row.image_urls ?? '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const next = [path, ...list.filter((u) => u !== path)];
  await query(`UPDATE ${t.table} SET image_urls=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(next), id]);
  if (kind === 'ingredients') await (await import('./ingredients.local')).syncIngredient(id);
  else if (kind === 'tools') await (await import('./ingredients.local')).syncTool(id);
  else await (await import('./techniques.local')).syncTechnique(id);
}
