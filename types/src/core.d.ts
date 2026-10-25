/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').AppSdk} AppSdk
 * @typedef {import('./types.js').SyncStatus} SyncStatus
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser
 * @typedef {import('./types.js').Outbox} Outbox
 * @typedef {import('./types.js').CommitExtra} CommitExtra
 * @typedef {object} SyncCoreOptions the sync module's options (sync.js), with config's name, sdk and storage
 * @property {string} name the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`
 * @property {string[]} colls the collections synced
 * @property {(scope: string, coll: string) => (string | number)[]} path a collection's path segments
 * @property {() => Promise<AppSdk> | AppSdk} sdk the app's Firebase SDK, loaded once
 * @property {Record<string, import('./kinds.js').KindOption>} [kinds] save kinds -> collection, or { coll, path } (default: each coll is its own kind)
 * @property {Outbox} [outbox] the queue's durable store instead of createOutbox's
 * @property {any} [adapter] { listen, fetchOne, commit, clearCache } instead of the Firestore adapter
 * @property {(owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>} [commit] the app's own write instead of adapter.commit
 * @property {Partial<import('./firestore.js').FirestoreBackendOptions> & Record<string, any>} [backend] the Firestore adapter's options
 * @property {Record<string, any>} [hub] more options for createSyncHub
 * @property {Record<string, any>} [stores] more options for createStores
 * @property {Record<string, any>} [queue] more options for createWriteQueue
 * @property {(user: AppUser) => string} [scope] the scope opened at sign-in
 * @property {string[]} [public] (1.3.0) colls read with no account, in `public:*` scopes
 * @property {(err: { code: string, message?: string }, entry: Job) => any} [onRefused] 'archive' sets a refused save aside
 * @property {{ extra?: (() => Promise<any>) | null, keep?: string[] | (() => string[] | Promise<string[]>) }} [forget]
 * @property {import('./types.js').Report | null} [report] the nothing-lost report (createReport), opt-in
 * @property {any} [nav] the browser's navigator, for tests
 * @property {Pick<Storage, 'getItem' | 'setItem'> | null} [storage] where the origin's outbox list is kept (null: no registry)
 * @property {() => number} [now]
 * @property {number} [watchEvery] ms between watchdog checks (0: only on nudge())
 * @property {any} [win] the browser's window, for tests
 * @property {string} [device] this device's name as people know it, shown in conflict popups
 * @property {() => number} [outside] writes the app knows of outside the queue, not yet acknowledged (0.8.1)
 * @property {boolean} [wake] (0.8.3) online, pageshow and a page shown again nudge the watchdog and send what waits
 * @property {() => boolean} [quiet] deprecated (0.8.1: outside or track): false counts as one write outside the queue
 */
/** @param {SyncCoreOptions} options @param {{ load: () => Promise<AppSdk>, user: () => AppUser | null }} host */
export function createSyncCore(options: SyncCoreOptions, { load, user }: {
    load: () => Promise<AppSdk>;
    user: () => AppUser | null;
}): {
    api: {
        open: (s: string) => Promise<void>;
        watch: (s: string, coll: string, cb: (list: Doc[], meta: any) => void, options?: import("./types.js").WatchOptions) => () => void;
        save: (kind: string, s: string, record: Doc, base?: Doc | null, opts?: {
            ops?: any;
        }) => Promise<Doc>;
        flush: (ms?: number) => Promise<boolean>;
        status$: (fn: (st: SyncStatus) => void) => () => boolean;
        nudge: (event?: string) => boolean;
        relistens: () => number;
        facts: () => {
            persisted: boolean;
            confirmed: boolean;
            heardAt: number;
            inStepAt: number;
        };
        conflicts: (kind?: string) => {
            key: string;
            kind: string;
            id: string;
            at: number;
        }[];
        describe: (key: string, { timeZone }?: {
            timeZone?: string;
        }) => (ConflictView & {
            key: string;
            kind: string;
            id: string;
        }) | null;
        resolve: (key: string, choice: ConflictChoice) => Promise<import("./types.js").Doc>;
        hub: {
            watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void, own?: Listen | null): () => void;
            drop(scope: string, coll: string, ids: string[]): Promise<void>;
            settle(scope: string): Promise<void>;
            tomb(scope: string, coll: string, id: any): any;
            stopAll(): Promise<void>;
            stopScope(scope: string): Promise<void>;
            replan(): number;
            flush: () => Promise<any[]>;
        };
        queue: {
            activate: (email: string) => Promise<void>;
            save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
                ops?: any;
                meta? /** @param {string} [kind] @param {string} [id] @returns {number} */: any;
            }) => Promise<import("./writes.js").Doc>;
            restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
            overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
            retry: (key: string) => Promise<void>;
            archive: (key: string, { refused }?: {
                refused?: boolean;
            }) => Promise<void>;
            discard: (key: string) => Promise<void>;
            forget: () => Promise<void>;
            kick: () => Promise<void>;
            configure(config: Partial<QueueOptions>): void;
            onChange(fn: () => void): () => boolean;
            entries: () => import("./types.js").Job[];
            pending: () => number;
            attention: (kind?: string) => boolean;
            unsent: (kind: string, id: string) => boolean;
            conflicted: (kind: string, id: string) => boolean;
            settle(kind: string, ids: string[], ms?: number): Promise<boolean>;
            flush(ms?: number): Promise<boolean>;
            error: () => string;
            status(kind: string, id: string): import("./types.js").JobState | "";
            jobKey(kind: string, id: string): string;
            stateOf(key: string): import("./types.js").JobState | "";
            refused: (kind?: string) => import("./writes.js").Job[];
            finished(key: string): import("./writes.js").Job | null;
            lastSent(kind: string, id: string): {
                stamp: any;
                signature: string;
            } | null;
        };
        parts: {
            hub: {
                watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void, own?: Listen | null): () => void;
                drop(scope: string, coll: string, ids: string[]): Promise<void>;
                settle(scope: string): Promise<void>;
                tomb(scope: string, coll: string, id: any): any;
                stopAll(): Promise<void>;
                stopScope(scope: string): Promise<void>;
                replan(): number;
                flush: () => Promise<any[]>;
            };
            queue: {
                activate: (email: string) => Promise<void>;
                save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
                    ops?: any;
                    meta? /** @param {string} [kind] @param {string} [id] @returns {number} */: any;
                }) => Promise<import("./writes.js").Doc>;
                restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
                overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
                retry: (key: string) => Promise<void>;
                archive: (key: string, { refused }?: {
                    refused?: boolean;
                }) => Promise<void>;
                discard: (key: string) => Promise<void>;
                forget: () => Promise<void>;
                kick: () => Promise<void>;
                configure(config: Partial<QueueOptions>): void;
                onChange(fn: () => void): () => boolean;
                entries: () => import("./types.js").Job[];
                pending: () => number;
                attention: (kind?: string) => boolean;
                unsent: (kind: string, id: string) => boolean;
                conflicted: (kind: string, id: string) => boolean;
                settle(kind: string, ids: string[], ms?: number): Promise<boolean>;
                flush(ms?: number): Promise<boolean>;
                error: () => string;
                status(kind: string, id: string): import("./types.js").JobState | "";
                jobKey(kind: string, id: string): string;
                stateOf(key: string): import("./types.js").JobState | "";
                refused: (kind?: string) => import("./writes.js").Job[];
                finished(key: string): import("./writes.js").Job | null;
                lastSent(kind: string, id: string): {
                    stamp: any;
                    signature: string;
                } | null;
            };
            stores: {
                openStore: (scope: string, wait?: number) => Promise<Store>;
                wipeStores: (keep?: string | string[]) => Promise<void>;
                storeName: (scope: any) => string;
            };
            adapter: any;
            watchdog: {
                heard({ fromCache, hasPendingWrites }?: {
                    fromCache?: boolean | undefined;
                    hasPendingWrites?: boolean | undefined;
                }): void;
                opened(): void;
                event: () => import("./watchdog.js").Decision;
                check: () => import("./watchdog.js").Decision;
                stale: () => boolean;
            };
            registry: import("./types.js").Registry | null;
            outbox: import("./types.js").Outbox;
        };
        track: <T>(promise: Promise<T>, { kind, id }?: {
            kind?: string;
            id?: string;
        }) => Promise<T>;
        unsentOutside: (kind?: string, id?: string) => number;
        outsideSettled: (ms?: number) => Promise<boolean>;
        heard: (m?: import("./types.js").SnapMeta) => void;
        idle: () => boolean;
        copyOf: (kind: string, id: string) => Doc | null;
        lastSeen: (kind: string, id: string) => {
            stamp: any;
            signature: string;
        } | null;
        watchDoc: (where: string | (string | number)[], cb: (d: Doc | null, meta: any) => void, onError?: (e: any) => void) => () => void;
        reconnect: ({ why }?: {
            why?: string;
        }) => Promise<boolean>;
    };
    hub: {
        watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void, own?: Listen | null): () => void;
        drop(scope: string, coll: string, ids: string[]): Promise<void>;
        settle(scope: string): Promise<void>;
        tomb(scope: string, coll: string, id: any): any;
        stopAll(): Promise<void>;
        stopScope(scope: string): Promise<void>;
        replan(): number;
        flush: () => Promise<any[]>;
    };
    queue: {
        activate: (email: string) => Promise<void>;
        save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
            ops?: any;
            meta? /** @param {string} [kind] @param {string} [id] @returns {number} */: any;
        }) => Promise<import("./writes.js").Doc>;
        restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
        overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
        retry: (key: string) => Promise<void>;
        archive: (key: string, { refused }?: {
            refused?: boolean;
        }) => Promise<void>;
        discard: (key: string) => Promise<void>;
        forget: () => Promise<void>;
        kick: () => Promise<void>;
        configure(config: Partial<QueueOptions>): void;
        onChange(fn: () => void): () => boolean;
        entries: () => import("./types.js").Job[];
        pending: () => number;
        attention: (kind?: string) => boolean;
        unsent: (kind: string, id: string) => boolean;
        conflicted: (kind: string, id: string) => boolean;
        settle(kind: string, ids: string[], ms?: number): Promise<boolean>;
        flush(ms?: number): Promise<boolean>;
        error: () => string;
        status(kind: string, id: string): import("./types.js").JobState | "";
        jobKey(kind: string, id: string): string;
        stateOf(key: string): import("./types.js").JobState | "";
        refused: (kind?: string) => import("./writes.js").Job[];
        finished(key: string): import("./writes.js").Job | null;
        lastSent(kind: string, id: string): {
            stamp: any;
            signature: string;
        } | null;
    };
    stores: {
        openStore: (scope: string, wait?: number) => Promise<Store>;
        wipeStores: (keep?: string | string[]) => Promise<void>;
        storeName: (scope: any) => string;
    };
    adapter: any;
    outbox: import("./types.js").Outbox;
    registry: import("./types.js").Registry | null;
    saving: Set<Promise<any>>;
    statusNow: () => import("./types.js").SyncStatus;
    tell: (force?: boolean) => void;
    signedIn: (u: AppUser, scopeOf: ((user: AppUser) => string) | null) => Promise<void>;
    reset: () => void;
    close: () => void;
    addDoc: (where: string | (string | number)[], cb: (d: Doc | null, meta: any) => void, onError?: (e: any) => void) => {
        segments: string[];
        cb: (d: Doc | null, meta: any) => void;
        onError: ((e: any) => void) | null;
        last: string;
        failed: boolean;
        off: (() => void) | null;
    };
    dropDoc: (w: {
        segments: string[];
        cb: (d: Doc | null, meta: any) => void;
        onError: ((e: any) => void) | null;
        last: string;
        failed: boolean;
        off: (() => void) | null;
    }) => void;
    startWatches: (only?: Set<{
        scope: string;
        coll: string;
        cb: (list: Doc[], meta: any) => void;
        view: ((list: Doc[]) => Doc[]) | null;
        listen: import("./types.js").Listen | null;
        off: ReturnType<typeof watchSaved> | null;
    } | {
        segments: string[];
        cb: (d: Doc | null, meta: any) => void;
        onError: ((e: any) => void) | null;
        last: string;
        failed: boolean;
        off: (() => void) | null;
    }> | null) => void;
    stopWatches: (keepPublic?: boolean) => void;
    stopPublic: () => Promise<void>;
    scope: () => string;
    watching: () => number;
};
export type Doc = import("./types.js").Doc;
export type Job = import("./types.js").Job;
export type AppSdk = import("./types.js").AppSdk;
export type SyncStatus = import("./types.js").SyncStatus;
export type ConflictChoice = import("./types.js").ConflictChoice;
export type ConflictView = import("./types.js").ConflictView;
export type AppUser = {
    uid: string;
    email: string;
    name: string;
    photo: string;
    verified: boolean;
};
export type Outbox = import("./types.js").Outbox;
export type CommitExtra = import("./types.js").CommitExtra;
/**
 * the sync module's options (sync.js), with config's name, sdk and storage
 */
export type SyncCoreOptions = {
    /**
     * the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`
     */
    name: string;
    /**
     * the collections synced
     */
    colls: string[];
    /**
     * a collection's path segments
     */
    path: (scope: string, coll: string) => (string | number)[];
    /**
     * the app's Firebase SDK, loaded once
     */
    sdk: () => Promise<AppSdk> | AppSdk;
    /**
     * save kinds -> collection, or { coll, path } (default: each coll is its own kind)
     */
    kinds?: Record<string, import("./kinds.js").KindOption> | undefined;
    /**
     * the queue's durable store instead of createOutbox's
     */
    outbox?: import("./types.js").Outbox | undefined;
    /**
     * { listen, fetchOne, commit, clearCache } instead of the Firestore adapter
     */
    adapter?: any;
    /**
     * the app's own write instead of adapter.commit
     */
    commit?: ((owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>) | undefined;
    /**
     * the Firestore adapter's options
     */
    backend?: (Partial<import("./firestore.js").FirestoreBackendOptions> & Record<string, any>) | undefined;
    /**
     * more options for createSyncHub
     */
    hub?: Record<string, any> | undefined;
    /**
     * more options for createStores
     */
    stores?: Record<string, any> | undefined;
    /**
     * more options for createWriteQueue
     */
    queue?: Record<string, any> | undefined;
    /**
     * the scope opened at sign-in
     */
    scope?: ((user: AppUser) => string) | undefined;
    /**
     * (1.3.0) colls read with no account, in `public:*` scopes
     */
    public?: string[] | undefined;
    /**
     * 'archive' sets a refused save aside
     */
    onRefused?: ((err: {
        code: string;
        message?: string;
    }, entry: Job) => any) | undefined;
    forget?: {
        extra?: (() => Promise<any>) | null;
        keep?: string[] | (() => string[] | Promise<string[]>);
    } | undefined;
    /**
     * the nothing-lost report (createReport), opt-in
     */
    report?: import("./types.js").Report | null | undefined;
    /**
     * the browser's navigator, for tests
     */
    nav?: any;
    /**
     * where the origin's outbox list is kept (null: no registry)
     */
    storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined;
    now?: (() => number) | undefined;
    /**
     * ms between watchdog checks (0: only on nudge())
     */
    watchEvery?: number | undefined;
    /**
     * the browser's window, for tests
     */
    win?: any;
    /**
     * this device's name as people know it, shown in conflict popups
     */
    device?: string | undefined;
    /**
     * writes the app knows of outside the queue, not yet acknowledged (0.8.1)
     */
    outside?: (() => number) | undefined;
    /**
     * (0.8.3) online, pageshow and a page shown again nudge the watchdog and send what waits
     */
    wake?: boolean | undefined;
    /**
     * deprecated (0.8.1: outside or track): false counts as one write outside the queue
     */
    quiet?: (() => boolean) | undefined;
};
import { watchSaved } from './writes.js';
