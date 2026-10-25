/**
 * @typedef {object} ForgetOptions
 * @property {{ stopAll: () => Promise<void> }} [hub]
 * @property {{ wipeStores: (keep?: string[]) => Promise<void> }} [stores]
 * @property {{ forget: () => Promise<void> }} [queue]
 * @property {() => Promise<boolean | void>} [proceed]
 * @property {string[] | (() => string[] | Promise<string[]>)} [keep]
 * @property {(() => Promise<any>) | null} [clearBackendCache]
 * @property {(() => Promise<any>) | null} [extra]
 * @property {number} [timeout]
 */
/**
 * @param {ForgetOptions} [options]
 * @returns {Promise<{ wiped: boolean, failed: string[] }>}
 */
export function forgetDevice({ hub, stores, queue, proceed, keep, clearBackendCache, extra, timeout }?: ForgetOptions): Promise<{
    wiped: boolean;
    failed: string[];
}>;
export const FORGET_TIMEOUT: 3000;
export type ForgetOptions = {
    hub?: {
        stopAll: () => Promise<void>;
    } | undefined;
    stores?: {
        wipeStores: (keep?: string[]) => Promise<void>;
    } | undefined;
    queue?: {
        forget: () => Promise<void>;
    } | undefined;
    proceed?: (() => Promise<boolean | void>) | undefined;
    keep?: string[] | (() => string[] | Promise<string[]>) | undefined;
    clearBackendCache?: (() => Promise<any>) | null | undefined;
    extra?: (() => Promise<any>) | null | undefined;
    timeout?: number | undefined;
};
