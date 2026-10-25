/** @typedef {import('../auth.js').AuthMethod} AuthMethod */
/** @param {{ url: string, fetch?: typeof fetch }} [options] @returns {AuthMethod} */
export function passcode(options?: {
    url: string;
    fetch?: typeof fetch;
}): AuthMethod;
export type AuthMethod = import("../auth.js").AuthMethod;
