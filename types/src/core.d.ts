/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').AppSdk} AppSdk
 * @typedef {import('./types.js').SyncStatus} SyncStatus
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser
 */
/** @param {import('./app.js').AppOptions} options @param {{ load: () => Promise<AppSdk>, user: () => AppUser | null }} host */
export function createSyncCore(options: import("./app.js").AppOptions, { load, user }: {
    load: () => Promise<AppSdk>;
    user: () => AppUser | null;
}): {
    api: {
        open: (s: string) => Promise<void>;
        watch: (s: string, coll: string, cb: (list: Doc[], meta: any) => void) => () => void;
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
            watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void): () => void;
            drop(scope: string, coll: string, ids: string[]): Promise<void>;
            settle(scope: string): Promise<void>;
            tomb(scope: string, coll: string, id: any): any;
            stopAll(): Promise<void>;
            replan(): number;
            flush: () => Promise<any[]>;
        };
        queue: {
            activate: (email: string) => Promise<void>;
            save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
                ops?: any;
                meta?: any;
            }) => Promise<import("./writes.js").Doc>;
            restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
            overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
            retry: (key: string) => Promise<void>;
            archive: (key: string, { refused }?: {
                refused?: boolean;
            }) => Promise<void>;
            discard: (key: string) => Promise<void>;
            forget: () => Promise<void>;
            kick: () => void;
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
                watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void): () => void;
                drop(scope: string, coll: string, ids: string[]): Promise<void>;
                settle(scope: string): Promise<void>;
                tomb(scope: string, coll: string, id: any): any;
                stopAll(): Promise<void>;
                replan(): number;
                flush: () => Promise<any[]>;
            };
            queue: {
                activate: (email: string) => Promise<void>;
                save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
                    ops?: any;
                    meta?: any;
                }) => Promise<import("./writes.js").Doc>;
                restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
                overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
                retry: (key: string) => Promise<void>;
                archive: (key: string, { refused }?: {
                    refused?: boolean;
                }) => Promise<void>;
                discard: (key: string) => Promise<void>;
                forget: () => Promise<void>;
                kick: () => void;
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
        watch(scope: string, coll: string, cb: (list: import("./sync.js").Doc[], meta: SnapMeta) => void): () => void;
        drop(scope: string, coll: string, ids: string[]): Promise<void>;
        settle(scope: string): Promise<void>;
        tomb(scope: string, coll: string, id: any): any;
        stopAll(): Promise<void>;
        replan(): number;
        flush: () => Promise<any[]>;
    };
    queue: {
        activate: (email: string) => Promise<void>;
        save: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null, { ops, meta }?: {
            ops?: any;
            meta?: any;
        }) => Promise<import("./writes.js").Doc>;
        restore: (kind: string, email: string, record: import("./writes.js").Doc, base?: import("./writes.js").Doc | null) => Promise<import("./types.js").Doc>;
        overlay: (kind: string, email: string, list: import("./writes.js").Doc[]) => import("./writes.js").Doc[];
        retry: (key: string) => Promise<void>;
        archive: (key: string, { refused }?: {
            refused?: boolean;
        }) => Promise<void>;
        discard: (key: string) => Promise<void>;
        forget: () => Promise<void>;
        kick: () => void;
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
    startWatches: () => void;
    stopWatches: () => void;
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
