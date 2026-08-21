import type { CapacitorConfig } from '@capacitor/cli';
import * as os from 'os';
import * as path from 'path';

// Kept in sync with electron/capacitor.config.ts's own copy — see that
// file for why this needs to be an absolute path with basename "SmartChef".
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
