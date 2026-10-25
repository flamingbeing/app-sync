/** @param {QueueOptions} options */
export function createWriteQueue({ store, backend, getOwner, normalize, online, delay, notice, sendTimeout, labels, otherPending, registry, report, ignore, field, engine }: QueueOptions): {
    activate: (email: string) => Promise<void>;
    save: (kind: string, email: string, record: Doc, base?: Doc | null, { ops, meta }?: {
        ops?: any;
        meta?: any;
    }) => Promise<Doc>;
    restore: (kind: string, email: string, record: Doc, base?: Doc | null) => Promise<import("./types.js").Doc>;
    overlay: (kind: string, email: string, list: Doc[]) => Doc[];
    retry: (key: string) => Promise<void>;
    archive: (key: string, { refused }?: {
        refused?: boolean;
    }) => Promise<void>;
    discard: (key: string) => Promise<void>;
    forget: () => Promise<void>;
    kick: () => void;
    /** @param {Partial<QueueOptions>} config */
    configure(config: Partial<QueueOptions>): void;
    /** @param {() => void} fn */
    onChange(fn: () => void): () => boolean;
    entries: () => import("./types.js").Job[];
    pending: () => number;
    /** @param {string} [kind] */
    attention: (kind?: string) => boolean;
    /** @param {string} kind @param {string} id */
    unsent: (kind: string, id: string) => boolean;
    /** @param {string} kind @param {string} id */
    conflicted: (kind: string, id: string) => boolean;
    /** @param {string} kind @param {string[]} ids @param {number} [ms] */
    settle(kind: string, ids: string[], ms?: number): Promise<boolean>;
    flush(ms?: number): Promise<boolean>;
    error: () => string;
    /** @param {string} kind @param {string} id */
    status(kind: string, id: string): import("./types.js").JobState | "";
    /** @param {string} kind @param {string} id */
    jobKey(kind: string, id: string): string;
    /** @param {string} key */
    stateOf(key: string): import("./types.js").JobState | "";
    /** @param {string} [kind] @returns {Job[]} */
    refused: (kind?: string) => Job[];
    /** @param {string} key @returns {Job | null} */
    finished(key: string): Job | null;
    /** @param {string} kind @param {string} id @returns {{ stamp: any, signature: string } | null} */
    lastSent(kind: string, id: string): {
        stamp: any;
        signature: string;
    } | null;
};
/**
 * @param {{ hub: { watch: (scope: string, coll: string, cb: (list: Doc[], meta: import('./types.js').SnapMeta) => void) => () => void },
 *   queue: ReturnType<typeof createWriteQueue>, scope: string, coll: string, kind: string, owner?: string,
 *   view?: ((list: Doc[]) => Doc[]) | null }} options   view (1.1.0): view.js's, what cb gets of the list
 * @param {(list: Doc[], meta: import('./types.js').WatchMeta) => void} cb
 * @returns {(() => void) & { copyOf: (id: string) => Doc | null, seen: (id: string) => Doc | null }}
 */
export function watchSaved({ hub, queue, scope, coll, kind, owner, view }: {
    hub: {
        watch: (scope: string, coll: string, cb: (list: Doc[], meta: import("./types.js").SnapMeta) => void) => () => void;
    };
    queue: ReturnType<typeof createWriteQueue>;
    scope: string;
    coll: string;
    kind: string;
    owner?: string;
    view?: ((list: Doc[]) => Doc[]) | null;
}, cb: (list: Doc[], meta: import("./types.js").WatchMeta) => void): (() => void) & {
    copyOf: (id: string) => Doc | null;
    seen: (id: string) => Doc | null;
};
export const SEND_TIMEOUT: 30000;
export const JOB_FORMAT: 1;
export const JOB_STATES: readonly string[];
export type Doc = import("./types.js").Doc;
export type Job = import("./types.js").Job;
export type JobState = import("./types.js").JobState;
export type CodedError = import("./types.js").CodedError;
export type QueueOptions = import("./types.js").QueueOptions;
