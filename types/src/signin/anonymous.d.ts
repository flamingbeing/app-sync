/** @typedef {import('../auth.js').AuthMethod} AuthMethod */
/** @returns {AuthMethod} */
export function anonymous(): AuthMethod;
export type AuthMethod = import("../auth.js").AuthMethod;
