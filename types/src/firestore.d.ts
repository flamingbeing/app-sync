/** @param {FirestoreBackendOptions} options */
export function createFirestoreBackend({ sdk, path, field: stampField, time, stamp, canonical: canonOf, where, merge, mark, stampMode, serverField, writeId, held, edits, editor, onCommit, onSnapshotMeta, onRead, commitRetry, unstampedColls }: FirestoreBackendOptions): {
    listen: (scope: string, coll: string, { since, field }: ListenPlan | undefined, onSnap: (s: Snapshot) => void, onError: (e: any) => void) => () => void;
    listenDoc: (segments: (string | number)[], onSnap: (s: {
        doc: Doc | null;
        fromCache: boolean;
        hasPendingWrites: boolean;
    }) => void, onError: (e: any) => void) => () => void;
    fetchOne: (scope: string, coll: string, id: string) => Promise<Doc | null>;
    commit: (scope: string, coll: string, record: Doc, base: Doc | null, { key, ops, after, path: to }?: CommitExtra) => Promise<Doc>;
    create: (scope: string, coll: string, record: Doc) => Promise<Doc>;
    existing: (scope: string, coll: string, ids: any[]) => Promise<Set<string>>;
    stamp: (prev?: any) => string | number;
    stampFields: (prev?: any) => Promise<any>;
    clearCache: ({ timeout }?: {
        timeout?: number;
    }) => Promise<any>;
};
export const CLEAR_TIMEOUT: 3000;
export type Doc = import("./types.js").Doc;
export type CodedError = import("./types.js").CodedError;
export type CommitExtra = import("./types.js").CommitExtra;
export type HeldRule = import("./types.js").HeldRule;
export type Snapshot = import("./types.js").Snapshot;
export type ListenPlan = import("./types.js").ListenPlan;
export type MergeFn = (current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc;
export type CommitContext = {
    scope: string;
    coll: string;
    before: Doc | null;
    after: Doc | null;
    at?: any;
    fields?: any;
    key: string;
    ops?: any;
};
export type ExtraWrite = {
    path: (string | number)[];
    data?: any;
    merge?: boolean;
    delete?: boolean;
};
export type FirestoreBackendOptions = {
    sdk: () => Promise<{
        db: any;
        F: any;
    }>;
    path: (scope: string, coll: string) => (string | number)[];
    field?: string | undefined;
    time?: "ms" | "iso" | undefined;
    stamp?: ((doc: Doc, coll: string) => Doc) | undefined;
    canonical?: ((coll: string, value: Doc) => Doc) | undefined;
    where?: ((scope: string, coll: string) => [string, string, any][]) | undefined;
    merge?: Record<string, true | MergeFn> | undefined;
    mark?: string | null | undefined;
    stampMode?: "client" | "server" | undefined;
    serverField?: string | undefined;
    writeId?: boolean | undefined;
    held?: boolean | Record<string, import("./types.js").HeldRule> | undefined;
    edits?: string | null | undefined;
    editor?: (() => {
        by?: string;
        device?: string;
    }) | null | undefined;
    onCommit?: ((ctx: CommitContext) => ExtraWrite[] | void) | null | undefined;
    onSnapshotMeta?: ((coll: string, meta: import("./types.js").SnapMeta) => void) | undefined;
    onRead?: ((coll: string, kind: "billed" | "served", n: number) => void) | undefined;
    commitRetry?: {
        codes?: string[];
        delay?: number;
    } | null | undefined;
    unstampedColls?: string[] | undefined;
};
