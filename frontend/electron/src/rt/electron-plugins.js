/* eslint-disable @typescript-eslint/no-var-requires */
const CapacitorCommunitySqlite = require('..\\..\\..\\node_modules\\@capacitor-community\\sqlite\\electron\\dist\\plugin.js');

module.exports = {
  CapacitorCommunitySqlite,
}
// --- SmartChef fix: unwrap Rollup's `.default` CJS-interop wrapper -------
// See comment in electron/scripts/fix-electron-plugins.js for why this is
// here instead of upstream. Idempotent: once unwrapped, a plugin's export
// no longer has a lone 'default' key, so re-running this is a no-op.
for (const key of Object.keys(module.exports)) {
  const mod = module.exports[key];
  if (mod && typeof mod === 'object' && 'default' in mod && Object.keys(mod).length === 1) {
    module.exports[key] = mod.default;
  }
}
