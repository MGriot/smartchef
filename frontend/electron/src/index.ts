import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import { getCapacitorElectronConfig, setupElectronDeepLinking } from '@capacitor-community/electron';
import type { MenuItemConstructorOptions } from 'electron';
import { app, dialog, ipcMain, MenuItem } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import electronIsDev from 'electron-is-dev';
import unhandled from 'electron-unhandled';

import { ElectronCapacitorApp, setupContentSecurityPolicy, setupReloadWatcher } from './setup';

// Graceful handling of unhandled errors.
unhandled();

// Define our menu templates (these are optional)
const trayMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [new MenuItem({ label: 'Quit App', role: 'quit' })];
const appMenuBarMenuTemplate: (MenuItemConstructorOptions | MenuItem)[] = [
  { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
  { role: 'viewMenu' },
];

// Get Config options from capacitor.config
const capacitorFileConfig: CapacitorElectronConfig = getCapacitorElectronConfig();

// Initialize our app. You can pass menu templates into the app here.
// const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig);
const myCapacitorApp = new ElectronCapacitorApp(capacitorFileConfig, trayMenuTemplate, appMenuBarMenuTemplate);

// If deeplinking is enabled then we will set it up here.
if (capacitorFileConfig.electron?.deepLinkingEnabled) {
  setupElectronDeepLinking(myCapacitorApp, {
    customProtocol: capacitorFileConfig.electron.deepLinkingCustomProtocol ?? 'mycapacitorapp',
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // Wait for electron app to be ready.
  await app.whenReady();
  // Security - Set Content-Security-Policy based on whether or not we are in dev mode.
  setupContentSecurityPolicy(myCapacitorApp.getCustomURLScheme());
  // Initialize our app, build windows, and load content.
  await myCapacitorApp.init();
})();

// Handle when all of our windows are close (platforms have their own expectations).
app.on('window-all-closed', function () {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// When the dock icon is clicked.
app.on('activate', async function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (myCapacitorApp.getMainWindow().isDestroyed()) {
    await myCapacitorApp.init();
  }
});

// Place all ipc or other electron api calls and custom functionality under this line

// SmartChef: native folder picker for the git-based sync feature — see
// frontend/src/lib/gitfs.ts. Desktop has no Storage Access Framework
// restriction (unlike Android, which uses a fixed Documents/SmartChef
// path instead), so a real "choose any folder" dialog is safe here.
ipcMain.handle('smartchef-pick-sync-folder', async () => {
  const win = myCapacitorApp.getMainWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a folder for SmartChef to sync recipes through',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Local Storage's base directory (wayfinder ticket 03, standalone-storage-
// sync map) — the live SQLite db (relocated here via electron/
// capacitor.config.ts's electronWindowsLocation/electronMacLocation/
// electronLinuxLocation) and content-addressed images (frontend/src/lib/
// localImages.ts) both live under this folder. Not user-configurable yet
// (that's deferred fog on the map) — always Documents/SmartChef.
ipcMain.handle('smartchef-get-local-storage-dir', async () => {
  return path.join(app.getPath('documents'), 'SmartChef');
});

// Hidden Clone's base directory (wayfinder ticket 03 remainder) — each
// device's own private git working copy that actually does commits/merges,
// distinct from both Local Storage above (the live db/images) and the
// user-picked Sync Folder (pickSyncFolder()). Lives under Electron's own
// app-data directory (never the user's visible Documents), created lazily
// (only once a Sync Folder is configured) by whichever code path calls
// git.init against this path for the first time — this handler only
// resolves where that is, it doesn't create anything itself.
ipcMain.handle('smartchef-get-hidden-clone-dir', async () => {
  return path.join(app.getPath('userData'), 'sync-clone');
});

// Standalone-mode geocode proxy — mirrors backend/src/routes/geocode.ts
// exactly (same cache-by-lowercased-query, same Nominatim endpoint/User-
// Agent/timeout), needed because standalone mode has no backend to proxy
// through. Must run in the main process, not the renderer: Nominatim's
// usage policy requires a real identifying User-Agent header, and browsers/
// Chromium's fetch (unlike Node's) refuse to let script code set that
// header at all — it's on the forbidden-headers list — regardless of CSP.
interface GeocodeResult { lat: number; lng: number; displayName: string }
const geocodeCache = new Map<string, GeocodeResult | null>();
ipcMain.handle('smartchef-geocode', async (_e, q: string) => {
  const query = String(q ?? '').trim();
  if (!query) return null;
  const key = query.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SmartChef/1.0 (self-hosted recipe app)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);
    const results = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!results.length) {
      geocodeCache.set(key, null);
      return null;
    }
    const result: GeocodeResult = { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), displayName: results[0].display_name };
    geocodeCache.set(key, result);
    return result;
  } catch {
    return null;
  }
});

// Git Remote sync mode's HTTP transport (see gitRemoteTransport.ts and
// electronBridge.ts's electronHttpRequest()) — routes isomorphic-git's
// git-server requests through here instead of the renderer's fetch(),
// since Node's fetch (unlike a browser's) isn't subject to CORS at all —
// CORS is a policy browsers enforce on same-origin web content, not a
// network-layer restriction — so this reaches GitHub/GitLab/self-hosted
// servers directly with no CORS proxy needed. Whole-request/whole-response,
// not streamed; Electron's IPC structured-clones Uint8Array directly (no
// base64 needed, unlike the Capacitor plugin bridge's JSON-only channel
// Android's equivalent, GitHttpPlugin.java, has to use).
ipcMain.handle('smartchef-http-request', async (_e, req: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }) => {
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: req.headers,
  };
  if (req.body) {
    init.body = Buffer.from(req.body);
    init.duplex = 'half'; // required by Node's fetch whenever a body is present, even a non-streamed one
  }
  const response = await fetch(req.url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const body = new Uint8Array(await response.arrayBuffer());
  return { url: response.url, statusCode: response.status, statusMessage: response.statusText, headers, body };
});

// Filesystem primitives for gitfs.ts's isomorphic-git adapter (see
// frontend/src/lib/gitfs.ts) — every call is best-effort/idempotent in the
// same spots the mobile @capacitor/filesystem-backed adapter already is
// (mkdir/unlink/rmdir swallow "already gone"/"already exists"), so both
// platforms' adapters behave identically from isomorphic-git's point of view.
ipcMain.handle('smartchef-fs-readFile', async (_e, filePath: string, encoding?: string) => {
  if (encoding && /utf-?8/i.test(encoding)) {
    return fs.promises.readFile(filePath, 'utf8');
  }
  const buf = await fs.promises.readFile(filePath);
  return new Uint8Array(buf);
});

ipcMain.handle('smartchef-fs-writeFile', async (_e, filePath: string, data: string | Uint8Array) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, typeof data === 'string' ? data : Buffer.from(data));
});

ipcMain.handle('smartchef-fs-unlink', async (_e, filePath: string) => {
  await fs.promises.unlink(filePath).catch(() => {});
});

ipcMain.handle('smartchef-fs-readdir', async (_e, dirPath: string) => {
  return fs.promises.readdir(dirPath).catch(() => [] as string[]);
});

ipcMain.handle('smartchef-fs-mkdir', async (_e, dirPath: string) => {
  await fs.promises.mkdir(dirPath, { recursive: true }).catch(() => {});
});

ipcMain.handle('smartchef-fs-rmdir', async (_e, dirPath: string) => {
  await fs.promises.rmdir(dirPath).catch(() => {});
});

ipcMain.handle('smartchef-fs-stat', async (_e, filePath: string) => {
  const s = await fs.promises.stat(filePath);
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    size: s.size,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
  };
});

ipcMain.handle('smartchef-fs-rename', async (_e, oldPath: string, newPath: string) => {
  await fs.promises.rename(oldPath, newPath);
});
