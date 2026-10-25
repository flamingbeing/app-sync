// The Firestore side of the engine (sync.js) and the write queue (writes.js). No Firebase import here: the app passes
// its own SDK module (the modular API: collection, doc, query, where, onSnapshot, getDocFromServer, runTransaction),
// so this file works with whichever SDK build and version the app loads.
//
// createFirestoreBackend({ sdk, path, field = 'updatedAt', time = 'ms', stamp, canonical, where, merge, mark, stampMode, serverField, writeId, onCommit, onSnapshotMeta, onRead })
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
//   record, base, ops) -> the record to write, for changes such as increments that only ops describe). mark: a field
//   that keeps the keys of the last saves applied to a merged record, so a save sent twice (its acknowledgement lost)
//   is applied once; null: none (then ops that are not idempotent, such as increments, can count twice on a resend).
//   stampMode: 'client' (default) or 'server': every commit also sets serverField (default 'serverAt') to
//   serverTimestamp(), in the same transaction, beside the usual stamp; reads give it as ms (null while this
//   device's own write is not on the server yet), a query on it compares server Timestamps, and the conflict check
//   leaves it out (only the content and the usual stamp count). Rules can then require serverAt == request.time.
//   writeId: false leaves the id field out of the document written (the id is the document's id; reads add it), for
//   rules that whitelist fields without id.
//   onCommit({ scope, coll, before, after, at, fields, key, ops }) -> [{ path, data, merge } | { path, delete: true }]:
//   more writes in the same transaction as a record's write (e.g. a leave entry with a lock, so no device ever sees
//   one without the other). before: the server's copy (null: none); after: what is written (null: a delete); at: its
//   stamp; fields: the stamp fields for those writes (stampFields); key, ops: the save's own id and ops (writes.js),
//   e.g. an audit entry with the save's change, stored under key so it lands once. path: the document's path
//   segments. Not called when nothing is written (the server already has this content).
//   A merge function may refuse a change it can't apply (a status changed elsewhere) by throwing { code:
//   'write-conflict', remote: current }: the queue keeps the save as a conflict for the user, never failed.
// -> { listen, fetchOne, commit, stamp, stampFields, clearCache }
//   commit(scope, coll, record, base, { key, ops }): a transaction that writes record (record._deleted: deletes it)
//   only when the server's copy still matches base; throws { code: 'write-conflict', remote } otherwise (conflict.js).
//   In a merge collection it writes the merge of the server's copy with this change instead, and throws
//   { code: 'not-found' } when the record was deleted elsewhere since base (never brought back). The write queue's
//   backend(owner, kind, record, base, extra) maps kind to coll and calls commit(owner, coll, record, base, extra).
//   stamp(prev) -> the stamp value for now (for an app's own writes outside the queue, so every write is stamped
//   alike); with prev (the record's stamp before this write), max(now, prev + 1).
//   stampFields(prev) -> Promise of the fields to add to such a write: { [field]: stamp(prev) } and, in server mode,
//   { [serverField]: serverTimestamp() } (bin entries and leave entries too).
//   clearCache({ timeout = 3000 }) -> terminates the SDK and clears its offline cache (sign-out on a shared device); the
//   SDK instance can't be used afterwards, so the app reloads (or builds a new one) before reading again. Clearing
//   waits while another tab of the origin still uses the cache: after timeout ms it throws { code:
//   'deadline-exceeded' } (the cache stays until those tabs close), so sign-out can go on and reload.
import { checkWrite, mergeFields, recordSignature } from './conflict.js';

const plain = v => JSON.parse(JSON.stringify(v));

const MARKS = 20;
export const CLEAR_TIMEOUT = 3000;   // ms clearCache waits for the offline cache to clear
const timeOf = v => typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0;   // save keys kept on a merged record (mark)

export function createFirestoreBackend({ sdk, path, field: stampField = 'updatedAt', time = 'ms', stamp, canonical: canonOf = (_coll, v) => v, where = () => [], merge = {}, mark = null, stampMode = 'client', serverField = 'serverAt', writeId = true, onCommit = null, onSnapshotMeta = () => {}, onRead = () => {} }) {
  if (typeof sdk !== 'function' || typeof path !== 'function') throw new Error('createFirestoreBackend needs sdk and path');
  if (time !== 'ms' && time !== 'iso') throw new Error("createFirestoreBackend: time is 'ms' or 'iso'");
  if (stampMode !== 'client' && stampMode !== 'server') throw new Error("createFirestoreBackend: stampMode is 'client' or 'server'");
  const server = stampMode === 'server';
  // server mode: the server's stamp as ms (a Timestamp; null while pending), never part of the conflict check
  const read = data => {
    if (!server || !data || !Object.hasOwn(data, serverField)) return data;
    const v = data[serverField];
    return { ...data, [serverField]: v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null) };
  };
  const unstampServer = v => { if (!server || !v || !Object.hasOwn(v, serverField)) return v; const { [serverField]: _s, ...rest } = v; return rest; };
  const canonical = (coll, v) => canonOf(coll, unstampServer(v));
  const withServer = (F, doc) => server ? { ...doc, [serverField]: F.serverTimestamp() } : doc;
  // what the document holds: without the id field when writeId is false (the id stays the document's id; reads add it)
  const stored = doc => { if (writeId) return doc; const { id: _id, ...rest } = doc; return rest; };
  const at = ms => time === 'iso' ? new Date(ms).toISOString() : ms;
  const next = prev => at(Math.max(Date.now(), timeOf(prev) + 1));
  const stampDoc = stamp || (doc => ({ ...doc, [stampField]: next() }));
  // the default stamp again, now that the server's copy is known (an app's own stamp function is left as it is)
  const forward = (doc, current) => stamp ? doc : { ...doc, [stampField]: next(current && current[stampField]) };
  // the app's extra writes for this commit, in the same transaction
  const extra = (F, db, tx, ctx) => {
    if (!onCommit) return;
    const at = ctx.after ? ctx.after[stampField] : next(ctx.before && ctx.before[stampField]);
    for (const w of onCommit({ ...ctx, at, fields: withServer(F, { [stampField]: at }) }) || []) {
      const ref = F.doc(db, ...w.path.map(String));
      if (w.delete) tx.delete(ref); else if (w.merge) tx.set(ref, w.data, { merge: true }); else tx.set(ref, w.data);
    }
  };
  const colRef = (db, F, scope, coll) => F.collection(db, ...path(scope, coll));
  const filters = (F, scope, coll) => (where(scope, coll) || []).map(w => F.where(...w));
  const mergeOf = coll => Object.hasOwn(merge || {}, coll) && merge[coll] ? (merge[coll] === true ? mergeFields : merge[coll]) : null;

  // the collection (since null) or the documents changed since a time, live, with metadata changes so the engine
  // learns when the server has confirmed an unchanged offline copy
  function listen(scope, coll, { since = null, field = stampField } = {}, onSnap, onError) {
    let stop = null, stopped = false, first = true;
    sdk().then(({ db, F }) => {
      if (stopped) return;
      const col = colRef(db, F, scope, coll), fs = filters(F, scope, coll);
      const from = server && field === serverField ? F.Timestamp.fromMillis(Math.max(0, since)) : at(since);
      const q = since === null ? (fs.length ? F.query(col, ...fs) : col) : F.query(col, ...fs, F.where(field, '>', from));
      stop = F.onSnapshot(q, { includeMetadataChanges: true }, snap => {
        const server = !snap.metadata.fromCache, full = since === null && first && server;
        // pending: this device's write is not on the server yet (if it is refused, the record leaves again: checked)
        const changes = snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, pending: c.doc.metadata.hasPendingWrites, doc: c.type === 'removed' ? null : { ...read(c.doc.data()), id: c.doc.id } }));
        if (server) {
          const n = changes.filter(c => c.type !== 'removed').length;
          onRead(coll, 'served', n);
          // Firestore bills a listener started cold for its whole first result (at least one), then each change
          onRead(coll, 'billed', first ? Math.max(1, snap.size) : n);
          first = false;
        }
        onSnapshotMeta(coll, { fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites });
        onSnap({ changes, fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites, ...(full ? { full: true, docs: snap.docs.map(d => ({ ...read(d.data()), id: d.id })) } : {}) });
      }, onError);
    }).catch(onError);
    return () => { stopped = true; if (stop) stop(); };
  }

  // one document from the server (throws offline: the engine then can't tell)
  async function fetchOne(scope, coll, id) {
    const { db, F } = await sdk();
    const snap = await F.getDocFromServer(F.doc(colRef(db, F, scope, coll), String(id)));
    onRead(coll, 'billed', 1);
    return snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
  }

  async function commit(scope, coll, record, base, { key = '', ops } = {}) {
    const merging = mergeOf(coll);
    if (merging) return commitMerged(scope, coll, record, base, merging, key, ops);
    const deleted = record && record._deleted === true;
    const stamped = deleted ? { id: String(record.id), _deleted: true } : unstampServer(plain(stampDoc(plain(record), coll)));
    const canon = v => v ? canonical(coll, v) : null;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll), String(stamped.id));
    return F.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      const doc = deleted ? stamped : forward(stamped, current);
      if (!checkWrite(canon(current), deleted ? null : canon(doc), canon(base))) return current || doc;
      if (deleted) tx.delete(ref); else tx.set(ref, withServer(F, stored(doc)));
      extra(F, db, tx, { scope, coll, before: current, after: deleted ? null : doc, key, ops });
      return doc;
    });
  }

  // last-write-wins by field: the server's copy now, with this change merged in (never a conflict)
  async function commitMerged(scope, coll, record, base, merging, key, ops) {
    const id = String(record.id), deleted = record._deleted === true;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll), id);
    const bare = v => { if (!v) return null; const { [mark]: _m, ...rest } = v; return canonical(coll, mark ? rest : v); };
    return F.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...read(snap.data()), id: snap.id } : null;
      if (deleted) { if (current) { tx.delete(ref); extra(F, db, tx, { scope, coll, before: current, after: null, key, ops }); } return { id, _deleted: true }; }
      if (mark && key && Array.isArray(current?.[mark]) && current[mark].includes(key)) return current;   // applied already
      if (base && !current) { const e = new Error('This record was deleted elsewhere; your version is kept'); e.code = 'not-found'; throw e; }
      const merged = forward(unstampServer(plain(stampDoc(plain({ ...merging(current ? plain(current) : null, plain(record), base ? plain(base) : null, ops), id }), coll))), current);
      if (mark) { if (key) merged[mark] = [...(Array.isArray(current?.[mark]) ? current[mark] : []), key].slice(-MARKS); else if (current?.[mark]) merged[mark] = current[mark]; }
      if (current && recordSignature(bare(current)) === recordSignature(bare(merged))) return current;   // nothing changed
      tx.set(ref, withServer(F, stored(merged)));
      extra(F, db, tx, { scope, coll, before: current, after: merged, key, ops });
      return merged;
    });
  }

  async function stampFields(prev) {
    const { F } = server ? await sdk() : {};
    return withServer(F, { [stampField]: next(prev) });
  }

  async function clearCache({ timeout = CLEAR_TIMEOUT } = {}) {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error('The offline cache could not be cleared in time (another tab still uses it)'); e.code = 'deadline-exceeded'; reject(e); }, timeout); });
    const clear = async () => { const { db, F } = await sdk(); await F.terminate(db); await F.clearIndexedDbPersistence(db); };
    return Promise.race([clear(), late]).finally(() => clearTimeout(timer));
  }

  return { listen, fetchOne, commit, stamp: prev => next(prev), stampFields, clearCache };
}
