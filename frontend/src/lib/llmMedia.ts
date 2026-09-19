// ════════════════════════════════════════════════════════════════════════
// SmartChef — What each LLM provider can actually read
//
// One table, two readers: services/llmParser.local.ts enforces it before
// building a request (standalone mode), and pages/RecipeImport.tsx reads it
// to say so in the import screen BEFORE a 15 MB video is encoded and
// uploaded to a provider that was never going to accept it.
//
// backend/src/services/llm.parser.ts keeps its own copy for server mode,
// on the same terms as the rest of that mirror: the two runtimes share no
// code, and this is one of the parts that must not drift. Change one,
// change the other.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';
import type { LlmProvider } from './llmSettings';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/** What kind of thing a MIME type is, as far as the providers care. PDFs
 *  are their own kind because they are the one format a model reads as a
 *  *document* (page structure, embedded text) rather than as pixels. */
export function mediaKindFor(mimeType: string): MediaKind | null {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/** Which provider can read which kind, as of the models each side pins.
 *
 *  A table rather than try-and-see: every one of these rejections comes
 *  back as an HTTP 400 about a malformed content block, which says nothing
 *  about the real problem (this provider cannot do audio) or the real fix
 *  (switch to one that can). Gemini is the only one of the four that takes
 *  audio and video at all, which is worth saying out loud rather than
 *  making someone discover it.
 *
 *  Ollama's entry means "images, if the model has eyes": the API accepts an
 *  `images` array against any model, and a text-only one silently drops it
 *  and answers from the prompt alone — so a wrong local model shows up as a
 *  recipe hallucinated out of nothing rather than as an error. That one
 *  cannot be caught from here, hence the caveat in the import screen. */
export const MEDIA_SUPPORT: Record<LlmProvider, MediaKind[]> = {
  anthropic: ['image', 'document'],
  gemini: ['image', 'document', 'audio', 'video'],
  openai: ['image'],
  ollama: ['image'],
};

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  ollama: 'Ollama',
};

export const KIND_LABEL: Record<MediaKind, string> = {
  image: 'images',
  document: 'PDFs',
  audio: 'audio',
  video: 'video',
};

/** Base64 inflates by ~4/3, and every provider has a request ceiling in the
 *  tens of megabytes for an inline payload. Checked before the upload
 *  rather than after, because the failure otherwise arrives minutes into
 *  pushing a video up a domestic connection. Server mode enforces the same
 *  number (llm.parser.ts), behind a route body limit sized to match. */
export const MAX_MEDIA_BYTES = 18 * 1024 * 1024;

export function providersSupporting(kind: MediaKind): LlmProvider[] {
  return (Object.keys(MEDIA_SUPPORT) as LlmProvider[]).filter((p) => MEDIA_SUPPORT[p].includes(kind));
}

export function supportsMedia(provider: LlmProvider, kind: MediaKind): boolean {
  return MEDIA_SUPPORT[provider].includes(kind);
}

function isKnownProvider(value: string | null | undefined): value is LlmProvider {
  return value === 'anthropic' || value === 'gemini' || value === 'openai' || value === 'ollama';
}

export interface MediaCheck {
  /** false only when we KNOW it will be rejected. An unrecognised provider
   *  name, or none fetched yet, reads as "no objection" — refusing to try
   *  on a guess is worse than letting the provider answer for itself. */
  ok: boolean;
  /** Present when ok is false: what is wrong and what to do about it. */
  reason?: string;
}

/** Whether `file` is worth sending to `provider`, checked on the device
 *  before it is encoded. */
export function checkMediaForProvider(
  mimeType: string,
  byteSize: number,
  provider: string | null | undefined,
): MediaCheck {
  const kind = mediaKindFor(mimeType);
  if (!kind) {
    return { ok: false, reason: i18n.t('media.unknownType', { type: mimeType || i18n.t('media.unknownTypeFallback') }) };
  }
  if (byteSize > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      reason: i18n.t('media.tooLarge', { mb: Math.round(byteSize / 1024 / 1024) }),
    };
  }
  if (!isKnownProvider(provider)) return { ok: true };
  if (supportsMedia(provider, kind)) return { ok: true };

  const alternatives = providersSupporting(kind).map((p) => PROVIDER_LABEL[p]);
  return {
    ok: false,
    reason:
      i18n.t('media.cantRead', { provider: PROVIDER_LABEL[provider], kind: i18n.t(`media.kinds.${kind}`) }) + ' ' +
      (alternatives.length
        ? i18n.t('media.switchTo', { providers: alternatives.join(` ${i18n.t('common.or')} `) })
        : i18n.t('media.extractYourself')),
  };
}
