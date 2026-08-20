// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shared "pick a sync folder" step for standalone mode
// The platform-branching pick (Electron: native dialog via gitfs.ts;
// Android: SAF tree picker via safMirrorBridge.ts/androidMirror.ts) is the
// one piece genuinely shared between Account.tsx's "Change Folder" button
// and ServerConnect.tsx's onboarding offer (wayfinder ticket 07) —
// everything around it (resyncing existing local data, an immediate first
// sync) is specific to each call site and stays there.
// ════════════════════════════════════════════════════════════════════════

import { isElectron } from './electronBridge';

export interface PickedSyncFolder {
  displayName: string;
}

/** Opens the platform's folder/tree picker and persists the choice
 *  immediately (both underlying pickers already do this as a side effect)
 *  — null if the user cancelled. */
export async function pickAndPersistSyncFolder(): Promise<PickedSyncFolder | null> {
  if (isElectron()) {
    const { chooseElectronSyncFolder } = await import('./gitfs');
    const chosen = await chooseElectronSyncFolder();
    return chosen ? { displayName: chosen } : null;
  }
  const { pickTree } = await import('./safMirrorBridge');
  const { setMirrorTree } = await import('./sync/androidMirror');
  const handle = await pickTree();
  if (!handle) return null;
  await setMirrorTree(handle.uri, handle.displayName);
  return { displayName: handle.displayName };
}

/** Un-persists whatever pickAndPersistSyncFolder() last chose — for a
 *  "Remove" step where the user picked a folder, then backed out before it
 *  should ever take effect (e.g. before submitting onboarding). */
export async function clearPersistedSyncFolder(): Promise<void> {
  if (isElectron()) {
    const { clearElectronSyncFolder } = await import('./gitfs');
    await clearElectronSyncFolder();
  } else {
    const { clearMirrorTree } = await import('./sync/androidMirror');
    await clearMirrorTree();
  }
}
