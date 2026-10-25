/** @typedef {import('../auth.js').AuthMethod} AuthMethod */
/** @returns {AuthMethod} */
export function password(): AuthMethod;
export type AuthMethod = import("../auth.js").AuthMethod;
