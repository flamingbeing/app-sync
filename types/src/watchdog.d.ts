/**
 * @typedef {{ relisten: boolean, cycle: boolean, why: 'cache' | 'flagged' | 'quiet' | '' }} Decision
 * @typedef {object} Facts
 * @property {number} now
 * @property {boolean} online
 * @property {boolean} [event]
 * @property {number} [lastServerAt]
 * @property {number} [openedAt]
 * @property {number} [cacheSince]
 * @property {number} [flaggedSince]
 * @property {number} [lastRelisten]
 * @property {number} [lastCycle]
 * @property {boolean} [quiet]
 */
/** @param {Facts} s @returns {Decision} */
export function decide(s: Facts): Decision;
/**
 * @param {{ relisten?: (why: string) => void, cycle?: (why: string) => void, now?: () => number, online?: () => boolean, quiet?: () => boolean }} [options]
 */
export function createWatchdog({ relisten, cycle, now, online, quiet }?: {
    relisten?: (why: string) => void;
    cycle?: (why: string) => void;
    now?: () => number;
    online?: () => boolean;
    quiet?: () => boolean;
}): {
    heard({ fromCache, hasPendingWrites }?: {
        fromCache?: boolean | undefined;
        hasPendingWrites?: boolean | undefined;
    }): void;
    opened(): void;
    event: () => Decision;
    check: () => Decision;
    stale: () => boolean;
};
export const CACHE_MS: 8000;
export const FLAG_MS: 6000;
export const STALE_MS: 10000;
export const THROTTLE_MS: 30000;
export const ESCALATE_MS: 6000;
export const CYCLE_THROTTLE_MS: 60000;
export type Decision = {
    relisten: boolean;
    cycle: boolean;
    why: "cache" | "flagged" | "quiet" | "";
};
export type Facts = {
    now: number;
    online: boolean;
    event?: boolean | undefined;
    lastServerAt?: number | undefined;
    openedAt?: number | undefined;
    cacheSince?: number | undefined;
    flaggedSince?: number | undefined;
    lastRelisten?: number | undefined;
    lastCycle?: number | undefined;
    quiet?: boolean | undefined;
};
