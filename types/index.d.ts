export { createStores } from "./src/store.js";
export { createOutbox } from "./src/outbox.js";
export { createWatchdog } from "./src/watchdog.js";
export { persistGuard } from "./src/persist.js";
export { forgetDevice } from "./src/forget.js";
export { createFirestoreBackend } from "./src/firestore.js";
export { REPORT_ENDPOINT } from "./src/report.js";
export function createReport(options: Omit<import("./src/report.js").ReportOptions, "sync">): {
    watch(queue: {
        entries: () => any[];
    }): () => boolean;
    error(code?: any): void;
    payload: () => import("./src/report.js").ReportPayload;
    due: () => boolean;
    flush: (opts?: {
        force?: boolean;
    }) => Promise<boolean>;
    start(): void;
    stop(): void;
};
export * from "./src/internal.js";
export const FILES: string[];
export const VERSION: "0.9.4";
export { createSyncHub, replanOnWake, leaveEntry, eachSettled, SKEW } from "./src/sync.js";
export { createWriteQueue, JOB_FORMAT, JOB_STATES } from "./src/writes.js";
export { recordSignature, checkWrite, mergeFields, mergeHeld, describeConflict, resolvedRecord, pathOf } from "./src/conflict.js";
export { firestoreCache, cacheFailure, CACHE_KEY, CACHE_MODES } from "./src/cache.js";
export { syncStatus, attentionCount } from "./src/status.js";
export { createOutboxRegistry, REGISTRY_KEY } from "./src/registry.js";
export { createApp, userOf, claimsBehind } from "./src/app.js";
