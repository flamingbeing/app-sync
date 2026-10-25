// A watch's view (1.1.0): watch(scope, coll, cb, { query, limit }) hands cb only the records whose fields equal
// query's (===), the first limit of them in the list's order. It narrows what cb gets, never the device copy or what
// the listener reads.
/** @typedef {import('./types.js').Doc} Doc @typedef {import('./types.js').WatchOptions} WatchOptions */

/** @param {WatchOptions} [options] @returns {((list: Doc[]) => Doc[]) | null} null: the whole list */
export function viewOf({ query, limit } = {}) {
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('watch: limit must be a whole number above 0');
  if (!query && limit === undefined) return null;
  const fields = Object.entries(query || {});
  /** @param {Doc} d */
  const matches = d => fields.every(([k, v]) => d[k] === v);
  return list => list.filter(matches).slice(0, limit);
}
