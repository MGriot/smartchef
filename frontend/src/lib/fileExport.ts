// ════════════════════════════════════════════════════════════════════════
// SmartChef — Handing a file to the user
//
// Every export in the app (a recipe's .smartchef.json, the Cookidoo text,
// a bulk or collection export, the library backup, the Setup File) ends
// here, because "save this file" is a genuinely three-way platform split:
//
//   - Electron: the native save dialog over IPC (lib/electronBridge.ts).
//   - Android:  the renderer's Blob + <a download> trick DOES NOTHING here —
//               no DownloadListener is registered on the WebView — so the
//               file is staged in the app's cache directory and handed to
//               the SmartChefFiles plugin (lib/filesBridge.ts), which opens
//               the system "save as" picker or the share sheet.
//   - Web:      the blob download, the only option a browser has.
//
// Staging is chunked on purpose. Capacitor's bridge JSON-serializes every
// argument, and a library backup with photos is tens of MB: one
// Filesystem.writeFile() of it is a string that size, plus its JSON copy,
// plus the native side's decode, all alive at once — the same pressure
// GitHttpPlugin's 512 KB rule and gitfs.ts's chunked writes exist to avoid.
// The native side only ever receives the staged file's path.
// ════════════════════════════════════════════════════════════════════════

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { isElectron, saveFileViaDialog } from './electronBridge';
import { hasNativeFiles, saveStagedFile, shareStagedFile } from './filesBridge';
import { bytesToBase64 } from './gitfs';

export interface ExportFile {
  fileName: string;
  mimeType: string;
  data: string | Uint8Array;
}

/** Where a saved file ended up, in whatever terms the platform offers. */
export interface ExportDestination {
  kind: 'electron' | 'android' | 'web';
  /** Human-readable, for "Saved to …": an absolute path on Electron, the
   *  name the user picked on Android, absent on the web (the browser owns
   *  the download). */
  location?: string;
  fileName: string;
}

export interface SaveOptions {
  /** The save dialog's title, where the platform shows one (Electron). */
  dialogTitle?: string;
}

/** Characters per staged write (strings) — UTF-8, so up to ~3 MB on the
 *  wire in the worst case and ~1 MB for the ASCII-heavy JSON this mostly
 *  carries. */
export const STAGE_CHUNK_CHARS = 1024 * 1024;
/** Bytes per staged write (binary), a multiple of 3 so each slice's base64
 *  concatenates into one valid stream. Matches gitfs.ts. */
export const STAGE_CHUNK_BYTES = 768 * 1024;
const STAGE_DIR = 'exports';

function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** True where a file can also be sent to another app (the Android share
 *  sheet). Elsewhere the save is the whole story. */
export function canShareFiles(): boolean {
  return isAndroidApp() && hasNativeFiles();
}

/** The extension filter Electron's dialog shows, derived from the name so
 *  "recipe.cookidoo.txt" offers "*.txt" rather than "*.cookidoo.txt". */
function filtersFor(fileName: string): { name: string; extensions: string[] }[] | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1];
  return ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined;
}

/** Writes the file into Directory.Cache/exports/ in bounded slices and
 *  returns its cache-relative path. The folder is cleared first: it only
 *  ever needs to hold the file being handed over right now, and nothing
 *  else cleans it up. */
export async function stageForNative(file: ExportFile): Promise<string> {
  const directory = Directory.Cache;
  await Filesystem.rmdir({ path: STAGE_DIR, directory, recursive: true }).catch(() => {});
  const path = `${STAGE_DIR}/${file.fileName}`;

  if (typeof file.data === 'string') {
    const text = file.data;
    // An empty file still has to exist for the plugin to hand over.
    if (text.length === 0) {
      await Filesystem.writeFile({ path, directory, data: '', encoding: Encoding.UTF8, recursive: true });
      return path;
    }
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + STAGE_CHUNK_CHARS, text.length);
      // Never split a surrogate pair: each slice is encoded to UTF-8 on its
      // own, and half an emoji on either side becomes two U+FFFDs.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const data = text.slice(offset, end);
      if (offset === 0) {
        await Filesystem.writeFile({ path, directory, data, encoding: Encoding.UTF8, recursive: true });
      } else {
        await Filesystem.appendFile({ path, directory, data, encoding: Encoding.UTF8 });
      }
      offset = end;
    }
    return path;
  }

  const bytes = file.data;
  if (bytes.length === 0) {
    await Filesystem.writeFile({ path, directory, data: '', recursive: true });
    return path;
  }
  for (let offset = 0; offset < bytes.length; offset += STAGE_CHUNK_BYTES) {
    const data = bytesToBase64(bytes.subarray(offset, offset + STAGE_CHUNK_BYTES));
    if (offset === 0) {
      await Filesystem.writeFile({ path, directory, data, recursive: true });
    } else {
      await Filesystem.appendFile({ path, directory, data });
    }
  }
  return path;
}

function saveInBrowser(file: ExportFile): ExportDestination {
  // Uint8Array.from: a Blob part must be backed by a plain ArrayBuffer, and
  // an arbitrary Uint8Array's type does not promise that.
  const part = typeof file.data === 'string' ? file.data : Uint8Array.from(file.data);
  const url = URL.createObjectURL(new Blob([part], { type: file.mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { kind: 'web', fileName: file.fileName };
}

/** Saves the file wherever this platform lets the user choose. Resolves to
 *  null when the user cancelled a native dialog — a cancel is not an
 *  error. */
export async function saveExportFile(file: ExportFile, options: SaveOptions = {}): Promise<ExportDestination | null> {
  if (isElectron()) {
    const saved = await saveFileViaDialog(file.fileName, file.data, {
      title: options.dialogTitle,
      filters: filtersFor(file.fileName),
    });
    return saved ? { kind: 'electron', location: saved, fileName: file.fileName } : null;
  }
  // Capacitor.isNativePlatform() is true for Electron too, so the Electron
  // check above has to come first; anything native reaching here is
  // Android.
  if (isAndroidApp()) {
    if (!hasNativeFiles()) throw new Error('This build of the app cannot save files yet');
    const path = await stageForNative(file);
    const saved = await saveStagedFile({ path, fileName: file.fileName, mimeType: file.mimeType });
    return saved ? { kind: 'android', location: saved.displayName, fileName: file.fileName } : null;
  }
  return saveInBrowser(file);
}

/** Opens the Android share sheet with the file attached. Only meaningful
 *  where canShareFiles() is true. */
export async function shareExportFile(file: ExportFile, title?: string): Promise<void> {
  if (!canShareFiles()) throw new Error('Sharing files is only available in the Android app');
  const path = await stageForNative(file);
  await shareStagedFile({ path, fileName: file.fileName, mimeType: file.mimeType, title });
}

/** "Pasta alla Norma!" → "pasta-alla-norma", for export filenames. Falls
 *  back when a title has no ASCII letters at all. */
export function slugForFilename(title: string | null | undefined, fallback = 'recipe'): string {
  const slug = (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug || fallback;
}
