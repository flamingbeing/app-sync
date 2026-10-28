// The Firestore side of the engine (sync.js) and the write queue (writes.js). No Firebase import here: the app passes
// its own SDK module (the modular API: collection, doc, query, where, onSnapshot, getDocFromServer, runTransaction),
// so this file works with whichever SDK build and version the app loads.
//
// createFirestoreBackend({ sdk, path, field = 'updatedAt', time = 'ms', stamp, canonical, where, merge, mark, stampMode, serverField, writeId, onCommit, onSnapshotMeta, onRead, commitRetry, unstampedColls })
//   sdk: async () => ({ db, F }), F the SDK's functions. path(scope, coll) -> the collection's path segments
//   (e.g. ['accounts', scope, coll]). stamp(doc, coll) -> the doc as written (default: updatedAt = max(now, the
//   server copy's updatedAt + 1), taken inside the commit transaction, so a stamp only ever moves forward even when
//   the writer's clock is behind the last writer's).
//   canonical(coll, value) -> the form compared for conflicts (default: as stored). onSnapshotMeta(coll, meta): every
//   snapshot's { fromCache, hasPendingWrites } (for the watchdog). onRead(coll, kind, n): documents read ('billed' /
//   'served'), for read counts in tests.
//   time: 'ms' (stamps are numbers) or 'iso' (ISO strings, as an app that already stamps that way keeps them).
//   where(scope, coll) -> [[field, op, value], …]: filters every query of that collection (e.g. one site's records;
//   a delta query then needs a composite index on those fields and the stamp field). merge: { [coll]: true | fn }:
//   collections saved last-write-wins by field instead of with a conflict check (true: mergeFields; fn(current,
//   record, base, ops) -> the record to write, for changes such as increments that only ops describe; '*' (1.1.0):
//   every collection not named, e.g. { '*': replaceRecord } for last-write-wins by whole record). mark: a field
//   that keeps the keys of the last saves applied to a merged record, so a save sent twice (its acknowledgement lost)
//   is applied once; null: none (then ops that are not idempotent, such as increments, can count twice on a resend).
//   stampMode: 'client' (default) or 'server': every commit also sets serverField (default 'serverAt') to
//   serverTimestamp(), in the same transaction, beside the usual stamp; reads give it as ms (null while this
//   device's own write is not on the server yet), a query on it compares server Timestamps, and the conflict check
//   leaves it out (only the content and the usual stamp count). Rules can then require serverAt == request.time.
//   writeId: false leaves the id field out of the document written (the id is the document's id; reads add it), for
//   rules that whitelist fields without id.
//   held (0.6.3, opt-in): true (every collection not in merge) or { [coll]: true | { counters: [field, …] } }: those
//   collections are saved with held conflicts by field (conflict.js mergeHeld) instead of the whole-record check: a
//   field changed only on this device, or only elsewhere, merges on its own; one changed on both sides to the same
//   value is no conflict; counters take each device's change as an increment (they need mark, so a resend counts
//   once); a field changed on both sides to different values throws { code: 'write-conflict', remote, fields } and the
//   queue holds the save for the user (nothing is written, nothing overwritten). A delete meets any change made
//   elsewhere as a conflict, and an edit of a record deleted elsewhere is one too (remote null), as with checkWrite.
//   A merge collection named in held (0.7.1; held: true still leaves them last-write-wins) keeps its merge function,
//   which applies the save's ops to the server's copy as before, and is held only where that would overwrite a change
//   made elsewhere: a path changed on both sides to different values where the merge takes this device's value
//   (conflict.js mergeClashes). Increments the merge adds up never clash. The merge function must be pure: it also
//   runs on base (to know what this save changed), so the app passes the copy the edit started from as base (null:
//   every field sent counts as changed). counters are not used there (the merge function does that).
//   edits (0.6.3, opt-in, with held): a field name (e.g. '_edits'): each write also records who changed each top-level
//   field and when, edits[field] = { by, device, at } (at: ms), for the conflict popup (conflict.js describeConflict).
//   A data-shape change: rules that whitelist fields must allow it. editor() -> { by, device }: who this device's
//   writes are by (createApp passes the signed-in name and its device option).
//   onCommit({ scope, coll, before, after, at, fields, key, ops }) -> [{ path, data, merge } | { path, delete: true }]:
//   more writes in the same transaction as a record's write (e.g. a leave entry with a lock, so no device ever sees
//   one without the other). before: the server's copy (null: none); after: what is written (null: a delete); at: its
//   stamp; fields: the stamp fields for those writes (stampFields); key, ops: the save's own id and ops (writes.js),
//   e.g. an audit entry with the save's change, stored under key so it lands once. path: the document's path
//   segments. Not called when nothing is written (the server already has this content).
//   A merge function may refuse a change it can't apply (a status changed elsewhere) by throwing { code:
//   'write-conflict', remote: current }: the queue keeps the save as a conflict for the user, never failed.
// -> { listen, listenDoc (0.8.3), fetchOne, commit, create, existing, stamp, stampFields, clearCache }
//   commit(scope, coll, record, base, { key, ops, after, path }): a transaction that writes record (record._deleted:
//   deletes it) only when the server's copy still matches base; throws { code: 'write-conflict', remote } otherwise
//   (conflict.js). after (0.6.3): a record not on the server is stamped after this time (its delete's tombstone, so
//   devices holding that tombstone show it). path (1.2.0): the collection's path segments for this write instead of
//   path(scope, coll) (a kind saved outside the scope: kinds[kind] = { coll, path }, core.js).
//   unstampedColls (1.2.0): collections whose documents hold only the app's fields (rules that refuse id, the stamp
//   and the server stamp): written without them, the conflict check on the content alone, and always listened to
//   whole (no stamp to read "changed since" by). Not a merge or held one.
//   commitRetry (1.1.0): { codes = ['aborted', 'permission-denied'], delay = 500 }: a commit refused with one of
//   codes is tried once more after delay ms (a rule that reads a document another write is still creating can refuse
//   the first try); a second refusal stands. Default off: refused at once, as 1.0.
//   In a merge collection it writes the merge of the server's copy with this change instead, and throws
//   { code: 'not-found' } when the record was deleted elsewhere since base (never brought back). The write queue's
//   backend(owner, kind, record, base, extra) maps kind to coll and calls commit(owner, coll, record, base, extra).
//   create(scope, coll, record): a new record written without reading it inside the transaction (0.5.1), for rules
//   that can't answer a read of a document that isn't there yet (someone who may create a record but not read
//   others'). It looks on the server first: a copy already there (an earlier send whose answer was lost) is returned
//   and nothing is written; a read the rules refuse counts as not there. Then a transaction that only sets it,
//   stamped as commit stamps (so it never waits in the SDK's offline queue: offline it throws 'unavailable'). Refused
//   with 'permission-denied' (the earlier send landed, so this is now an update), it looks again and returns that
//   copy when it is there; otherwise the refusal stands. No conflict check: use commit for a change to a record.
//   existing(scope, coll, ids) -> Promise of a Set of the ids the server has (0.5.1), asked 30 at a time (Firestore's
//   'in' limit), four queries at once, from the server, never the cache (throws offline: it can't tell). Each query
//   counts as billed reads (one per document found, at least one). For a restore that only adds what is missing.
//   stamp(prev) -> the stamp value for now (for an app's own writes outside the queue, so every write is stamped
//   alike); with prev (the record's stamp before this write), max(now, prev + 1).
//   stampFields(prev) -> Promise of the fields to add to such a write: { [field]: stamp(prev) } and, in server mode,
//   { [serverField]: serverTimestamp() } (bin entries and leave entries too).
//   clearCache({ timeout = 3000 }) -> terminates the SDK and clears its offline cache (sign-out on a shared device); the
//   SDK instance can't be used afterwards, so the app reloads (or builds a new one) before reading again. Clearing
//   waits while another tab of the origin still uses the cache: after timeout ms it throws { code:
//   'deadline-exceeded' } (the cache stays until those tabs close), so sign-out can go on and reload.
import { checkWrite, mergeFnClashes, mergeHeld, mergeOf, recordSignature } from './conflict.js';

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').CodedError} CodedError
 * @typedef {import('./types.js').CommitExtra} CommitExtra
 * @typedef {import('./types.js').HeldRule} HeldRule
 * @typedef {import('./types.js').Snapshot} Snapshot
 * @typedef {import('./types.js').ListenPlan} ListenPlan
 * @typedef {(current: Doc | null, record: Doc, base: Doc | null, ops?: any) => Doc} MergeFn
 * @typedef {{ scope: string, coll: string, before: Doc | null, after: Doc | null, at?: any, fields?: any, key: string, ops?: any }} CommitContext
 * @typedef {{ path: (string | number)[], data?: any, merge?: boolean, delete?: boolean }} ExtraWrite
 */

/**
 * @typedef {object} FirestoreBackendOptions
 * @property {() => Promise<{ db: any, F: any }>} sdk
 * @property {(scope: string, coll: string) => (string | number)[]} path
 * @property {string} [field]
 * @property {'ms' | 'iso'} [time]
 * @property {(doc: Doc, coll: string) => Doc} [stamp]
 * @property {(coll: string, value: Doc) => Doc} [canonical]
 * @property {(scope: string, coll: string) => [string, string, any][]} [where]
 * @property {Record<string, true | MergeFn>} [merge]
 * @property {string | null} [mark]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 * @property {boolean} [writeId]
 * @property {boolean | Record<string, HeldRule>} [held]
 * @property {string | null} [edits]
 * @property {(() => { by?: string, device?: string }) | null} [editor]
 * @property {((ctx: CommitContext) => ExtraWrite[] | void) | null} [onCommit]
 * @property {(coll: string, meta: import('./types.js').SnapMeta) => void} [onSnapshotMeta]
 * @property {(coll: string, kind: 'billed' | 'served', n: number) => void} [onRead]
 * @property {{ codes?: string[], delay?: number } | null} [commitRetry]
 * @property {string[]} [unstampedColls]
 */

// fn tried once more after delay ms when it throws one of codes (commitRetry)
/** @template {any[]} A @template R @param {(...a: A) => Promise<R>} fn @param {{ codes?: string[], delay?: number }} retry @returns {(...a: A) => Promise<R>} */
function retriedOnce(fn, { codes = ['aborted', 'permission-denied'], delay = 500 }) {
  return async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (!codes.includes(/** @type {any} */ (e)?.code)) throw e;
      await new Promise(r => setTimeout(r, delay));
      return fn(...a);
    }
  };
}

/** @template T @param {T} v @returns {T} */
const plain = v => JSON.parse(JSON.stringify(v));

const MARKS = 20;
export const CLEAR_TIMEOUT = 3000;   // ms clearCache waits for the offline cache to clear
/** @param {any} v @returns {number} */
const timeOf = v => typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0;   // save keys kept on a merged record (mark)

/** @param {FirestoreBackendOptions} options */
export function createFirestoreBackend({ sdk, path, field: stampField = 'updatedAt', time = 'ms', stamp, canonical: canonOf = (_coll, v) => v, where = () => [], merge = {}, mark = null, stampMode = 'client', serverField = 'serverAt', writeId = true, held = false, edits = null, editor = null, onCommit = null, onSnapshotMeta = () => {}, onRead = () => {}, commitRetry = null, unstampedColls = [] }) {
  if (typeof sdk !== 'function' || typeof path !== 'function') throw new Error('createFirestoreBackend needs sdk and path');
  if (time !== 'ms' && time !== 'iso') throw new Error("createFirestoreBackend: time is 'ms' or 'iso'");
  if (stampMode !== 'client' && stampMode !== 'server') throw new Error("createFirestoreBackend: stampMode is 'client' or 'server'");
  const server = stampMode === 'server';
  /** @param {string} coll @returns {{ counters?: string[] } | null} */
  // (held: true leaves merge collections last-write-wins; naming one in held holds its clashes too, 0.7.1)
  const heldOf = coll => { if (!held || held === true && mergeOf(merge, coll)) return null; const h = held === true ? {} : Object.hasOwn(held, coll) && held[coll]; return h ? (h === true ? {} : h) : null; };
  const unstamped = new Set(unstampedColls);
  for (const c of unstamped) if (mergeOf(merge, c) || heldOf(c)) throw new Error('createFirestoreBackend: unstampedColls can\'t name a merge or held collection: ' + c);
  if (held && held !== true && Object.values(held).some(h => /** @type {any} */ (h)?.counters?.length) && !mark) throw new Error('createFirestoreBackend: held counters need mark (a resend would count twice)');
  // server mode: the server's stamp as ms (a Timestamp; null while pending), never part of the conflict check
  /** @param {any} data */
  const read = data => {
    if (!server || !data || !Object.hasOwn(data, serverField)) return data;
    const v = data[serverField];
    return { ...data, [serverField]: v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null) };
  };
  /** @param {any} v */
  const unstampServer = v => { if (!server || !v || !Object.hasOwn(v, serverField)) return v; const { [serverField]: _s, ...rest } = v; return rest; };
  // (1.3.12) compared without a custom stamp field too, as recordSignature already skips updatedAt: a save sent again
  // after a lost answer was a conflict with itself in an app stamping another field
  /** @param {any} v */
  const unstampOwn = v => { if (stampField === 'updatedAt' || !v || !Object.hasOwn(v, stampField)) return v; const { [stampField]: _f, ...rest } = v; return rest; };
  /** @param {string} coll @param {any} v */
  const canonical = (coll, v) => canonOf(coll, unstampOwn(unstampServer(v)));
  /** @param {any} F @param {any} doc */
  const withServer = (F, doc) => server ? { ...doc, [serverField]: F.serverTimestamp() } : doc;
  // what the document holds: without the id field when writeId is false (the id stays the document's id; reads add it)
  /** @param {any} doc */
  const stored = doc => { if (writeId) return doc; const { id: _id, ...rest } = doc; return rest; };
  /** @param {number} ms */
  const at = ms => time === 'iso' ? new Date(ms).toISOString() : ms;
  /** @param {any} [prev] */
  const next = prev => at(Math.max(Date.now(), timeOf(prev) + 1));
  const stampDoc = stamp || (doc => ({ ...doc, [stampField]: next() }));
  // the default stamp again, now that the server's copy is known (an app's own stamp function is left as it is); a
  // record not on the server is stamped after `after` (0.6.3: the tombstone of its delete, which devices hold)
  /** @param {any} doc @param {any} current @param {any} [after] */
  const forward = (doc, current, after = 0) => stamp ? doc : { ...doc, [stampField]: next(current ? current[stampField] : timeOf(after) > 0 ? timeOf(after) : undefined) };
  // the app's extra writes for this commit, in the same transaction
  /** @param {any} F @param {any} db @param {any} tx @param {Omit<CommitContext, 'at' | 'fields'>} ctx */
  const extra = (F, db, tx, ctx) => {
    if (!onCommit) return;
    const at = ctx.after ? ctx.after[stampField] : next(ctx.before && ctx.before[stampField]);
    for (const w of onCommit({ ...ctx, at, fields: withServer(F, { [stampField]: at }) }) || []) {
      const ref = F.doc(db, ...w.path.map(String));
      if (w.delete) tx.delete(ref); else if (w.merge) tx.set(ref, w.data, { merge: true }); else tx.set(ref, w.data);
    }
  };
  /** @param {any} db @param {any} F @param {string} scope @param {string} coll @param {(string | number)[] | null} [at] */
  const colRef = (db, F, scope, coll, at = null) => F.collection(db, ...(at ? at.map(String) : path(scope, coll)));
  // an unstampedColls document as stored: the app's fields only
  /** @param {any} doc */
  const unstampedDoc = doc => { const { id: _id, [stampField]: _t, [serverField]: _s, ...rest } = doc; return rest; };
  /** @param {any} F @param {string} scope @param {string} coll */
  const filters = (F, scope, coll) => (where(scope, coll) || []).map(w => F.where(...w));

  // the collection (since null) or the documents changed since a time, live, with metadata changes so the engine
  // learns when the server has confirmed an unchanged offline copy
  /**
   * @param {string} scope
   * @param {string} coll
   * @param {ListenPlan} plan
   * @param {(s: Snapshot) => void} onSnap
   * @param {(e: any) => void} onError
   * @returns {() => void}
   */
  function listen(scope, coll, { since = null, field = stampField } = { since: null }, onSnap, onError) {
    /** @type {(() => void) | null} */
    let stop = null;
    let stopped = false, first = true;
    sdk().then(({ db, F }) => {
      if (stopped) return;
      const col = colRef(db, F, scope, coll), fs = filters(F, scope, coll);
      const from = server && field === serverField ? F.Timestamp.fromMillis(Math.max(0, /** @type {number} */ (since))) : at(/** @type {number} */ (since));
      // (an unstampedColls collection is read whole: its documents have no stamp a "changed since" read could match)
      const whole = since === null || unstamped.has(coll);
      const q = whole ? (fs.length ? F.query(col, ...fs) : col) : F.query(col, ...fs, F.where(field, '>', from));
      // (1.3.12) a whole read's list: each record already read for its change is not read again (the first answer
      // lists every record as added; one after a cached answer, only what changed since)
      /** @param {any} snap @param {import('./types.js').Change[]} changes */
      const wholeList = (snap, changes) => {
        const byId = new Map(changes.filter(c => c.doc).map(c => [c.id, c.doc]));
        return snap.docs.map(/** @param {any} d */ d => byId.get(d.id) ?? { ...read(d.data()), id: d.id });
      };
      stop = F.onSnapshot(q, { includeMetadataChanges: true }, /** @param {any} snap */ snap => {
        const server = !snap.metadata.fromCache, full = whole && first && server;
        // pending: this device's write is not on the server yet (if it is refused, the record leaves again: checked)
        /** @type {import('./types.js').Change[]} */
        const changes = snap.docChanges().map(/** @param {any} c */ c => ({ type: c.type, id: c.doc.id, pending: c.doc.metadata.hasPendingWrites, doc: c.type === 'removed' ? null : { ...read(c.doc.data()), id: c.doc.id } }));
        if (server) {
          const n = changes.filter(c => c.type !== 'removed').length;
          onRead(coll, 'served', n);
          // Firestore bills a listener started cold for its whole first result (at least one), then each change
          onRead(coll, 'billed', first ? Math.max(1, snap.size) : n);
          first = false;
        }
        onSnapshotMeta(coll, { fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites });
        onSnap({ changes, fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites, ...(full ? { full: true, docs: wholeList(snap, changes) } : {}) });
      }, onError);
    }).catch(onError);
    return () => { stopped = true; if (stop) stop(); };
  }

  // (0.8.3) one document, live: onSnap({ doc (null: not there), fromCache, hasPendingWrites }) on every snapshot
  /** @param {(string | number)[]} segments @param {(s: { doc: Doc | null, fromCache: boolean, hasPendingWrites: boolean }) => void} onSnap @param {(e: any) => void} onError @returns {() => void} */
  function listenDoc(segments, onSnap, onError) {
    /** @type {(() => void) | null} */
    let stop = null;
    let stopped = false;
    const coll = String(segments[segments.length - 2] ?? '');
    sdk().then(({ db, F }) => {
      if (stopped) return;
      stop = F.onSnapshot(F.doc(db, ...segments.map(String)), { includeMetadataChanges: true }, /** @param {any} snap */ snap => {
        const server = !snap.metadata.fromCache;
        if (server) onRead(coll, 'billed', 1);
        onSnapshotMeta(coll, { fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites });
        onSnap({ doc: snap.exists() ? { ...read(snap.data()), id: snap.id } : null, fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites });
      }, onError);
    }).catch(onError);
    return () => { stopped = true; if (stop) stop(); };
  }

  // one document from the server (throws offline: the engine then can't tell)
  /** @param {string} scope @param {string} coll @param {string} id @returns {Promise<Doc | null>} */
  async function fetchOne(scope, coll, id) {
    const { db, F } = await sdk();
    const snap = await F.getDocFromServer(F.doc(colRef(db, F, scope, coll), String(id)));
    onRead(coll, 'billed', 1);
    return snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
  }

  /**
   * @param {string} scope
   * @param {string} coll
   * @param {Doc} record
   * @param {Doc | null} base
   * @param {CommitExtra} [extraArgs]
   * @returns {Promise<Doc>}
   */
  async function commit(scope, coll, record, base, { key = '', ops, after = 0, path: to } = {}) {
    const at = to || null;
    const merging = mergeOf(merge, coll), holding = heldOf(coll);
    if (merging && holding) return commitHeldMerged(scope, coll, record, base, merging, key, ops, after, at);
    if (merging) return commitMerged(scope, coll, record, base, merging, key, ops, after, at);
    if (holding) return commitHeld(scope, coll, record, base, holding, key, ops, after, at);
    const deleted = record && record._deleted === true, bare = unstamped.has(coll);
    const stamped = deleted ? { id: String(record.id), _deleted: true } : bare ? { ...unstampedDoc(plain(record)), id: String(record.id) } : unstampServer(plain(stampDoc(plain(record), coll)));
    /** @param {any} v */
    const canon = v => v ? canonical(coll, v) : null;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll, at), String(stamped.id));
    return F.runTransaction(db, async (/** @type {any} */ tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      const doc = deleted || bare ? stamped : forward(stamped, current, after);
      if (!checkWrite(canon(current), deleted ? null : canon(doc), canon(base))) return current || doc;
      if (deleted) tx.delete(ref); else tx.set(ref, bare ? unstampedDoc(doc) : withServer(F, stored(doc)));
      extra(F, db, tx, { scope, coll, before: current, after: deleted ? null : doc, key, ops });
      return doc;
    });
  }

  // last-write-wins by field: the server's copy now, with this change merged in (never a conflict)
  /** @param {string} scope @param {string} coll @param {Doc} record @param {Doc | null} base @param {MergeFn} merging @param {string} key @param {any} ops @param {number} after @param {(string | number)[] | null} at @returns {Promise<Doc>} */
  async function commitMerged(scope, coll, record, base, merging, key, ops, after, at) {
    const id = String(record.id), deleted = record._deleted === true;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll, at), id);
    /** @param {any} v */
    const bare = v => { if (!v) return null; const { [/** @type {string} */ (mark)]: _m, ...rest } = v; return canonical(coll, mark ? rest : v); };
    return F.runTransaction(db, async (/** @type {any} */ tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      if (deleted) { if (current) { tx.delete(ref); extra(F, db, tx, { scope, coll, before: current, after: null, key, ops }); } return { id, _deleted: true }; }
      if (mark && key && Array.isArray(current?.[mark]) && current[mark].includes(key)) return current;   // applied already
      if (base && !current) { const e = /** @type {CodedError} */ (new Error('This record was deleted elsewhere; your version is kept')); e.code = 'not-found'; throw e; }
      const merged = forward(unstampServer(plain(stampDoc(plain({ ...merging(current ? plain(current) : null, plain(record), base ? plain(base) : null, ops), id }), coll))), current, after);
      if (mark) { if (key) merged[mark] = [...(Array.isArray(current?.[mark]) ? current[mark] : []), key].slice(-MARKS); else if (current?.[mark]) merged[mark] = current[mark]; }
      if (current && recordSignature(bare(current)) === recordSignature(bare(merged))) return current;   // nothing changed
      tx.set(ref, withServer(F, stored(merged)));
      extra(F, db, tx, { scope, coll, before: current, after: merged, key, ops });
      return merged;
    });
  }

  // held conflicts by field (0.6.3): the server's copy now with this device's changes since base merged in; a field
  // changed on both sides to different values is held for the user (mergeHeld throws), never overwritten
  /** @param {string} scope @param {string} coll @param {Doc} record @param {Doc | null} base @param {{ counters?: string[] }} rule @param {string} key @param {any} ops @param {number} after @param {(string | number)[] | null} at @returns {Promise<Doc>} */
  async function commitHeld(scope, coll, record, base, { counters = [] }, key, ops, after, at) {
    const id = String(record.id), deleted = record._deleted === true;
    const skip = /** @type {string[]} */ ([stampField, serverField, mark, edits].filter(Boolean));
    /** @param {any} v */
    const without = v => { if (!v) return null; const out = { ...v }; for (const f of skip) delete out[f]; return out; };
    /** @param {any} v */
    const bare = v => v ? canonical(coll, without(v)) : null;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll, at), id);
    return F.runTransaction(db, async (/** @type {any} */ tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      if (mark && key && Array.isArray(current?.[mark]) && current[mark].includes(key)) return current;   // applied already
      if (deleted) {
        if (!checkWrite(bare(current), null, bare(base))) return { id, _deleted: true };
        tx.delete(ref); extra(F, db, tx, { scope, coll, before: current, after: null, key, ops });
        return { id, _deleted: true };
      }
      if (base && !current) { const e = /** @type {CodedError} */ (new Error('This record was deleted elsewhere; both versions are kept')); e.code = 'write-conflict'; e.remote = null; e.fields = []; throw e; }
      const was = without(plain(base)), rec = without(plain(record));
      let merged;
      try { merged = { ...mergeHeld(current ? without(plain(current)) : null, rec, was, { counters }), id }; }
      catch (err) { const e = /** @type {CodedError} */ (err); if (e.code === 'write-conflict') e.remote = current; throw e; }   // (the whole copy: who changed what)
      if (current && recordSignature(bare(current)) === recordSignature(bare(merged))) return current;   // nothing changed
      const doc = forward(unstampServer(plain(stampDoc(merged, coll))), current, after);
      if (mark) { if (key) doc[mark] = [...(Array.isArray(current?.[mark]) ? current[mark] : []), key].slice(-MARKS); else if (current?.[mark]) doc[mark] = current[mark]; }
      if (edits) doc[edits] = editsLog(current, rec, was);
      tx.set(ref, withServer(F, stored(doc)));
      extra(F, db, tx, { scope, coll, before: current, after: doc, key, ops });
      return doc;
    });
  }

  // who changed each top-level field and when (edits): the server's log with this device's changes since base
  /** @param {any} current @param {any} rec @param {any} was */
  function editsLog(current, rec, was) {
    const who = (editor && editor()) || {}, at = Date.now(), log = { ...(current?.[/** @type {string} */ (edits)] || {}) }, from = was || {};
    for (const k of new Set([...Object.keys(rec), ...Object.keys(from)])) {
      if (k === 'id' || k === 'updatedAt' || recordSignature(rec[k] ?? null) === recordSignature(from[k] ?? null) && k in rec === k in from) continue;
      log[k] = { by: String(who.by || ''), device: String(who.device || ''), at };
    }
    return log;
  }

  // held conflicts for a merge collection (0.7.1): the merge function writes the save into the server's copy as
  // commitMerged does, but a path this device changed that was changed elsewhere to a different value, and that the
  // merge would overwrite, is held for the user (conflict.js mergeClashes), never overwritten; increments and other
  // changes the merge combines never clash. Deletes and edits of a record deleted elsewhere are as commitHeld's.
  /** @param {string} scope @param {string} coll @param {Doc} record @param {Doc | null} base @param {MergeFn} merging @param {string} key @param {any} ops @param {number} after @param {(string | number)[] | null} at @returns {Promise<Doc>} */
  async function commitHeldMerged(scope, coll, record, base, merging, key, ops, after, at) {
    const id = String(record.id), deleted = record._deleted === true;
    const skip = /** @type {string[]} */ ([stampField, serverField, mark, edits].filter(Boolean));
    /** @param {any} v */
    const without = v => { if (!v) return null; const out = { ...v }; for (const f of skip) delete out[f]; return out; };
    /** @param {any} v */
    const bare = v => v ? canonical(coll, without(v)) : null;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll, at), id);
    return F.runTransaction(db, async (/** @type {any} */ tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      if (mark && key && Array.isArray(current?.[mark]) && current[mark].includes(key)) return current;   // applied already
      if (deleted) {
        if (!checkWrite(bare(current), null, bare(base))) return { id, _deleted: true };
        tx.delete(ref); extra(F, db, tx, { scope, coll, before: current, after: null, key, ops });
        return { id, _deleted: true };
      }
      if (base && !current) { const e = /** @type {CodedError} */ (new Error('This record was deleted elsewhere; both versions are kept')); e.code = 'write-conflict'; e.remote = null; e.fields = []; throw e; }
      const was = without(plain(base));
      /** @type {{ mine: Doc, merged: Doc, fields: string[] }} */
      let run;
      try { run = mergeFnClashes(current ? without(plain(current)) : null, plain(record), was, merging, ops, { skip }); }
      catch (err) { const e = /** @type {CodedError} */ (err); if (e.code === 'write-conflict' && e.remote === undefined) e.remote = current; throw e; }
      if (run.fields.length) {
        const e = /** @type {CodedError} */ (new Error('This record changed elsewhere (' + run.fields.join(', ') + '); both versions are kept'));
        e.code = 'write-conflict'; e.remote = current; e.fields = run.fields; throw e;
      }
      const doc = forward(unstampServer(plain(stampDoc(plain({ ...without(run.merged), id }), coll))), current, after);
      if (mark) { if (key) doc[mark] = [...(Array.isArray(current?.[mark]) ? current[mark] : []), key].slice(-MARKS); else if (current?.[mark]) doc[mark] = current[mark]; }
      if (current && recordSignature(bare(current)) === recordSignature(bare(doc))) return current;   // nothing changed
      if (edits) doc[edits] = editsLog(current, without(run.mine) || {}, was);
      tx.set(ref, withServer(F, stored(doc)));
      extra(F, db, tx, { scope, coll, before: current, after: doc, key, ops });
      return doc;
    });
  }

  /** @param {string} scope @param {string} coll @param {Doc} record @returns {Promise<Doc>} */
  async function create(scope, coll, record) {
    const stamped = unstampServer(plain(stampDoc(plain(record), coll)));
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll), String(stamped.id));
    /** @returns {Promise<Doc | null>} */
    const found = async () => {
      const snap = await F.getDocFromServer(ref).catch(/** @param {any} e @returns {null} */ e => { if (e && e.code === 'permission-denied') return null; throw e; });
      onRead(coll, 'billed', 1);
      return snap && snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
    };
    const there = await found();
    if (there) return there;
    try {
      await F.runTransaction(db, async (/** @type {any} */ tx) => { tx.set(ref, withServer(F, stored(stamped))); });
      return stamped;
    } catch (e) {
      if (e && e.code === 'permission-denied') { const now = await found().catch(/** @returns {null} */ () => null); if (now) return now; }
      throw e;
    }
  }

  const IN = 30, AT_ONCE = 4;
  /** @param {string} scope @param {string} coll @param {any[]} ids @returns {Promise<Set<string>>} */
  async function existing(scope, coll, ids) {
    const want = [...new Set((ids || []).map(String))];
    const have = new Set();
    if (!want.length) return have;
    const { db, F } = await sdk();
    const col = colRef(db, F, scope, coll);
    /** @param {string[]} part */
    const lookup = async part => {
      const snap = await F.getDocsFromServer(F.query(col, F.where(F.documentId(), 'in', part)));
      onRead(coll, 'billed', Math.max(1, snap.size));
      for (const d of snap.docs) have.add(d.id);
    };
    for (let i = 0; i < want.length; i += IN * AT_ONCE) {
      const parts = [];
      for (let k = 0; k < AT_ONCE; k++) { const part = want.slice(i + IN * k, i + IN * (k + 1)); if (part.length) parts.push(part); }
      await Promise.all(parts.map(lookup));
    }
    return have;
  }

  /** @param {any} [prev] */
  async function stampFields(prev) {
    const { F } = server ? await sdk() : {};
    return withServer(F, { [stampField]: next(prev) });
  }

  /** @param {{ timeout?: number }} [options] */
  async function clearCache({ timeout = CLEAR_TIMEOUT } = {}) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { const e = /** @type {CodedError} */ (new Error('The offline cache could not be cleared in time (another tab still uses it)')); e.code = 'deadline-exceeded'; reject(e); }, timeout); });
    const clear = async () => { const { db, F } = await sdk(); await F.terminate(db); await F.clearIndexedDbPersistence(db); };
    return Promise.race([clear(), late]).finally(() => clearTimeout(timer));
  }

  return { listen, listenDoc, fetchOne, commit: commitRetry ? retriedOnce(commit, commitRetry) : commit, create, existing, stamp: /** @param {any} [prev] */ prev => next(prev), stampFields, clearCache };
}

// (1.5.0) the adapter as a factory for sync({ adapter: firestore(options) }) (@core/sync/firestore): the sync core
// calls it with what it knows (sdk, path, onSnapshotMeta, editor, and the backend options); options are
// createFirestoreBackend's, the same as sync()'s backend. sync() without an adapter loads this itself.
/** @param {Partial<FirestoreBackendOptions>} [options] */
export function firestore(options = {}) {
  /** @param {FirestoreBackendOptions} ctx */
  const make = ctx => createFirestoreBackend({ ...options, ...ctx });
  return Object.assign(make, { options });
}
