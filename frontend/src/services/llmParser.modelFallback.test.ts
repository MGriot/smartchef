// ════════════════════════════════════════════════════════════════════════
// A model that is busy or retired must not end the job.
//
// Gemini answers 503 "high demand" in bursts, which used to fail a whole
// catalog tidy-up on the first batch. Each call now retries its own model,
// then asks the fallback model once — unless the user named a model
// themselves, in which case their choice stands and the error is theirs to
// see. The HTTP bridge and Preferences are stubbed; the dispatch, retry
// and fallback are the real code.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const posts: Array<{ url: string; body: any }> = [];
/** Status per call, consumed in order; anything left over answers 200. */
let statuses: number[] = [];
let prefs: Record<string, string> = {};

vi.mock('../lib/nativeHttp', () => ({
  nativeHttpPostJson: async (url: string, _headers: unknown, payload: unknown) => {
    posts.push({ url, body: payload });
    const statusCode = statuses.shift() ?? 200;
    return {
      statusCode,
      text: statusCode === 200 ? '' : '{"error":{"message":"busy"}}',
      json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] },
    };
  },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs[key] ?? null }),
    set: async () => {},
    remove: async () => {},
  },
}));

beforeEach(() => {
  posts.length = 0;
  statuses = [];
  prefs = { 'smartchef.llm.provider': 'gemini', 'smartchef.llm.geminiKey': 'AIza-test' };
  vi.resetModules();
  vi.useFakeTimers();
});

// Fake timers are per-worker too — every later file would inherit them.
afterEach(() => {
  vi.useRealTimers();
});

/** The retries sleep; let them. */
async function callWithTimers(): Promise<string> {
  const { callConfiguredProvider } = await import('./llmParser.local');
  const promise = callConfiguredProvider('hello', 'system');
  // Marked as handled before the timers run: the call can reject while
  // vi.runAllTimersAsync() is still awaiting, which Node would otherwise
  // report as an unhandled rejection even though the test asserts on it.
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}

const modelOf = (url: string) => url.match(/models\/([^:]+):/)?.[1];

describe('a busy model', () => {
  it('retries the same model, then falls back to the second one', async () => {
    statuses = [503, 503, 503, 503]; // every attempt on the default model
    await expect(callWithTimers()).resolves.toContain('ok');

    const models = posts.map((p) => modelOf(p.url));
    expect(models.slice(0, 4)).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);
    expect(models[4]).toBe('gemini-2.5-flash');
  });

  it('gives up with a readable message when the fallback is busy too', async () => {
    statuses = new Array(10).fill(503);
    await expect(callWithTimers()).rejects.toThrow(/overloaded|HTTP 503/i);
  });

  it('keeps the chosen model when one is configured, rather than switching underneath', async () => {
    prefs['smartchef.llm.geminiModel'] = 'gemini-2.5-pro';
    statuses = new Array(10).fill(503);
    await expect(callWithTimers()).rejects.toThrow();
    expect(new Set(posts.map((p) => modelOf(p.url)))).toEqual(new Set(['gemini-2.5-pro']));
  });

  it('treats a retired model (404) as a reason to try the fallback', async () => {
    statuses = [404];
    await expect(callWithTimers()).resolves.toContain('ok');
    expect(posts.map((p) => modelOf(p.url))).toEqual(['gemini-3.6-flash', 'gemini-2.5-flash']);
  });

  it('does not retry a rejected key', async () => {
    statuses = [401];
    await expect(callWithTimers()).rejects.toThrow(/401/);
    expect(posts).toHaveLength(1);
  });
});
