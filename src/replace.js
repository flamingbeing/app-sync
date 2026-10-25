// replaceRecord (1.1.0): a merge function (the Firestore adapter's merge option) that writes the save over the
// server's copy whole: last write wins by record, never a conflict. For collections one person edits as a whole,
// e.g. backend: { merge: { '*': replaceRecord } }.
/** @typedef {import('./types.js').Doc} Doc */

/** @param {Doc | null} _current @param {Doc} record @returns {Doc} */
export const replaceRecord = (_current, record) => record;
