// app-sync 0.9.1: the sync module for createApp({ config, modules }) (app.js), needs auth: the device copy, the outbox,
// the watches and the status (src/module-sync.js; options in src/core.js).
export { sync } from './src/module-sync.js';
// app-sync 0.9.3: the entry an app writes for a record it removes or loses (delete to the bin), as index.js has it.
export { leaveEntry } from './src/sync.js';
// 1.1.0: the merge function that writes a save over the server's copy whole (backend: { merge: { '*': replaceRecord } }).
export { replaceRecord } from './src/replace.js';
