// ════════════════════════════════════════════════════════════════════════
// SmartChef — durable copy of the per-device Preferences (Electron only)
//
// The GitHub token, the AI keys and the sync settings are per-device and
// never synced, so they live only in @capacitor/preferences — which on
// Electron is Chromium's localStorage ("CapacitorStorage.<key>"). That store
// can come back empty after an upgrade or a reinstall, and then the user has
// to re-enter every secret. Each write is mirrored to a JSON file in the
// app-data folder through the main process, and restorePreferences() puts
// back whatever localStorage lost, before the app reads any of it.
//
// Restore only ever ADDS missing keys, so it can never overwrite a value the
// user changed. Removals are mirrored too, so a cleared token stays cleared.
// ════════════════════════════════════════════════════════════════════════

const PREFIX = 'CapacitorStorage.';

type Bridge = NonNullable<Window['smartchefElectron']>;

/** Pure: the keys of `backup` that `current` does not have. */
export function missingPreferences(backup: Record<string, unknown>, current: (key: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(backup)) {
    if (!key.startsWith(PREFIX) || typeof value !== 'string') continue;
    if (current(key) === null) out[key] = value;
  }
  return out;
}

let mirroring = false;

function mirrorWrites(bridge: Bridge): void {
  if (mirroring) return;
  mirroring = true;
  const proto = Storage.prototype;
  const set = proto.setItem;
  const remove = proto.removeItem;
  proto.setItem = function patchedSetItem(this: Storage, key: string, value: string) {
    set.call(this, key, value);
    if (this === window.localStorage && key.startsWith(PREFIX)) void bridge.setPrefsBackup?.(key, String(value))?.catch(() => {});
  };
  proto.removeItem = function patchedRemoveItem(this: Storage, key: string) {
    remove.call(this, key);
    if (this === window.localStorage && key.startsWith(PREFIX)) void bridge.setPrefsBackup?.(key, null)?.catch(() => {});
  };
}

/** Call once, before the app renders. Never throws: a failure here must not
 *  keep the app from starting. */
export async function restorePreferences(): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.smartchefElectron : undefined;
  if (!bridge?.readPrefsBackup || !bridge.setPrefsBackup) return;
  try {
    const backup = await bridge.readPrefsBackup();
    const lost = missingPreferences(backup ?? {}, (key) => window.localStorage.getItem(key));
    for (const [key, value] of Object.entries(lost)) window.localStorage.setItem(key, value);

    // First run of this version: seed the backup with what is already there.
    const known = new Set(Object.keys(backup ?? {}));
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX) && !known.has(key)) {
        void bridge.setPrefsBackup(key, window.localStorage.getItem(key)).catch(() => {});
      }
    }
    mirrorWrites(bridge);
    const restored = Object.keys(lost).length;
    if (restored > 0) console.info(`SmartChef: restored ${restored} setting(s) the app storage had lost`);
  } catch (err) {
    console.warn('SmartChef: preferences backup unavailable', err);
  }
}
