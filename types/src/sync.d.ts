/**
 * @param {CollMeta | null | undefined} meta
 * @param {number} now
 * @param {number} [newest]
 * @returns {{ full: boolean, since: number | null }}
 */
export function plan(meta: CollMeta | null | undefined, now: number, newest?: number): {
    full: boolean;
    since: number | null;
};
/**
 * @param {CollMeta | null | undefined} meta
 * @param {number} now
 * @returns {{ full: boolean, since: number | null }}
 */
export function planServer(meta: CollMeta | null | undefined, now: number): {
    full: boolean;
    since: number | null;
};
/**
 * @param {Map<string, Doc>} docs
 * @param {Change[] | null | undefined} changes
 * @param {Record<string, number>} [gone]
 * @param {(id: string) => boolean} [sure]
 * @returns {{ put: Doc[], del: string[], verify: string[] }}
 */
export function applyChanges(docs: Map<string, Doc>, changes: Change[] | null | undefined, gone?: Record<string, number>, sure?: (id: string) => boolean): {
    put: Doc[];
    del: string[];
    verify: string[];
};
/**
 * @param {Map<string, Doc>} docs
 * @param {Doc[]} list
 * @returns {{ put: Doc[], del: string[] }}
 */
export function replaceAll(docs: Map<string, Doc>, list: Doc[]): {
    put: Doc[];
    del: string[];
};
/**
 * @param {Map<string, Doc>} docs
 * @param {Record<string, number>} gone
 * @param {Tomb[] | null | undefined} tombs
 * @returns {string[]} the ids removed
 */
export function applyTombs(docs: Map<string, Doc>, gone: Record<string, number>, tombs: Tomb[] | null | undefined): string[];
/**
 * @param {Record<string, number> | null | undefined} later
 * @param {Tomb[] | null | undefined} tombs
 * @returns {Record<string, number>}
 */
export function deferTombs(later: Record<string, number> | null | undefined, tombs: Tomb[] | null | undefined): Record<string, number>;
/**
 * @param {Map<string, Doc>} docs
 * @param {CollMeta} meta
 * @param {string[] | null} ids
 * @param {(id: string) => boolean} holding
 * @returns {{ meta: CollMeta, del: string[] } | null}
 */
export function settleTombs(docs: Map<string, Doc>, meta: CollMeta, ids: string[] | null, holding: (id: string) => boolean): {
    meta: CollMeta;
    del: string[];
} | null;
/**
 * @param {any[] | null | undefined} entries
 * @param {Record<string, string>} [kinds]
 * @returns {Record<string, Tomb[]>}
 */
export function binTombs(entries: any[] | null | undefined, kinds?: Record<string, string>): Record<string, Tomb[]>;
/**
 * @param {Map<string, Doc>} docs
 * @param {Record<string, number>} gone
 * @param {ExpireRule | undefined} rule
 * @param {number} now
 * @returns {string[]}
 */
export function expireDocs(docs: Map<string, Doc>, gone: Record<string, number>, rule: ExpireRule | undefined, now: number): string[];
/**
 * @param {string[]} ids
 * @param {(id: string) => Promise<any>} write
 * @param {number} [size]
 * @returns {Promise<string[]>}
 */
export function eachSettled(ids: string[], write: (id: string) => Promise<any>, size?: number): Promise<string[]>;
/**
 * @typedef {object} CollectionSyncOptions
 * @property {string} scope
 * @property {string} coll
 * @property {EngineStore} store
 * @property {Listen} listen
 * @property {FetchOne | null} [fetchOne]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {'skip' | 'full'} [unstamped]
 * @property {ExpireRule} [expire]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 * @property {(id: string) => boolean} [unsent]
 * @property {(id: string, doc: Doc) => void} [onLeave]
 */
/** @param {CollectionSyncOptions} options */
export function createCollectionSync({ scope, coll, store, listen, fetchOne, now, onError, unstamped, expire, stampMode, serverField, unsent, onLeave }: CollectionSyncOptions): {
    /** @param {(list: Doc[], meta: SnapMeta) => void} cb @returns {() => boolean} */
    subscribe(cb: (list: Doc[], meta: SnapMeta) => void): () => boolean;
    readonly size: number;
    ready: Promise<void>;
    replan(): boolean;
    /** @param {string[]} ids @param {number} [at] */
    drop(ids: string[], at?: number): Promise<void>;
    /** @param {Tomb[] | null | undefined} list */
    tombs(list: Tomb[] | null | undefined): Promise<void>;
    /** @param {string[] | null} [ids] @returns {Promise<string[]>} */
    settle(ids?: string[] | null): Promise<string[]>;
    /** @param {string} id */
    tomb: (id: string) => number;
    waiting: () => string[];
    wiped(): Promise<any>;
    stop(): Promise<any>;
    flush: () => Promise<any>;
};
/**
 * @typedef {object} TombFeedOptions
 * @property {string} scope
 * @property {EngineStore} store
 * @property {Listen} listen
 * @property {(byColl: Record<string, Tomb[]>) => Promise<void>} apply
 * @property {Record<string, string>} [kinds]
 * @property {string} [coll]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 */
/** @param {TombFeedOptions} options */
export function createTombFeed({ scope, store, listen, apply, kinds, coll, now, onError, stampMode, serverField }: TombFeedOptions): {
    ready: Promise<void>;
    replan(): boolean;
    wiped(): Promise<any>;
    stop(): Promise<any>;
    flush: () => Promise<any>;
};
/**
 * @typedef {object} SyncHubOptions
 * @property {(scope: string) => Promise<import('./types.js').Store>} openStore
 * @property {Listen} listen
 * @property {FetchOne | null} [fetchOne]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {number} [grace]
 * @property {string | null} [bin]
 * @property {Record<string, string>} [binKinds]
 * @property {Record<string, Record<string, string>>} [feeds]
 * @property {'skip' | 'full'} [unstamped]
 * @property {Record<string, { field: string, after: number }>} [expire]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 * @property {(scope: string, coll: string, id: string) => boolean} [unsent]
 * @property {(scope: string, coll: string, id: string, doc: Doc) => void} [onLeave]
 */
/** @param {SyncHubOptions} options */
export function createSyncHub({ openStore, listen, fetchOne, now, onError, grace, bin, binKinds, feeds: extraFeeds, unstamped, expire, stampMode, serverField, unsent, onLeave }: SyncHubOptions): {
    /** @param {string} scope @param {string} coll @param {(list: Doc[], meta: SnapMeta) => void} cb @param {Listen | null} [own] @returns {() => void} */
    watch(scope: string, coll: string, cb: (list: Doc[], meta: SnapMeta) => void, own?: Listen | null): () => void;
    /** @param {string} scope @param {string} coll @param {string[]} ids @returns {Promise<void>} */
    drop(scope: string, coll: string, ids: string[]): Promise<void>;
    /** @param {string} scope */
    settle(scope: string): Promise<void>;
    /** @param {string} scope @param {string} coll @param {any} id */
    tomb(scope: string, coll: string, id: any): any;
    stopAll(): Promise<void>;
    /** @param {string} scope @returns {Promise<void>} */
    stopScope(scope: string): Promise<void>;
    replan(): number;
    flush: () => Promise<any[]>;
};
/**
 * @param {{ replan: () => number }} hub
 * @param {any} [win]
 * @param {{ every?: number }} [options]
 * @returns {() => void} stops it
 */
export function replanOnWake(hub: {
    replan: () => number;
}, win?: any, { every }?: {
    every?: number;
}): () => void;
/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Stamp} Stamp
 * @typedef {import('./types.js').CollMeta} CollMeta
 * @typedef {import('./types.js').Change} Change
 * @typedef {import('./types.js').Snapshot} Snapshot
 * @typedef {import('./types.js').SnapMeta} SnapMeta
 * @typedef {import('./types.js').Tomb} Tomb
 * @typedef {import('./types.js').Listen} Listen
 * @typedef {import('./types.js').FetchOne} FetchOne
 * @typedef {import('./types.js').EngineStore} EngineStore
 * @typedef {import('./types.js').ExpireRule} ExpireRule
 */
export const SKEW: number;
export const FULL_EVERY: number;
export const GONE_KEEP: number;
export const REPLAN_EVERY: 3600000;
export function timeOf(v: any): number;
export function leaveEntry(kind: string, record: Doc, at?: Stamp): {
    id: string;
    kind: string;
    data: {
        id: string;
        updatedAt: Stamp | undefined;
    };
    deletedAt: Stamp;
};
export function dropTombs(docs: Map<string, Doc>, ids: any[], at: number): Tomb[];
export function pruneGone(gone: Record<string, number> | null | undefined, now: number): Record<string, number>;
export const GRACE: 1500;
export type CollectionSyncOptions = {
    scope: string;
    coll: string;
    store: EngineStore;
    listen: Listen;
    fetchOne?: import("./types.js").FetchOne | null | undefined;
    now?: (() => number) | undefined;
    onError?: ((e: any) => void) | undefined;
    unstamped?: "skip" | "full" | undefined;
    expire?: import("./types.js").ExpireRule | undefined;
    stampMode?: "client" | "server" | undefined;
    serverField?: string | undefined;
    unsent?: ((id: string) => boolean) | undefined;
    onLeave?: ((id: string, doc: Doc) => void) | undefined;
};
export type TombFeedOptions = {
    scope: string;
    store: EngineStore;
    listen: Listen;
    apply: (byColl: Record<string, Tomb[]>) => Promise<void>;
    kinds?: Record<string, string> | undefined;
    coll?: string | undefined;
    now?: (() => number) | undefined;
    onError?: ((e: any) => void) | undefined;
    stampMode?: "client" | "server" | undefined;
    serverField?: string | undefined;
};
export type SyncHubOptions = {
    openStore: (scope: string) => Promise<import("./types.js").Store>;
    listen: Listen;
    fetchOne?: import("./types.js").FetchOne | null | undefined;
    now?: (() => number) | undefined;
    onError?: ((e: any) => void) | undefined;
    grace?: number | undefined;
    bin?: string | null | undefined;
    binKinds?: Record<string, string> | undefined;
    feeds?: Record<string, Record<string, string>> | undefined;
    unstamped?: "skip" | "full" | undefined;
    expire?: Record<string, {
        field: string;
        after: number;
    }> | undefined;
    stampMode?: "client" | "server" | undefined;
    serverField?: string | undefined;
    unsent?: ((scope: string, coll: string, id: string) => boolean) | undefined;
    onLeave?: ((scope: string, coll: string, id: string, doc: Doc) => void) | undefined;
};
export type Doc = import("./types.js").Doc;
export type Stamp = import("./types.js").Stamp;
export type CollMeta = import("./types.js").CollMeta;
export type Change = import("./types.js").Change;
export type Snapshot = import("./types.js").Snapshot;
export type SnapMeta = import("./types.js").SnapMeta;
export type Tomb = import("./types.js").Tomb;
export type Listen = import("./types.js").Listen;
export type FetchOne = import("./types.js").FetchOne;
export type EngineStore = import("./types.js").EngineStore;
export type ExpireRule = import("./types.js").ExpireRule;
