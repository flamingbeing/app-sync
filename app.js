// app-sync: the module runner, createApp({ config, modules }) (src/runner.js; 0.9.0). Modules: auth.js, sync.js,
// update.js. The one-object createApp(options) of 0.6-0.9 is removed (1.0.0-rc.1; MIGRATING.md).
export { createApp } from './src/runner.js';
// app-sync 0.9.4: this engine's version, as index.js has it, for a modules-only app (and its tests) to check.
export const VERSION = '1.5.5';
