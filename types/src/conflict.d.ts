/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').CodedError} CodedError
 * @typedef {import('./types.js').HeldSave} HeldSave
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ counters?: string[], skip?: string[], merge?: ((current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc) | null }} MergeOptions
 */
/** @param {any} record @returns {string} */
export function recordSignature(record: any): string;
/**
 * @param {Doc | null} current
 * @param {Doc | null} desired
 * @param {Doc | null} base
 * @param {string} [message]
 * @returns {boolean}
 */
export function checkWrite(current: Doc | null, desired: Doc | null, base: Doc | null, message?: string): boolean;
/** @param {string} path @returns {string[]} */
export function keysOf(path: string): string[];
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @returns {Doc}
 */
export function mergeFields(current: Doc | null, record: Doc | null, base: Doc | null): Doc;
/** @param {Record<string, any> | null | undefined} merge @param {string} coll @returns {((current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc) | null} */
export function mergeOf(merge: Record<string, any> | null | undefined, coll: string): ((current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc) | null;
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @param {MergeOptions & { pick?: ((path: string) => 'mine' | 'theirs') | null }} [options]
 * @returns {Doc}
 */
export function mergeHeld(current: Doc | null, record: Doc | null, base: Doc | null, { counters, skip, pick }?: MergeOptions & {
    pick?: ((path: string) => "mine" | "theirs") | null;
}): Doc;
/**
 * @param {Doc | null} current
 * @param {Doc | null} mine
 * @param {Doc | null} merged
 * @param {Doc | null} base
 * @param {{ skip?: string[] }} [options]
 * @returns {string[]}
 */
export function mergeClashes(current: Doc | null, mine: Doc | null, merged: Doc | null, base: Doc | null, { skip }?: {
    skip?: string[];
}): string[];
/**
 * @param {Doc | null} current
 * @param {Doc} record
 * @param {Doc | null} base
 * @param {(current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc} merge
 * @param {any} ops
 * @param {{ skip?: string[] }} [options]
 * @returns {{ mine: Doc, merged: Doc, fields: string[] }}
 */
export function mergeFnClashes(current: Doc | null, record: Doc, base: Doc | null, merge: (current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc, ops: any, options?: {
    skip?: string[];
}): {
    mine: Doc;
    merged: Doc;
    fields: string[];
};
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @param {MergeOptions} [options]
 * @returns {string[]}
 */
export function clashingFields(current: Doc | null, record: Doc | null, base: Doc | null, options?: MergeOptions): string[];
/** @param {number | string} ms @param {string} [timeZone] @returns {string} */
export function whenText(ms: number | string, timeZone?: string): string;
/**
 * @param {HeldSave} held
 * @param {MergeOptions & { edits?: string | null, me?: { by?: string, device?: string }, timeZone?: string }} [options]
 * @returns {ConflictView}
 */
export function describeConflict({ record, base, remote, at, ops }: HeldSave, { counters, skip, edits, me, timeZone, merge }?: MergeOptions & {
    edits?: string | null;
    me?: {
        by?: string;
        device?: string;
    };
    timeZone?: string;
}): ConflictView;
/**
 * @param {HeldSave} held
 * @param {ConflictChoice} choice
 * @param {MergeOptions} [options]
 * @returns {Doc}
 */
export function resolvedRecord({ record, base, remote, ops }: HeldSave, choice: ConflictChoice, { counters, skip, merge }?: MergeOptions): Doc;
export function pathOf(keys: string[]): string;
export type Doc = import("./types.js").Doc;
export type CodedError = import("./types.js").CodedError;
export type HeldSave = import("./types.js").HeldSave;
export type ConflictChoice = import("./types.js").ConflictChoice;
export type ConflictView = import("./types.js").ConflictView;
export type MergeOptions = {
    counters?: string[];
    skip?: string[];
    merge?: ((current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc) | null;
};
