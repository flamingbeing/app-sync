/**
 * @deprecated 0.9.0: use the modules, `createApp({ config, modules })` from app.js with auth.js (sync and update follow
 * in 0.9.x); this one-object createApp is removed in 1.0.0-rc.1. Apps pinned to 0.x keep it.
 * @param {AppOptions} options
 */
export function createApp(options?: AppOptions): {
    open: (s: string) => Promise<void>;
    watch: (s: string, coll: string, cb: (list: import("./core.js").Doc[], meta: any) => void) => () => void;
    save: (kind: string, s: string, record: import("./core.js").Doc, base?: import("./core.js").Doc | null, opts?: {
        ops?: any;
    }) => Promise<import("./core.js").Doc>;
    flush: (ms?: number) => Promise<boolean>;
    status$: (fn: (st: import("./core.js").SyncStatus) => void) => () => boolean;
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
    }) => (import("./core.js").ConflictView & {
        key: string;
        kind: string;
        id: string;
    }) | null;
    resolve: (key: string, choice: import("./core.js").ConflictChoice) => Promise<import("./types.js").Doc>;
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
    copyOf: (kind: string, id: string) => import("./core.js").Doc | null;
    lastSeen: (kind: string, id: string) => {
        stamp: any;
        signature: string;
    } | null;
    watchDoc: (where: string | (string | number)[], cb: (d: import("./core.js").Doc | null, meta: any) => void, onError?: (e: any) => void) => () => void;
    reconnect: ({ why }?: {
        why?: string;
    }) => Promise<boolean>;
    signIn: ({ hint, popupOnly, redirectFirst: redirect }?: {
        hint?: string;
        popupOnly?: boolean;
        redirectFirst?: boolean;
    }) => Promise<any>;
    signOut: ({ wait, force, before }?: {
        wait?: number;
        force?: boolean;
        before?: (() => any) | null;
    }) => Promise<{
        ok: boolean;
        reason: "" | "unsent" | "refused" | "changed";
        reload: boolean;
        failed: string[];
    }>;
    onUser: (cb: (user: AppUser | null) => void) => Promise<any>;
    user: () => AppUser | null;
    refreshClaims: () => Promise<void>;
};
export type Doc = import("./types.js").Doc;
export type Job = import("./types.js").Job;
export type AppSdk = import("./types.js").AppSdk;
export type SyncStatus = import("./types.js").SyncStatus;
export type ConflictChoice = import("./types.js").ConflictChoice;
export type ConflictView = import("./types.js").ConflictView;
export type Outbox = import("./types.js").Outbox;
export type CommitExtra = import("./types.js").CommitExtra;
export type AppUser = {
    uid: string;
    email: string;
    name: string;
    photo: string;
    verified: boolean;
};
export type ClaimsOptions = {
    url: string;
    /**
     * the role doc { v } | null
     */
    entry?: ((user: AppUser) => any) | undefined;
    behind?: ((entry: any, tokenClaims: any) => boolean) | undefined;
    when?: (() => boolean) | undefined;
    /**
     * (0.8.3) read the role doc live (doc), and refresh the claims when it changes
     */
    watch?: boolean | undefined;
    /**
     * (0.8.3) the role doc's path, for watch
     */
    doc?: ((user: AppUser) => string | (string | number)[]) | undefined;
    /**
     * (0.8.3) after each check: asked, and the HTTP status (0: none)
     */
    onClaims?: ((r: {
        asked: boolean;
        status: number;
    }) => void) | undefined;
};
export type AppOptions = {
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
     * save kinds -> collection (default: each coll is its own kind)
     */
    kinds?: Record<string, string> | undefined;
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
    claims?: ClaimsOptions | null | undefined;
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
    redirectFirst?: (() => boolean) | undefined;
    /**
     * sign in with the popup only, never a redirect
     */
    popupOnly?: boolean | undefined;
    /**
     * the browser's navigator, for tests
     */
    nav?: any;
    /**
     * where the origin's outbox list is kept (null: no registry)
     */
    storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined;
    fetch?: typeof fetch | undefined;
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
export { userOf, claimsBehind } from "./user.js";
