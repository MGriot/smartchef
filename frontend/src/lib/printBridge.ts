// ════════════════════════════════════════════════════════════════════════
// SmartChef — Renderer-side bridge to the SmartChefPrint native plugin
// Android-only. Backed by the app-specific SmartChefPrintPlugin.java
// (frontend/android/app/src/main/java/com/smartchef/app/), registered
// directly in MainActivity — not an npm plugin, so no entry in
// capacitor.settings.gradle. lib/print.ts is the only caller: everything
// else asks print.ts, which decides per platform.
// ════════════════════════════════════════════════════════════════════════

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SmartChefPrintPlugin {
  /** Opens the system print dialog for the page currently on screen.
   *  Resolves once the dialog is showing, not when the job completes. */
  print(opts: { jobName: string }): Promise<void>;
}

export const SmartChefPrint = registerPlugin<SmartChefPrintPlugin>('SmartChefPrint');

/** False on a build whose native side predates the plugin — an APK built
 *  before it landed, running a newer web bundle through live reload. */
export function hasNativePrint(): boolean {
  return Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
    && Capacitor.isPluginAvailable('SmartChefPrint');
}
