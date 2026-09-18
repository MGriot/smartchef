// ════════════════════════════════════════════════════════════════════════
// SmartChef — Setup File, the parts that touch the device
//
// setupConfigFile.ts is pure: payload in, encrypted text out, and back. This
// module is the other half — reading the current Folder Sync settings into a
// payload, writing the result somewhere the user can find it, and applying
// an imported one. Kept apart so the crypto stays testable with no mocks and
// no platform branching.
//
// Saving a file is the one genuinely three-way platform split in the app:
//
//   - Electron: a real save dialog over IPC (lib/electronBridge.ts).
//   - Android:  @capacitor/filesystem into Documents/SmartChef. The
//               renderer's Blob + <a download> trick DOES NOTHING here —
//               no DownloadListener is registered on the WebView
//               (android/.../MainActivity.java) — so the file has to be
//               written directly and its path reported back.
//   - Web:      the blob download, which is the only option a browser has.
// ════════════════════════════════════════════════════════════════════════

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { isElectron, saveFileViaDialog } from './electronBridge';
import { isNative } from './api';
import {
  decodeSetupFile,
  encodeSetupFile,
  setupFileName,
  type SetupFilePayload,
} from './setupConfigFile';
import {
  getGitRemoteConfig,
  getSyncInterval,
  getSyncMode,
  setGitRemoteConfig,
  setSyncInterval,
  setSyncMode,
  clearGitRemoteConfig,
} from './sync/syncSettings';

/** Where the exported file ended up, in whatever terms that platform can
 *  offer: an absolute path on Electron, a content URI or folder name on
 *  Android, and nothing meaningful on the web (the browser owns it). */
export interface SetupFileDestination {
  kind: 'electron' | 'android' | 'web';
  /** Human-readable, for "Saved to …". Absent on the web. */
  location?: string;
  fileName: string;
}

/** Everything portable about this device's Folder Sync setup.
 *
 *  The sync folder itself is not portable and is left out on purpose — see
 *  the header of setupConfigFile.ts. */
export async function buildSetupPayload(deviceName?: string | null): Promise<SetupFilePayload> {
  const [mode, interval, gitRemote] = await Promise.all([
    getSyncMode(),
    getSyncInterval(),
    getGitRemoteConfig(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    exportedBy: deviceName ?? undefined,
    sync: {
      mode,
      interval,
      gitRemote: gitRemote
        ? {
            url: gitRemote.url,
            username: gitRemote.username,
            token: gitRemote.token,
            corsProxy: gitRemote.corsProxy,
          }
        : null,
    },
  };
}

async function saveOnAndroid(fileName: string, contents: string): Promise<SetupFileDestination> {
  // Documents rather than the app's private data dir: the whole point is to
  // move this file onto another device, so it has to be somewhere a file
  // manager, a USB connection or a messaging app can reach.
  const directory = Directory.Documents;
  const path = `SmartChef/${fileName}`;
  try {
    await Filesystem.mkdir({ path: 'SmartChef', directory, recursive: true });
  } catch {
    // Already there. mkdir has no "if not exists" and throws on a
    // collision, which is not a failure worth surfacing.
  }
  await Filesystem.writeFile({ path, directory, data: contents, encoding: Encoding.UTF8, recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory });
  return { kind: 'android', location: uri.replace(/^file:\/\//, ''), fileName };
}

function saveInBrowser(fileName: string, contents: string): SetupFileDestination {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { kind: 'web', fileName };
}

/** Encrypts the current settings and writes the file. Resolves to null when
 *  the user cancelled the native dialog — a cancel is not an error. */
export async function exportSetupFile(
  passphrase: string,
  deviceName?: string | null,
): Promise<SetupFileDestination | null> {
  const payload = await buildSetupPayload(deviceName);
  const contents = await encodeSetupFile(payload, passphrase);
  const fileName = setupFileName();

  if (isElectron()) {
    const saved = await saveFileViaDialog(fileName, contents);
    return saved ? { kind: 'electron', location: saved, fileName } : null;
  }
  // isNative() is true for both Electron and Android, so the Electron check
  // above has to come first; anything native reaching here is Android.
  if (isNative() && Capacitor.getPlatform() === 'android') {
    return saveOnAndroid(fileName, contents);
  }
  return saveInBrowser(fileName, contents);
}

/** What applying an imported payload actually changed, for the summary the
 *  UI shows afterwards. */
export interface AppliedSetup {
  mode: SetupFilePayload['sync']['mode'];
  remoteUrl: string | null;
  hasToken: boolean;
  /** True when this device still has to be pointed at a folder itself. */
  needsSyncFolder: boolean;
}

/** Writes an imported payload into this device's settings.
 *
 *  Order matters: the git-remote config is written before the mode is
 *  switched, so a sync cycle that fires in between never sees "Git Remote
 *  mode, configured against nothing". */
export async function applySetupPayload(payload: SetupFilePayload): Promise<AppliedSetup> {
  const { mode, interval, gitRemote } = payload.sync;

  if (gitRemote) {
    await setGitRemoteConfig({
      url: gitRemote.url,
      username: gitRemote.username,
      // Explicit null rather than undefined: undefined means "keep whatever
      // token is already stored" to setGitRemoteConfig, which would quietly
      // leave a previous device's token in place on a re-import.
      token: gitRemote.token ?? null,
      corsProxy: gitRemote.corsProxy,
    });
  } else if (mode === 'folder') {
    // A folder-mode file is a statement that this device is not using a
    // remote. Leaving a half-configured one behind would keep showing its
    // URL in the settings card under a mode that never reads it.
    await clearGitRemoteConfig();
  }

  await setSyncInterval(interval);
  await setSyncMode(mode);

  return {
    mode,
    remoteUrl: gitRemote?.url ?? null,
    hasToken: !!gitRemote?.token,
    needsSyncFolder: mode === 'folder',
  };
}

/** Reads a picked file, decrypts it and applies it in one step. Every
 *  failure arrives as a SetupFileError with a `kind` the caller can render. */
export async function importSetupFile(file: File, passphrase: string): Promise<AppliedSetup> {
  const payload = await decodeSetupFile(await file.text(), passphrase);
  return applySetupPayload(payload);
}
