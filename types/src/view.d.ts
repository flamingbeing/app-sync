/** @typedef {import('./types.js').Doc} Doc @typedef {import('./types.js').WatchOptions} WatchOptions */
/** @param {WatchOptions} [options] @returns {((list: Doc[]) => Doc[]) | null} null: the whole list */
export function viewOf({ query, limit }?: WatchOptions): ((list: Doc[]) => Doc[]) | null;
export type Doc = import("./types.js").Doc;
export type WatchOptions = import("./types.js").WatchOptions;
