/** @param {any} err @returns {'quota' | 'state' | null} */
export function cacheFailure(err: any): "quota" | "state" | null;
/**
 * @param {any} F
 * @param {CacheOptions} [options]
 * @returns {{ db: any, cache: any, mode: CacheMode, failed: (err: any) => CacheFailed, reset: () => void }}
 */
export function firestoreCache(F: any, { app, settings, report, storage, key }?: CacheOptions): {
    db: any;
    cache: any;
    mode: CacheMode;
    failed: (err: any) => CacheFailed;
    reset: () => void;
};
/**
 * @typedef {'multi' | 'single' | 'memory'} CacheMode
 * @typedef {{ app?: any, settings?: object, report?: { error?: (code: string) => void } | null, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, key?: string }} CacheOptions
 * @typedef {{ changed: boolean, mode: CacheMode, code: string | null }} CacheFailed
 */
export const CACHE_KEY: "app-sync-cache";
/** @type {CacheMode[]} */
export const CACHE_MODES: CacheMode[];
export type CacheMode = "multi" | "single" | "memory";
export type CacheOptions = {
    app?: any;
    settings?: object;
    report?: {
        error?: (code: string) => void;
    } | null;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    key?: string;
};
export type CacheFailed = {
    changed: boolean;
    mode: CacheMode;
    code: string | null;
};
