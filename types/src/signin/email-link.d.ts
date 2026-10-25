/** @typedef {import('../auth.js').AuthMethod} AuthMethod */
/** @param {{ url?: string, win?: any }} [options] @returns {AuthMethod} */
export function emailLink(options?: {
    url?: string;
    win?: any;
}): AuthMethod;
export type AuthMethod = import("../auth.js").AuthMethod;
