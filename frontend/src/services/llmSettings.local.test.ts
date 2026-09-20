// ════════════════════════════════════════════════════════════════════════
// Standalone-mode AI Provider settings.
//
// /api/auth/llm-config and PUT /api/auth/account had no entry in
// localRouter.ts's dispatch list, so in offline mode the Account page's AI
// Provider card fell straight through to an HTTP request against a server
// that isn't there — "No server configured — connect to your SmartChef
// server first", printed under a Save button that could therefore never
// work. There was no way to use a Gemini/Anthropic/OpenAI key on a
// standalone install at all.
//
// Three things are under test:
//   1. The two endpoints now resolve locally, round-tripping through
//      Preferences.
//   2. The patch semantics match the backend route's: an absent field is
//      untouched, an empty one is cleared. This is what keeps the card's
//      "only send the key the user actually typed" behaviour from wiping
//      the other two providers' keys on every save.
//   3. /api/auth is still a PARTIAL namespace — anything else under it
//      keeps falling through (returns null), because /api/auth/status has
//      its own cached-account path in lib/api.ts that must not be shadowed.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// @capacitor/preferences' web implementation needs window.localStorage,
// unavailable in this suite's plain Node environment — same mock as
// syncSettings.test.ts.
const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    async get({ key }: { key: string }) {
      return { value: store.has(key) ? store.get(key)! : null };
    },
    async set({ key, value }: { key: string; value: string }) {
      store.set(key, value);
    },
    async remove({ key }: { key: string }) {
      store.delete(key);
    },
  },
}));

// localRouter pulls in every local service, and those reach db/local — but
// none of the routes under test touch SQLite, so a stub that would throw
// if one did is exactly the right amount of database here.
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => {
        throw new Error('no route under test should open the local database');
      },
    };
  }),
}));

// gitHttpBridge registers a native plugin at module load.
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ request: async () => { throw new Error('not used'); } }),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'electron' },
}));

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('standalone AI provider settings', () => {
  it('answers llm-config locally instead of falling through to a server', async () => {
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/auth/llm-config');

    // The bug was `null` here — "not mine, go make an HTTP request".
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.data).toEqual({
      provider: 'ollama',
      hasAnthropicKey: false,
      hasGeminiKey: false,
      hasOpenaiKey: false,
      ollamaUrl: null,
      // Empty until someone names a model in Account → AI Provider; the
      // app's own default answers for whichever provider is selected.
      models: { ollama: null, anthropic: null, gemini: null, openai: null },
    });
  });

  it('saves a provider and key, and reports the key as present without echoing it', async () => {
    const { dispatchLocal } = await import('./localRouter');

    const saved = await dispatchLocal('/api/auth/account', put({ llmProvider: 'gemini', geminiApiKey: 'AIzaSecretValue' }));
    expect(saved!.status).toBe(200);

    const res = await dispatchLocal('/api/auth/llm-config');
    expect(res!.data).toMatchObject({ provider: 'gemini', hasGeminiKey: true });
    // The summary is booleans by design — the raw key must never travel
    // back out through the settings endpoint.
    expect(JSON.stringify(res!.data)).not.toContain('AIzaSecretValue');

    const { getLlmSettings } = await import('../lib/llmSettings');
    expect((await getLlmSettings()).keys.gemini).toBe('AIzaSecretValue');
  });

  it('leaves the other providers\' keys alone when only one is sent', async () => {
    const { dispatchLocal } = await import('./localRouter');
    const { getLlmSettings } = await import('../lib/llmSettings');

    await dispatchLocal('/api/auth/account', put({ llmProvider: 'anthropic', anthropicApiKey: 'sk-ant-key' }));
    // The card sends a key only for the field the user typed in, so a
    // later save that switches provider carries no anthropicApiKey at all.
    await dispatchLocal('/api/auth/account', put({ llmProvider: 'gemini', geminiApiKey: 'AIza-key' }));

    const settings = await getLlmSettings();
    expect(settings.provider).toBe('gemini');
    expect(settings.keys.anthropic).toBe('sk-ant-key');
    expect(settings.keys.gemini).toBe('AIza-key');
  });

  it('clears a key when sent an empty string', async () => {
    const { dispatchLocal } = await import('./localRouter');
    const { getLlmSettings } = await import('../lib/llmSettings');

    await dispatchLocal('/api/auth/account', put({ geminiApiKey: 'AIza-key' }));
    await dispatchLocal('/api/auth/account', put({ geminiApiKey: '' }));

    expect((await getLlmSettings()).keys.gemini).toBeNull();
  });

  it('stores a custom Ollama URL and clears it when blanked', async () => {
    const { dispatchLocal } = await import('./localRouter');

    await dispatchLocal('/api/auth/account', put({ llmProvider: 'ollama', ollamaUrl: '  http://nas.local:11434  ' }));
    expect((await dispatchLocal('/api/auth/llm-config'))!.data).toMatchObject({ ollamaUrl: 'http://nas.local:11434' });

    await dispatchLocal('/api/auth/account', put({ ollamaUrl: '' }));
    expect((await dispatchLocal('/api/auth/llm-config'))!.data).toMatchObject({ ollamaUrl: null });
  });

  it('rejects a PUT carrying server-only identity fields rather than dropping them', async () => {
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/auth/account', put({ username: 'matteo', password: 'hunter2' }));

    expect(res!.status).toBe(400);
    expect(res!.error).toMatch(/no username or password/i);
  });

  it('leaves the rest of /api/auth falling through, so the cached-account path still works', async () => {
    const { dispatchLocal } = await import('./localRouter');

    // Not a 501: lib/api.ts's tryServeFromCache() owns /api/auth/status and
    // serves the offline-cached account from it. Claiming the whole
    // namespace here would have broken that.
    expect(await dispatchLocal('/api/auth/status')).toBeNull();
    expect(await dispatchLocal('/api/auth/logout', { method: 'POST' })).toBeNull();
    expect(await dispatchLocal('/api/auth/users')).toBeNull();
  });
});

describe('standalone Smart Import', () => {
  it('refuses to parse when the selected cloud provider has no key saved', async () => {
    const { dispatchLocal } = await import('./localRouter');

    await dispatchLocal('/api/auth/account', put({ llmProvider: 'gemini' }));

    const res = await dispatchLocal('/api/recipes/parse', {
      method: 'POST',
      body: JSON.stringify({ input: 'Pasta al pomodoro, 200g spaghetti', inputType: 'text' }),
    });

    // A settings mistake, surfaced as one — not a silent fallback onto
    // Ollama (which would be a different provider than the user picked)
    // and not the old blanket 501.
    expect(res!.status).toBe(500);
    expect(res!.error).toMatch(/no API key is saved/i);
  });

  it('rejects an empty parse request before reaching a provider', async () => {
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/recipes/parse', {
      method: 'POST',
      body: JSON.stringify({ input: '   ', inputType: 'text' }),
    });

    expect(res!.status).toBe(400);
  });
});
