// ════════════════════════════════════════════════════════════════════════
// SmartChef — What each LLM provider can read
//
// The table itself is a fact about four external APIs, so there is nothing
// to test in it. What IS worth pinning down is how the check around it
// behaves at the edges, because each of those choices is a decision that
// would otherwise be silently reversed by a refactor:
//
//   - an unknown or not-yet-known provider must NOT block the attempt
//   - the size ceiling is checked against the FILE, before encoding
//   - a rejection has to name a provider that would work, or the message
//     is just a dead end
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  checkMediaForProvider,
  mediaKindFor,
  providersSupporting,
  MAX_MEDIA_BYTES,
} from './llmMedia';

describe('mediaKindFor', () => {
  it('separates a PDF from an image, because models read it as a document', () => {
    expect(mediaKindFor('application/pdf')).toBe('document');
    expect(mediaKindFor('image/jpeg')).toBe('image');
    expect(mediaKindFor('audio/mpeg')).toBe('audio');
    expect(mediaKindFor('video/mp4')).toBe('video');
  });

  it('ignores the parameters browsers append to a type', () => {
    expect(mediaKindFor('audio/webm;codecs=opus')).toBe('audio');
    expect(mediaKindFor(' IMAGE/PNG ')).toBe('image');
  });

  it('returns null for something that is not media at all', () => {
    expect(mediaKindFor('application/zip')).toBeNull();
    expect(mediaKindFor('')).toBeNull();
  });
});

describe('checkMediaForProvider', () => {
  const small = 1024;

  it('lets every provider take an image', () => {
    for (const provider of ['anthropic', 'gemini', 'openai', 'ollama']) {
      expect(checkMediaForProvider('image/jpeg', small, provider).ok).toBe(true);
    }
  });

  it('only lets Gemini take audio and video, and says who can', () => {
    expect(checkMediaForProvider('audio/mpeg', small, 'gemini').ok).toBe(true);
    expect(checkMediaForProvider('video/mp4', small, 'gemini').ok).toBe(true);

    const rejected = checkMediaForProvider('audio/mpeg', small, 'openai');
    expect(rejected.ok).toBe(false);
    // The whole point of the message: it has to name the way out.
    expect(rejected.reason).toContain('Google Gemini');
    expect(providersSupporting('audio')).toEqual(['gemini']);
  });

  it('lets Anthropic take a PDF but not a clip', () => {
    expect(checkMediaForProvider('application/pdf', small, 'anthropic').ok).toBe(true);
    expect(checkMediaForProvider('video/mp4', small, 'anthropic').ok).toBe(false);
  });

  it('does not block when the provider is unknown or not fetched yet', () => {
    // The import screen reads the provider over the network and starts as
    // null. Refusing to try on a guess is worse than letting the provider
    // answer for itself — both runtimes still enforce the table server-side.
    expect(checkMediaForProvider('video/mp4', small, null).ok).toBe(true);
    expect(checkMediaForProvider('video/mp4', small, undefined).ok).toBe(true);
    expect(checkMediaForProvider('video/mp4', small, 'some-future-provider').ok).toBe(true);
  });

  it('rejects an oversized file before anything is encoded, whatever the provider', () => {
    const tooBig = MAX_MEDIA_BYTES + 1;
    const result = checkMediaForProvider('image/jpeg', tooBig, 'gemini');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too large/i);
    // Right at the ceiling is still fine — the check is "bigger than", not
    // "at least".
    expect(checkMediaForProvider('image/jpeg', MAX_MEDIA_BYTES, 'gemini').ok).toBe(true);
  });

  it('rejects a type nothing can read, before asking about the provider', () => {
    const result = checkMediaForProvider('application/zip', small, 'gemini');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/doesn't know what to do/i);
  });
});
