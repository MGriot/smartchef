// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the SafMirror native plugin
// Android-only (Storage Access Framework tree access — no Electron/web
// equivalent, see electronBridge.ts for Electron's own folder access).
// Registered via Capacitor.registerPlugin, backed by the app-specific
// SafMirrorPlugin.java (frontend/android/app/src/main/java/com/smartchef/
// app/SafMirrorPlugin.java) registered directly in MainActivity — not a
// published/npm plugin, so no entry in capacitor.settings.gradle.
//
// Stage so far: pickTree() and hasPersistedTree() are implemented natively
// (SafMirrorPlugin.java). list/readFile/writeFile/deleteFile are typed here
// already (docs/plans/2026-08-15-android-folder-sync-parity-design.md's
// full interface) but calling them before their native implementation
// lands will reject via Capacitor's own "method not implemented" error.
//
// Capacitor's bridge always resolves an object, never a bare JS `null` —
// so the raw native pickTree()/hasPersistedTree() calls resolve
// `{ uri: null, displayName: null }` for "no tree" rather than `null`
// itself. The exported pickTree()/hasPersistedTree() wrappers below do the
// coercion so every other caller in the app can just check for `null`.
// ════════════════════════════════════════════════════════════════════════

import { registerPlugin } from '@capacitor/core';

export interface SafTreeHandle {
  uri: string;
  displayName: string;
}

export interface SafEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface RawSafTreeHandle {
  uri: string | null;
  displayName: string | null;
}

export interface SafMirrorPlugin {
  pickTree(): Promise<RawSafTreeHandle>;
  hasPersistedTree(): Promise<RawSafTreeHandle>;
  list(opts: { uri: string; path: string }): Promise<{ entries: SafEntry[] }>;
  readFile(opts: { uri: string; path: string }): Promise<{ data: string }>;
  writeFile(opts: { uri: string; path: string; data: string }): Promise<void>;
  deleteFile(opts: { uri: string; path: string }): Promise<void>;
}

const raw = registerPlugin<SafMirrorPlugin>('SafMirror');

function coerce(handle: RawSafTreeHandle): SafTreeHandle | null {
  return handle.uri && handle.displayName ? { uri: handle.uri, displayName: handle.displayName } : null;
}

/** Opens the SAF folder picker. Resolves to the chosen tree, or null if
 *  the user cancelled. */
export async function pickTree(): Promise<SafTreeHandle | null> {
  return coerce(await raw.pickTree());
}

/** The tree chosen by a previous pickTree() call, if its permission is
 *  still valid — null if none was ever chosen, or it's been revoked since
 *  (app data cleared, provider uninstalled, revoked in Android settings). */
export async function hasPersistedTree(): Promise<SafTreeHandle | null> {
  return coerce(await raw.hasPersistedTree());
}

/** The raw plugin — list/readFile/writeFile/deleteFile, once implemented,
 *  are used directly through this rather than wrapped, since they don't
 *  need the null-coercion pickTree()/hasPersistedTree() do. */
export const SafMirror = raw;
