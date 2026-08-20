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
