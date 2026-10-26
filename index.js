// app-sync: the public API, in one import. Everything named here is promised (additive only until 2.0; README
// "Stability"). Stored formats: FORMATS.md. Engine internals: src/internal.js (no promise).
export { createSyncHub, replanOnWake, leaveEntry, eachSettled, SKEW } from './src/sync.js';
export { createWriteQueue, JOB_FORMAT, JOB_STATES } from './src/writes.js';
export { recordSignature, checkWrite, mergeFields, mergeHeld, describeConflict, resolvedRecord, pathOf } from './src/conflict.js';
export { replaceRecord } from './src/replace.js';   // 1.1.0
export { createStores } from './src/store.js';
export { createOutbox } from './src/outbox.js';
export { createWatchdog } from './src/watchdog.js';
export { persistGuard } from './src/persist.js';
export { firestoreCache, cacheFailure, CACHE_KEY, CACHE_MODES } from './src/cache.js';
export { syncStatus, attentionCount } from './src/status.js';
export { forgetDevice } from './src/forget.js';
export { createOutboxRegistry, REGISTRY_KEY } from './src/registry.js';
export { createFirestoreBackend } from './src/firestore.js';
// 1.0.0-rc.1: the one-object createApp(options) is removed; createApp({ config, modules }) loads from app.js
export { userOf, claimsBehind } from './src/user.js';
import { createReport as createReportOf } from './src/report.js';
export { REPORT_ENDPOINT } from './src/report.js';
// the nothing-lost report, with this engine's version filled in
/** @param {Omit<import('./src/report.js').ReportOptions, 'sync'>} options */
export const createReport = options => createReportOf({ sync: VERSION, ...options });
// the files this version loads (index.js and what it imports), for a service worker's list; also sync/<v>/files.json
export const FILES = ['index.js', 'src/cache.js', 'src/conflict.js', 'src/firestore.js', 'src/forget.js',
  'src/outbox.js', 'src/persist.js', 'src/registry.js', 'src/replace.js', 'src/report.js', 'src/status.js', 'src/store.js',
  'src/sync.js', 'src/user.js', 'src/watchdog.js', 'src/writes.js'];
export const VERSION = '1.3.11';
