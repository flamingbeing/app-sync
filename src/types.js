// Types only (JSDoc, checked by `npm run typecheck`): the shapes the modules pass between them and the app. Nothing
// here runs; no module imports this file at run time (they refer to it as import('./types.js').Name in comments).
// Each shape is described in prose at the top of the module that owns it.

/**
 * A stamp: ms since 1970, or an ISO string (sync.js timeOf reads either).
 * @typedef {number | string} Stamp
 */

/**
 * A synced record. Apps add their own fields; the engine reads `id`, the stamps and `_deleted`.
 * @typedef {{ id: string, updatedAt?: Stamp, _deleted?: boolean, [field: string]: any }} Doc
 */

/**
 * An error the engine throws or reads: `code` as the backend or SDK gave it; `remote` and `fields` on a conflict.
 * @typedef {Error & { code?: string, remote?: Doc | null, fields?: string[] }} CodedError
 */

/**
 * A snapshot's metadata (what the watchdog and status rules read).
 * @typedef {{ fromCache?: boolean, hasPendingWrites?: boolean }} SnapMeta
 */

/**
 * A watch callback's second argument (0.8.2: changed, removed: the ids whose copy changed since the last call, and
 * the ids gone).
 * @typedef {SnapMeta & { changed: string[], removed: string[] }} WatchMeta
 */

/**
 * @typedef {{ type: 'added' | 'modified' | 'removed', id: string, doc?: Doc | null, pending?: boolean }} Change
 */

/**
 * What a backend's listen() hands its callback.
 * @typedef {SnapMeta & { changes?: Change[], full?: boolean, docs?: Doc[], epoch?: any }} Snapshot
 */

/**
 * Sync state kept per collection on the device (store.js).
 * @typedef {{ coll?: string, syncAt?: number, fullAt?: number, anchor?: number, epoch?: any, newest?: number,
 *   gone?: Record<string, number>, later?: Record<string, number> }} CollMeta
 */

/**
 * @typedef {{ since: number | null, epoch?: any, field?: string }} ListenPlan
 */

/**
 * A backend's listen(): the collection (since null) or what changed since a time -> unsubscribe.
 * @typedef {(scope: string, coll: string, plan: ListenPlan, onSnap: (s: Snapshot) => void, onError: (e: any) => void) => () => void} Listen
 */

/** @typedef {(scope: string, coll: string, id: string) => Promise<Doc | null>} FetchOne */

/**
 * The device's copy of one scope (store.js openStore).
 * @typedef {{ name: string, kind: 'idb' | 'memory', readonly closed: boolean,
 *   load: (coll: string) => Promise<{ docs: Doc[], meta: CollMeta }>,
 *   write: (coll: string, op?: { put?: Doc[], del?: string[], meta?: CollMeta, replace?: boolean }) => Promise<void>,
 *   close: () => void }} Store
 */

/**
 * The slice of a Store a collection engine needs.
 * @typedef {Pick<Store, 'load' | 'write'>} EngineStore
 */

/** @typedef {{ id: string, deletedAt: Stamp }} Tomb */

/** @typedef {{ field: string, after: number } | null} ExpireRule */

/**
 * The write queue's states: pending (to send), synced, failed (refused), conflict (met a change made elsewhere),
 * archived (set aside).
 * @typedef {'pending' | 'synced' | 'failed' | 'conflict' | 'archived'} JobState
 */

/**
 * A save in the outbox (writes.js). v: the job format (JOB_FORMAT; none on jobs written before 0.8.0). 0.8.2 adds
 * optional code (a refused save's error code), refused (set aside, waiting for Retry or Discard) and meta (the app's).
 * @typedef {{ v?: number, key: string, owner: string, kind: string, record: Doc, base: Doc | null, state: JobState,
 *   accepted: boolean, at: number, error?: string, result?: Doc, remote?: Doc | null, kept?: boolean, ops?: any[],
 *   realm?: string, code?: string, refused?: boolean, meta?: any }} Job
 */

/**
 * The outbox store the write queue keeps its jobs in (outbox.js createOutbox, or an app's own of the same shape).
 * @typedef {{ name: string, realm: string, put: (job: Job) => Promise<Job>, list: (owner: string) => Promise<Job[]>,
 *   get: (key: string) => Promise<Job | null>, remove: (key: string) => Promise<void>,
 *   forget: (owner: string) => Promise<void> }} Outbox
 */

/**
 * The last argument of a backend commit: the save's own key and ops, and a stamp floor for a re-created record.
 * @typedef {{ key?: string, ops?: any[], after?: number }} CommitExtra
 */

/**
 * The write queue's backend: throws a CodedError ('write-conflict' with `remote`, a transient code, or any other).
 * @typedef {(owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>} QueueBackend
 */

/**
 * The nothing-lost report (report.js createReport), as the queue and createApp use it.
 * @typedef {{ watch: (queue: any) => (() => void), error: (code?: any) => void, payload: () => any,
 *   due: () => boolean, flush: (opts?: { force?: boolean }) => Promise<boolean>, start: () => void,
 *   stop: () => void }} Report
 */

/**
 * @typedef {{ name: string, realm?: string }} OutboxId
 */

/**
 * The outbox registry (registry.js).
 * @typedef {{ list: () => OutboxId[], register: (x: OutboxId) => void, unregister: (x: OutboxId) => void,
 *   unsent: (owner: string, o?: { except?: OutboxId | null }) => Promise<boolean>,
 *   forget: (owner: string, o?: { except?: OutboxId | null }) => Promise<void> }} Registry
 */

/**
 * Options of the write queue (writes.js createWriteQueue).
 * @typedef {object} QueueOptions
 * @property {Outbox} store
 * @property {QueueBackend} backend
 * @property {() => string | null} [getOwner]
 * @property {(kind: string, value: Doc) => Doc} [normalize]
 * @property {() => boolean} [online]
 * @property {(ms: number) => Promise<void>} [delay]
 * @property {(message: string) => void} [notice]
 * @property {number} [sendTimeout]
 * @property {string} [field] the stamp field of a backend answer, for lastSent (0.8.2; default updatedAt)
 * @property {string[]} [engine] fields left out of lastSent's signature (0.8.2; createApp: the backend's engine fields)
 * @property {{ recover?: string }} [labels]
 * @property {(() => Promise<any>) | null} [otherPending]
 * @property {Registry | null} [registry]
 * @property {Pick<Report, 'watch' | 'error'> | null} [report]
 * @property {string[]} [ignore]
 */

/**
 * What a collection's held-conflict option can be per collection (firestore.js `held`).
 * @typedef {boolean | { counters?: string[] }} HeldRule
 */

/**
 * The popup data of a held conflict (conflict.js describeConflict): one side of the clash.
 * @typedef {{ value: any, at: number, when: string, by: string, device: string }} ConflictSide
 */

/**
 * @typedef {{ deleted: { mine: boolean, theirs: boolean }, fields: { path: string, keys: string[], mine: ConflictSide, theirs: ConflictSide }[],
 *   mine: ConflictSide, theirs: ConflictSide }} ConflictView
 */

/**
 * A held save, as describeConflict / resolvedRecord read it.
 * @typedef {{ record: Doc, base?: Doc | null, remote?: Doc | null, at?: number, ops?: any }} HeldSave
 */

/**
 * @typedef {'mine' | 'theirs' | Record<string, 'mine' | 'theirs'>} ConflictChoice
 */

/**
 * The sync status (status.js).
 * @typedef {{ state: 'attention' | 'at-risk' | 'offline' | 'saving' | 'stale' | 'unknown' | 'synced', count: number }} SyncStatus
 */

/**
 * A Firebase-like SDK as createApp loads it: A is the auth module's functions, F the Firestore module's. Typed loosely
 * on purpose: the engine works with whichever SDK build the app loads.
 * @typedef {{ A: any, F: any, auth: any, db: any, emulator?: boolean }} AppSdk
 */

export {};
