/**
 * @param {{ app: string, version: string, sync?: string, entries?: any[], errors?: Record<string, number> | null, now?: number, byKind?: boolean }} input
 * @returns {ReportPayload}
 */
export function buildReport({ app, version, sync, entries, errors, now, byKind }: {
    app: string;
    version: string;
    sync?: string;
    entries?: any[];
    errors?: Record<string, number> | null;
    now?: number;
    byKind?: boolean;
}): ReportPayload;
/** @param {ReportOptions} options */
export function createReport({ app, version, sync, endpoint, every, storage, send, now, onError, byKind }?: ReportOptions): {
    /** @param {{ entries: () => any[] }} queue */
    watch(queue: {
        entries: () => any[];
    }): () => boolean;
    /** @param {any} [code] */
    error(code?: any): void;
    payload: () => ReportPayload;
    due: () => boolean;
    flush: (opts?: {
        force?: boolean;
    }) => Promise<boolean>;
    start(): void;
    stop(): void;
};
/**
 * @typedef {object} ReportOptions
 * @property {string} app
 * @property {string | (() => string)} version
 * @property {string} [sync]
 * @property {string} [endpoint]
 * @property {number} [every]
 * @property {Pick<Storage, 'getItem' | 'setItem'> | null} [storage]
 * @property {(url: string, body: string) => any} [send]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {boolean} [byKind]
 * @typedef {{ v: 1, app: string, version: string, sync: string, unconfirmed: number, refused: number, conflicts: number,
 *   errors: Record<string, number>, held?: Record<string, number> }} ReportPayload
 */
export const REPORT_ENDPOINT: "https://core.anawj.com/report";
export const REPORT_EVERY: number;
export const UNCONFIRMED_MS: number;
export const MAX_CODES: 20;
export const MAX_KINDS: 20;
export function errorCode(code: any): string;
export type ReportOptions = {
    app: string;
    version: string | (() => string);
    sync?: string | undefined;
    endpoint?: string | undefined;
    every?: number | undefined;
    storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined;
    send?: ((url: string, body: string) => any) | undefined;
    now?: (() => number) | undefined;
    onError?: ((e: any) => void) | undefined;
    byKind?: boolean | undefined;
};
export type ReportPayload = {
    v: 1;
    app: string;
    version: string;
    sync: string;
    unconfirmed: number;
    refused: number;
    conflicts: number;
    errors: Record<string, number>;
    held?: Record<string, number>;
};
