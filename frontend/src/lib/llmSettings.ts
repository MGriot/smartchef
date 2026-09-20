// ════════════════════════════════════════════════════════════════════════
// SmartChef — Standalone mode's LLM provider settings
//
// Server mode keeps these on the `account` row (llm_provider plus three
// encrypted key columns, see backend/src/routes/auth.ts). Standalone mode
// has no account row and no server-side secret to encrypt with, so they
// live in Capacitor Preferences instead — deliberately per-device and
// deliberately NOT synced through the Sync Folder:
//
//   - An API key is billed to whoever pasted it. Pushing it through Folder
//     Sync would put one person's spend on every device sharing the
//     library, and would write a live credential into a git history that
//     may well be a cloud-drive folder or a hosted remote.
//   - It is the same call syncSettings.ts already makes for the git remote
//     token: per-device credential, plain on-device storage, never a
//     synced entity.
//
// Not a secret store. Preferences is plain localStorage under Electron and
// plain SharedPreferences on Android — someone with the device can read
// it. That is the same exposure as the git token next to it, and the same
// as the browser having a session cookie; the mitigation for a shared
// machine is a per-user OS account, not obfuscation here.
// ════════════════════════════════════════════════════════════════════════

import { Preferences } from '@capacitor/preferences';

/** Kept identical to the values the backend's `llm_provider` column
 *  accepts, since the same Account UI writes both. */
export type LlmProvider = 'ollama' | 'anthropic' | 'gemini' | 'openai';

export const CLOUD_PROVIDERS = ['anthropic', 'gemini', 'openai'] as const;
export type CloudLlmProvider = (typeof CLOUD_PROVIDERS)[number];

const PROVIDER_KEY = 'smartchef.llm.provider';
const OLLAMA_URL_KEY = 'smartchef.llm.ollamaUrl';
const CLOUD_KEY_PREF: Record<CloudLlmProvider, string> = {
  anthropic: 'smartchef.llm.anthropicKey',
  gemini: 'smartchef.llm.geminiKey',
  openai: 'smartchef.llm.openaiKey',
};

/** Where Ollama listens by default. Reachable in standalone mode because
 *  the LLM calls go through the native HTTP bridge (main process / native
 *  Android code), not the WebView — a renderer fetch() to localhost would
 *  be a cross-origin request from `capacitor-electron://-` and blocked. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** An optional model name per provider. Empty means "whatever the app
 *  ships as the default for that provider".
 *
 *  Exists because a model name is not a constant in practice: Google
 *  retired gemini-2.0-flash mid-2026 (every Smart Import answered HTTP
 *  404), and a busy model answers 503 for hours at a time. Both used to
 *  need a new installer to work around. */
const MODEL_PREF: Record<LlmProvider, string> = {
  ollama: 'smartchef.llm.ollamaModel',
  anthropic: 'smartchef.llm.anthropicModel',
  gemini: 'smartchef.llm.geminiModel',
  openai: 'smartchef.llm.openaiModel',
};

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'gemini', 'openai'] as const;

export interface LlmSettings {
  provider: LlmProvider;
  ollamaUrl: string | null;
  keys: Record<CloudLlmProvider, string | null>;
  /** Per-provider model override; null for the built-in default. */
  models: Record<LlmProvider, string | null>;
}

function normalizeProvider(raw: string | null): LlmProvider {
  return raw === 'anthropic' || raw === 'gemini' || raw === 'openai' ? raw : 'ollama';
}

export async function getLlmSettings(): Promise<LlmSettings> {
  const [provider, ollamaUrl, anthropic, gemini, openai, ...models] = await Promise.all([
    Preferences.get({ key: PROVIDER_KEY }),
    Preferences.get({ key: OLLAMA_URL_KEY }),
    Preferences.get({ key: CLOUD_KEY_PREF.anthropic }),
    Preferences.get({ key: CLOUD_KEY_PREF.gemini }),
    Preferences.get({ key: CLOUD_KEY_PREF.openai }),
    ...LLM_PROVIDERS.map((name) => Preferences.get({ key: MODEL_PREF[name] })),
  ]);
  return {
    provider: normalizeProvider(provider.value),
    ollamaUrl: ollamaUrl.value || null,
    keys: {
      anthropic: anthropic.value || null,
      gemini: gemini.value || null,
      openai: openai.value || null,
    },
    models: Object.fromEntries(LLM_PROVIDERS.map((name, i) => [name, models[i].value || null])) as Record<LlmProvider, string | null>,
  };
}

/** The shape GET /api/auth/llm-config returns in server mode — booleans
 *  for the cloud keys, never the values, so the settings form renders
 *  identically in both modes without knowing which one it is in. */
export interface LlmConfigSummary {
  provider: LlmProvider;
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  ollamaUrl: string | null;
  models: Record<LlmProvider, string | null>;
}

export async function getLlmConfigSummary(): Promise<LlmConfigSummary> {
  const s = await getLlmSettings();
  return {
    provider: s.provider,
    hasAnthropicKey: !!s.keys.anthropic,
    hasGeminiKey: !!s.keys.gemini,
    hasOpenaiKey: !!s.keys.openai,
    ollamaUrl: s.ollamaUrl,
    models: s.models,
  };
}

/** Field-by-field patch, matching the backend's PUT /auth/account
 *  semantics exactly: `undefined` leaves a field untouched, an empty
 *  string clears it. That distinction is what lets the settings form send
 *  a key only when the user actually typed in the field, instead of
 *  blanking the other two providers' keys on every save. */
export interface LlmSettingsPatch {
  provider?: LlmProvider;
  ollamaUrl?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  /** Same empty-string-clears semantics as the keys above. */
  models?: Partial<Record<LlmProvider, string>>;
}

export async function updateLlmSettings(patch: LlmSettingsPatch): Promise<void> {
  if (patch.provider !== undefined) {
    await Preferences.set({ key: PROVIDER_KEY, value: normalizeProvider(patch.provider) });
  }
  if (patch.ollamaUrl !== undefined) {
    const trimmed = patch.ollamaUrl.trim();
    if (trimmed) await Preferences.set({ key: OLLAMA_URL_KEY, value: trimmed });
    else await Preferences.remove({ key: OLLAMA_URL_KEY });
  }
  const cloud: Array<[CloudLlmProvider, string | undefined]> = [
    ['anthropic', patch.anthropicApiKey],
    ['gemini', patch.geminiApiKey],
    ['openai', patch.openaiApiKey],
  ];
  for (const [name, value] of cloud) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) await Preferences.set({ key: CLOUD_KEY_PREF[name], value: trimmed });
    else await Preferences.remove({ key: CLOUD_KEY_PREF[name] });
  }
  for (const name of LLM_PROVIDERS) {
    const value = patch.models?.[name];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) await Preferences.set({ key: MODEL_PREF[name], value: trimmed });
    else await Preferences.remove({ key: MODEL_PREF[name] });
  }
}
