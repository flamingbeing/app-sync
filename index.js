// app-sync: everything in one import. Each module also loads on its own (src/<name>.js).
export { plan, applyChanges, replaceAll, applyTombs, dropTombs, pruneGone, binTombs, expireDocs, timeOf, eachSettled, createCollectionSync, createTombFeed, createSyncHub, replanOnWake, planServer, leaveEntry, SKEW, FULL_EVERY, GONE_KEEP, GRACE, REPLAN_EVERY } from './src/sync.js';
export { createWriteQueue, SEND_TIMEOUT } from './src/writes.js';
export { recordSignature, checkWrite, mergeFields } from './src/conflict.js';
export { createStores, OPEN_WAIT } from './src/store.js';
export { createOutbox } from './src/outbox.js';
export { decide, createWatchdog, CACHE_MS, FLAG_MS, STALE_MS, THROTTLE_MS, ESCALATE_MS, CYCLE_THROTTLE_MS } from './src/watchdog.js';
export { persistGuard } from './src/persist.js';
export { syncStatus, attentionCount } from './src/status.js';
export { forgetDevice, FORGET_TIMEOUT } from './src/forget.js';
export { createOutboxRegistry, REGISTRY_KEY, REGISTRY_TIMEOUT } from './src/registry.js';
export { createFirestoreBackend, CLEAR_TIMEOUT } from './src/firestore.js';
import { createReport as createReportOf } from './src/report.js';
export { buildReport, errorCode, REPORT_ENDPOINT, REPORT_EVERY, UNCONFIRMED_MS, MAX_CODES } from './src/report.js';
// the nothing-lost report, with this engine's version filled in
export const createReport = options => createReportOf({ sync: VERSION, ...options });
export const VERSION = '0.5.1';
