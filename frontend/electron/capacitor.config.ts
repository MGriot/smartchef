import type { CapacitorConfig } from '@capacitor/cli';
import * as os from 'os';
import * as path from 'path';

// Local Storage's default location (wayfinder ticket 03, standalone-storage-
// sync map): a visible, discoverable folder rather than a hidden app-data
// directory. @capacitor-community/sqlite's Electron implementation resolves
// electronWindowsLocation/electronMacLocation/electronLinuxLocation as an
// absolute path directly (not appending an extra AppName subfolder) as long
// as the path's own basename already matches capacitor.config's `appName`
// below — both are "SmartChef", so the db ends up directly in this folder,
// not SmartChef/SmartChef.
const LOCAL_STORAGE_DIR = path.join(os.homedir(), 'Documents', 'SmartChef');

const config: CapacitorConfig = {
  appId: 'com.smartchef.app',
  appName: 'SmartChef',
  webDir: 'dist',
  plugins: {
    CapacitorSQLite: {
      // Electron's own capacitor.config.ts (frontend/electron/capacitor.config.ts)
      // carries the same block — @capacitor-community/sqlite's Electron
      // implementation reads its own project's compiled config, not this
      // root one, but keeping both in sync avoids drift if `cap sync` ever
      // starts regenerating the electron copy from this one.
      electronIsEncryption: false,
      electronWindowsLocation: LOCAL_STORAGE_DIR,
      electronMacLocation: LOCAL_STORAGE_DIR,
      electronLinuxLocation: LOCAL_STORAGE_DIR,
    },
  },
};

export default config;
