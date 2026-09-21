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

// ── Single instance ──────────────────────────────────────────────────
// Without this, launching SmartChef while it is ALREADY running starts a
// whole second app against the same userData directory — and the second one
// comes up as if the device had never been set up, because Chromium's
// Local Storage LevelDB is already locked by the first process, so the
// second instance's localStorage silently falls back to empty. There is no
// error anywhere: @capacitor/preferences has no Electron implementation, so
// it runs its WEB implementation on top of that localStorage, which means
// isStandaloneMode() (lib/standalone.ts) and getServerUrl() (lib/api.ts)
// both read null and App.tsx renders the FIRST-RUN storage chooser.
//
// That is not merely a confusing screen: choosing "Use offline on this
// device" there calls initStandaloneProfile(), which writes a brand-new
// profile into the (file-based, still perfectly writable) SQLite library.
// Five duplicate profiles accumulated in one install this way before the
// cause was found.
//
// The tray icon and hideMainWindowOnLaunch make hitting this easy: the app
// can be running with no visible window, so clicking the icon again is the
// natural thing to do — and it used to launch a second app rather than
// show the window that already existed. Now it does the latter.
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = myCapacitorApp.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
}

// If we are in Dev mode, use the file watcher components.
if (electronIsDev) {
  setupReloadWatcher(myCapacitorApp);
}

// Run Application
(async () => {
  // A losing second instance is already on its way out via app.quit()
  // above — building a window here would defeat the point of the lock.
  if (!isPrimaryInstance) return;
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

// SmartChef: native "save this file somewhere" dialog, for the encrypted
// Setup File (frontend/src/lib/setupConfigFile.ts). Deliberately a real
// dialog rather than the renderer's Blob + <a download> trick that
// BackupCard uses: the app is served from a custom protocol here, and the
// same trick is a silent no-op on Android (no DownloadListener is
// registered on the WebView), so one shared code path was never on offer
// anyway. Returns the chosen path, or null if the user cancelled.
ipcMain.handle('smartchef-save-file', async (_event, suggestedName: string, contents: string) => {
  const win = myCapacitorApp.getMainWindow();
  const result = await dialog.showSaveDialog(win, {
    title: 'Save your SmartChef setup file',
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, contents, 'utf8');
  return result.filePath;
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
interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  /** The place's own outline, only when the caller asked for one. */
  shape?: unknown;
  /** Nominatim's classification: boundary/administrative is a region,
   *  place/city is a point. */
  category?: string;
  kind?: string;
}
// Keyed by "<limit>:<query>" — a 1-result answer is not the answer to an
// 8-result question, and the region picker asks both (one to place a pin,
// many to offer city/sub-region suggestions as you type).
const geocodeCache = new Map<string, GeocodeResult[]>();
/** Simplification tolerance in degrees (~1 km), and the size past which
 *  the outline is dropped and only the point kept — an unsimplified
 *  regional boundary is hundreds of kilobytes, and this one ends up inside
 *  a recipe row that syncs to every device. Kept in step with
 *  backend/src/routes/geocode.ts. */
const POLYGON_THRESHOLD = 0.01;
const MAX_SHAPE_BYTES = 60_000;

/** The outline, unless it is not an area or is too big to carry. */
function withinBudget(geojson: unknown): unknown {
  if (!geojson || typeof geojson !== 'object') return undefined;
  const type = (geojson as { type?: string }).type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return undefined;
  return JSON.stringify(geojson).length > MAX_SHAPE_BYTES ? undefined : geojson;
}

ipcMain.handle('smartchef-geocode', async (_e, q: string, limit?: number, shape?: boolean) => {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const max = Math.min(8, Math.max(1, Math.trunc(Number(limit) || 1)));
  const wantShape = shape === true;
  const key = `${max}:${wantShape ? 'shape:' : ''}${query.toLowerCase()}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  try {
    const shapeParams = wantShape ? `&polygon_geojson=1&polygon_threshold=${POLYGON_THRESHOLD}` : '';
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${max}${shapeParams}&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SmartChef/1.0 (self-hosted recipe app)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Nominatim error ${response.status}`);
    const raw = (await response.json()) as Array<{ lat: string; lon: string; display_name: string; geojson?: unknown; class?: string; type?: string }>;
    const results: GeocodeResult[] = raw.map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      displayName: r.display_name,
      ...(wantShape ? { shape: withinBudget(r.geojson), category: r.class, kind: r.type } : {}),
    }));
    geocodeCache.set(key, results);
    return results;
  } catch {
    // Not cached: a transient failure should not permanently block a retry.
    return [];
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
ipcMain.handle('smartchef-http-request', async (_e, req: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array; timeoutMs?: number }) => {
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: req.headers,
  };
  if (req.body) {
    init.body = Buffer.from(req.body);
    init.duplex = 'half'; // required by Node's fetch whenever a body is present, even a non-streamed one
  }
  // Optional, and unset for git transport — a clone/push has always run
  // unbounded here and a ceiling on it would be a behaviour change. The
  // LLM callers (lib/nativeHttp.ts) do pass one: without it a wedged
  // provider request has no way back at all, since the renderer cannot
  // abort an in-flight ipcRenderer.invoke().
  if (req.timeoutMs) {
    init.signal = AbortSignal.timeout(req.timeoutMs);
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
