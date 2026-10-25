/**
 * A stamp: ms since 1970, or an ISO string (sync.js timeOf reads either).
 */
export type Stamp = number | string;
/**
 * A synced record. Apps add their own fields; the engine reads `id`, the stamps and `_deleted`.
 */
export type Doc = {
    id: string;
    updatedAt?: Stamp;
    _deleted?: boolean;
    [field: string]: any;
};
/**
 * An error the engine throws or reads: `code` as the backend or SDK gave it; `remote` and `fields` on a conflict.
 */
export type CodedError = Error & {
    code?: string;
    remote?: Doc | null;
    fields?: string[];
};
/**
 * A snapshot's metadata (what the watchdog and status rules read).
 */
export type SnapMeta = {
    fromCache?: boolean;
    hasPendingWrites?: boolean;
};
/**
 * A watch callback's second argument (0.8.2: changed, removed: the ids whose copy changed since the last call, and
 * the ids gone).
 */
export type WatchMeta = SnapMeta & {
    changed: string[];
    removed: string[];
};
export type Change = {
    type: "added" | "modified" | "removed";
    id: string;
    doc?: Doc | null;
    pending?: boolean;
};
/**
 * What a backend's listen() hands its callback.
 */
export type Snapshot = SnapMeta & {
    changes?: Change[];
    full?: boolean;
    docs?: Doc[];
    epoch?: any;
};
/**
 * Sync state kept per collection on the device (store.js).
 */
export type CollMeta = {
    coll?: string;
    syncAt?: number;
    fullAt?: number;
    anchor?: number;
    epoch?: any;
    newest?: number;
    gone?: Record<string, number>;
    later?: Record<string, number>;
};
export type ListenPlan = {
    since: number | null;
    epoch?: any;
    field?: string;
};
/**
 * A backend's listen(): the collection (since null) or what changed since a time -> unsubscribe.
 */
export type Listen = (scope: string, coll: string, plan: ListenPlan, onSnap: (s: Snapshot) => void, onError: (e: any) => void) => () => void;
export type FetchOne = (scope: string, coll: string, id: string) => Promise<Doc | null>;
/**
 * The device's copy of one scope (store.js openStore).
 */
export type Store = {
    name: string;
    kind: "idb" | "memory";
    readonly closed: boolean;
    load: (coll: string) => Promise<{
        docs: Doc[];
        meta: CollMeta;
    }>;
    write: (coll: string, op?: {
        put?: Doc[];
        del?: string[];
        meta?: CollMeta;
        replace?: boolean;
    }) => Promise<void>;
    close: () => void;
};
/**
 * The slice of a Store a collection engine needs.
 */
export type EngineStore = Pick<Store, "load" | "write">;
export type Tomb = {
    id: string;
    deletedAt: Stamp;
};
export type ExpireRule = {
    field: string;
    after: number;
} | null;
/**
 * The write queue's states: pending (to send), synced, failed (refused), conflict (met a change made elsewhere),
 * archived (set aside).
 */
export type JobState = "pending" | "synced" | "failed" | "conflict" | "archived";
/**
 * A save in the outbox (writes.js). v: the job format (JOB_FORMAT; none on jobs written before 0.8.0). 0.8.2 adds
 * optional code (a refused save's error code), refused (set aside, waiting for Retry or Discard) and meta (the app's).
 */
export type Job = {
    v?: number;
    key: string;
    owner: string;
    kind: string;
    record: Doc;
    base: Doc | null;
    state: JobState;
    accepted: boolean;
    at: number;
    error?: string;
    result?: Doc;
    remote?: Doc | null;
    kept?: boolean;
    ops?: any[];
    realm?: string;
    code?: string;
    refused?: boolean;
    meta?: any;
};
/**
 * The outbox store the write queue keeps its jobs in (outbox.js createOutbox, or an app's own of the same shape).
 */
export type Outbox = {
    name: string;
    realm: string;
    put: (job: Job) => Promise<Job>;
    list: (owner: string) => Promise<Job[]>;
    get: (key: string) => Promise<Job | null>;
    remove: (key: string) => Promise<void>;
    forget: (owner: string) => Promise<void>;
};
/**
 * The last argument of a backend commit: the save's own key and ops, and a stamp floor for a re-created record.
 */
export type CommitExtra = {
    key?: string;
    ops?: any[];
    after?: number;
};
/**
 * The write queue's backend: throws a CodedError ('write-conflict' with `remote`, a transient code, or any other).
 */
export type QueueBackend = (owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>;
/**
 * The nothing-lost report (report.js createReport), as the queue and createApp use it.
 */
export type Report = {
    watch: (queue: any) => (() => void);
    error: (code?: any) => void;
    payload: () => any;
    due: () => boolean;
    flush: (opts?: {
        force?: boolean;
    }) => Promise<boolean>;
    start: () => void;
    stop: () => void;
};
export type OutboxId = {
    name: string;
    realm?: string;
};
/**
 * The outbox registry (registry.js).
 */
export type Registry = {
    list: () => OutboxId[];
    register: (x: OutboxId) => void;
    unregister: (x: OutboxId) => void;
    unsent: (owner: string, o?: {
        except?: OutboxId | null;
    }) => Promise<boolean>;
    forget: (owner: string, o?: {
        except?: OutboxId | null;
    }) => Promise<void>;
};
/**
 * Options of the write queue (writes.js createWriteQueue).
 */
export type QueueOptions = {
    store: Outbox;
    backend: QueueBackend;
    getOwner?: (() => string | null) | undefined;
    normalize?: ((kind: string, value: Doc) => Doc) | undefined;
    online?: (() => boolean) | undefined;
    delay?: ((ms: number) => Promise<void>) | undefined;
    notice?: ((message: string) => void) | undefined;
    sendTimeout?: number | undefined;
    /**
     * the stamp field of a backend answer, for lastSent (0.8.2; default updatedAt)
     */
    field?: string | undefined;
    /**
     * fields left out of lastSent's signature (0.8.2; createApp: the backend's engine fields)
     */
    engine?: string[] | undefined;
    labels?: {
        recover?: string;
    } | undefined;
    otherPending?: (() => Promise<any>) | null | undefined;
    registry?: Registry | null | undefined;
    report?: Pick<Report, "watch" | "error"> | null | undefined;
    ignore?: string[] | undefined;
};
/**
 * What a collection's held-conflict option can be per collection (firestore.js `held`).
 */
export type HeldRule = boolean | {
    counters?: string[];
};
/**
 * The popup data of a held conflict (conflict.js describeConflict): one side of the clash.
 */
export type ConflictSide = {
    value: any;
    at: number;
    when: string;
    by: string;
    device: string;
};
export type ConflictView = {
    deleted: {
        mine: boolean;
        theirs: boolean;
    };
    fields: {
        path: string;
        keys: string[];
        mine: ConflictSide;
        theirs: ConflictSide;
    }[];
    mine: ConflictSide;
    theirs: ConflictSide;
};
/**
 * A held save, as describeConflict / resolvedRecord read it.
 */
export type HeldSave = {
    record: Doc;
    base?: Doc | null;
    remote?: Doc | null;
    at?: number;
    ops?: any;
};
export type ConflictChoice = "mine" | "theirs" | Record<string, "mine" | "theirs">;
/**
 * The sync status (status.js).
 */
export type SyncStatus = {
    state: "attention" | "at-risk" | "offline" | "saving" | "stale" | "unknown" | "synced";
    count: number;
};
/**
 * A Firebase-like SDK as createApp loads it: A is the auth module's functions, F the Firestore module's. Typed loosely
 * on purpose: the engine works with whichever SDK build the app loads.
 */
export type AppSdk = {
    A: any;
    F: any;
    auth: any;
    db: any;
    emulator?: boolean;
};
/**
 * watch(scope, coll, cb, options) (view.js)
 */
export type WatchOptions = {
    query?: Record<string, any>;
    limit?: number;
};
/**
 * sync.saveMany
 */
export type SaveMany = (kind: string, scope: string, records: Doc[]) => Promise<PromiseSettledResult<Doc>[]>;
/**
 * Reserved for 1.x (SHAPES.md): types only, nothing built. 1.0 uses these names for nothing else.
 */
export type SignInMethod = "google" | "emailLink" | "password" | "passcode" | "anonymous";
/**
 * Reserved for 1.x (SHAPES.md): types only, nothing built. 1.0 uses these names for nothing else.
 */
export type SignInRequest = {
    method?: SignInMethod;
    hint?: string;
    email?: string;
    password?: string;
    code?: string;
};
/**
 * sync({ keep: { [coll]: KeepRule } })
 */
export type KeepRule = {
    recent: number;
} | {
    part: (record: Doc) => string;
};
/**
 * meta.keep on the device (FORMATS.md)
 */
export type KeepMeta = {
    mode: "recent" | "part";
    since?: number;
    part?: string;
};
/**
 * sync() options added in 1.x
 */
export type SyncReserved = {
    public?: string[];
    keep?: Record<string, KeepRule>;
};
/**
 * Reserved for 1.x (SHAPES.md): types only, nothing built. 1.0 uses these names for nothing else.
 */
export type ReservedModule = "files" | "ui" | "theme" | "settings" | "sw" | "devkit";
