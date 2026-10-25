// app-sync engine internals: the parts the public API (index.js) is built from, for tests and tools. No stability
// promise: these names and their shapes may change in any release. Apps import from index.js; until 1.0 index.js also
// re-exports these (deprecated, removed in 1.0.0).
export { plan, applyChanges, replaceAll, applyTombs, dropTombs, pruneGone, binTombs, expireDocs, timeOf, createCollectionSync, createTombFeed, planServer, FULL_EVERY, GONE_KEEP, GRACE, REPLAN_EVERY } from './sync.js';
export { watchSaved, SEND_TIMEOUT } from './writes.js';
export { clashingFields, mergeClashes, mergeFnClashes, whenText, keysOf } from './conflict.js';
export { OPEN_WAIT } from './store.js';
export { decide, CACHE_MS, FLAG_MS, STALE_MS, THROTTLE_MS, ESCALATE_MS, CYCLE_THROTTLE_MS } from './watchdog.js';
export { FORGET_TIMEOUT } from './forget.js';
export { REGISTRY_TIMEOUT } from './registry.js';
export { CLEAR_TIMEOUT } from './firestore.js';
export { buildReport, errorCode, REPORT_EVERY, UNCONFIRMED_MS, MAX_CODES, MAX_KINDS } from './report.js';
