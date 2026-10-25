// app-sync 0.9.0: the module runner, createApp({ config, modules }) (src/runner.js). Modules: auth.js (sync and update
// follow in 0.9.x). The one-object createApp of index.js is deprecated and removed in 1.0.0-rc.1.
export { createApp } from './src/runner.js';
// app-sync 0.9.4: this engine's version, as index.js has it, for a modules-only app (and its tests) to check.
export const VERSION = '0.9.4';
