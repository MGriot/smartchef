// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the SmartChefFiles native plugin
// Android-only. Backed by the app-specific SmartChefFilesPlugin.java
// (frontend/android/app/src/main/java/com/smartchef/app/), registered
// directly in MainActivity. lib/fileExport.ts is the only caller.
//
// Both methods take a path relative to the app's cache directory
// (@capacitor/filesystem's Directory.Cache), never the file's contents —
// fileExport.ts stages the file there first, in chunks, so no large
// payload ever crosses the bridge in one call.
//
// Same null convention as safMirrorBridge.ts: the bridge always resolves
// an object, so a cancelled picker arrives as { uri: null } and is
// coerced to null here.
// ════════════════════════════════════════════════════════════════════════

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SavedDocument {
  /** The content:// URI the user chose. */
  uri: string;
  /** The name the file ended up with, which the picker lets the user edit. */
  displayName: string;
}

interface RawSavedDocument {
  uri: string | null;
  displayName: string | null;
}

interface StagedFile {
  /** Relative to Directory.Cache. */
  path: string;
  fileName: string;
  mimeType: string;
}

export interface SmartChefFilesPlugin {
  saveAs(opts: StagedFile): Promise<RawSavedDocument>;
  share(opts: StagedFile & { title?: string }): Promise<void>;
}

const raw = registerPlugin<SmartChefFilesPlugin>('SmartChefFiles');

export function hasNativeFiles(): boolean {
  return Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
    && Capacitor.isPluginAvailable('SmartChefFiles');
}

/** Opens the system "save as" picker and copies the staged file to the
 *  chosen location. Resolves to null if the user cancelled. */
export async function saveStagedFile(file: StagedFile): Promise<SavedDocument | null> {
  const result = await raw.saveAs(file);
  return result.uri ? { uri: result.uri, displayName: result.displayName || file.fileName } : null;
}

/** Opens the system share sheet with the staged file attached. */
export async function shareStagedFile(file: StagedFile & { title?: string }): Promise<void> {
  await raw.share(file);
}
