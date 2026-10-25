/**
 * @param {{ online?: boolean, pending?: number, attention?: number, unsent?: number, persisted?: boolean, stale?: boolean, confirmed?: boolean, atRiskOnlyOffline?: boolean }} [input]
 * @returns {import('./types.js').SyncStatus}
 */
export function syncStatus({ online, pending, attention, unsent, persisted, stale, confirmed, atRiskOnlyOffline }?: {
    online?: boolean;
    pending?: number;
    attention?: number;
    unsent?: number;
    persisted?: boolean;
    stale?: boolean;
    confirmed?: boolean;
    atRiskOnlyOffline?: boolean;
}): import("./types.js").SyncStatus;
export function attentionCount(entries: {
    state: string;
}[] | null | undefined): number;
