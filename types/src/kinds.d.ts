/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {(scope: string, coll: string, record: Doc) => (string | number)[]} KindPath
 * @typedef {string | { coll: string, path: KindPath }} KindOption
 */
/** @param {Record<string, KindOption> | undefined} kinds @param {string[]} colls */
export function kindMap(kinds: Record<string, KindOption> | undefined, colls: string[]): {
    /** kind -> its collection, as the hub's bin feed reads it */
    colls: Record<string, string>;
    /** @param {string} kind */
    collOf: (kind: string) => string;
    /** @param {string} coll */
    kindOf: (coll: string) => string;
    /** @param {string} kind @param {string} scope @param {Doc} record @returns {(string | number)[] | null} null: the scope's path */
    pathOf: (kind: string, scope: string, record: Doc) => (string | number)[] | null;
};
export type Doc = import("./types.js").Doc;
export type KindPath = (scope: string, coll: string, record: Doc) => (string | number)[];
export type KindOption = string | {
    coll: string;
    path: KindPath;
};
