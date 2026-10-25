// Save kinds (sync({ kinds })): { [kind]: coll } or, 1.2.0, { [kind]: { coll, path } }: a kind saved to a path of its
// own, outside the scope (path(scope, coll, record) -> the collection's path segments, asked at each send, so a job
// sent after a reload goes to the same place). Default: each coll is its own kind.
/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {(scope: string, coll: string, record: Doc) => (string | number)[]} KindPath
 * @typedef {string | { coll: string, path: KindPath }} KindOption
 */

/** @param {Record<string, KindOption> | undefined} kinds @param {string[]} colls */
export function kindMap(kinds, colls) {
  const given = kinds || Object.fromEntries(colls.map(c => [c, c]));
  /** @type {Record<string, string>} */
  const collOfKind = {};
  /** @type {Record<string, KindPath>} */
  const pathOfKind = {};
  for (const [kind, k] of Object.entries(given)) {
    if (typeof k === 'string') { collOfKind[kind] = k; continue; }
    if (!k || typeof k.coll !== 'string' || typeof k.path !== 'function') throw new Error('sync: kinds.' + kind + ' is a collection or { coll, path }');
    collOfKind[kind] = k.coll; pathOfKind[kind] = k.path;
  }
  return {
    /** kind -> its collection, as the hub's bin feed reads it */
    colls: collOfKind,
    /** @param {string} kind */
    collOf: kind => collOfKind[kind] || kind,
    /** @param {string} coll */
    kindOf: coll => Object.keys(collOfKind).find(k => collOfKind[k] === coll) || coll,
    /** @param {string} kind @param {string} scope @param {Doc} record @returns {(string | number)[] | null} null: the scope's path */
    pathOf: (kind, scope, record) => Object.hasOwn(pathOfKind, kind) ? pathOfKind[kind](scope, collOfKind[kind], record) : null,
  };
}
