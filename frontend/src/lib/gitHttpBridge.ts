// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the GitHttp native plugin
// Android-only (no Electron equivalent — see electronBridge.ts's
// electronHttpRequest() for Electron's own IPC-based version of this same
// idea). Registered via Capacitor.registerPlugin, backed by the
// app-specific GitHttpPlugin.java (frontend/android/app/src/main/java/com/
// smartchef/app/GitHttpPlugin.java) registered directly in MainActivity —
// not a published/npm plugin, so no entry in capacitor.settings.gradle.
// Same reasoning as safMirrorBridge.ts: this exists so gitRemoteTransport.ts
// can reach a git server's HTTP endpoint from native code instead of the
// WebView's fetch(), sidestepping browser CORS entirely rather than
// needing a CORS proxy.
// ════════════════════════════════════════════════════════════════════════

import { registerPlugin } from '@capacitor/core';

export interface GitHttpPlugin {
  request(opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string; // base64, omitted for a bodyless request
  }): Promise<{
    url: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: string; // base64
  }>;
}

export const GitHttp = registerPlugin<GitHttpPlugin>('GitHttp');
