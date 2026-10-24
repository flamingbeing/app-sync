// The Firestore side of the engine (sync.js) and the write queue (writes.js). No Firebase import here: the app passes
// its own SDK module (the modular API: collection, doc, query, where, onSnapshot, getDocFromServer, runTransaction),
// so this file works with whichever SDK build and version the app loads.
//
// createFirestoreBackend({ sdk, path, field = 'updatedAt', time = 'ms', stamp, canonical, where, merge, mark, onSnapshotMeta, onRead })
//   sdk: async () => ({ db, F }), F the SDK's functions. path(scope, coll) -> the collection's path segments
//   (e.g. ['accounts', scope, coll]). stamp(doc, coll) -> the doc as written (default: updatedAt = Date.now()).
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
// -> { listen, fetchOne, commit, stamp }
//   commit(scope, coll, record, base, { key, ops }): a transaction that writes record (record._deleted: deletes it)
//   only when the server's copy still matches base; throws { code: 'write-conflict', remote } otherwise (conflict.js).
//   In a merge collection it writes the merge of the server's copy with this change instead, and throws
//   { code: 'not-found' } when the record was deleted elsewhere since base (never brought back). The write queue's
//   backend(owner, kind, record, base, extra) maps kind to coll and calls commit(owner, coll, record, base, extra).
//   stamp() -> the stamp value for now (for an app's own writes outside the queue, so every write is stamped alike).
import { checkWrite, mergeFields, recordSignature } from './conflict.js';

const plain = v => JSON.parse(JSON.stringify(v));

const MARKS = 20;   // save keys kept on a merged record (mark)

export function createFirestoreBackend({ sdk, path, field: stampField = 'updatedAt', time = 'ms', stamp, canonical = (_coll, v) => v, where = () => [], merge = {}, mark = null, onSnapshotMeta = () => {}, onRead = () => {} }) {
  if (typeof sdk !== 'function' || typeof path !== 'function') throw new Error('createFirestoreBackend needs sdk and path');
  if (time !== 'ms' && time !== 'iso') throw new Error("createFirestoreBackend: time is 'ms' or 'iso'");
  const at = ms => time === 'iso' ? new Date(ms).toISOString() : ms;
  const stampDoc = stamp || (doc => ({ ...doc, [stampField]: at(Date.now()) }));
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
      const q = since === null ? (fs.length ? F.query(col, ...fs) : col) : F.query(col, ...fs, F.where(field, '>', at(since)));
      stop = F.onSnapshot(q, { includeMetadataChanges: true }, snap => {
        const server = !snap.metadata.fromCache, full = since === null && first && server;
        // pending: this device's write is not on the server yet (if it is refused, the record leaves again: checked)
        const changes = snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, pending: c.doc.metadata.hasPendingWrites, doc: c.type === 'removed' ? null : { ...c.doc.data(), id: c.doc.id } }));
        if (server) {
          const n = changes.filter(c => c.type !== 'removed').length;
          onRead(coll, 'served', n);
          // Firestore bills a listener started cold for its whole first result (at least one), then each change
          onRead(coll, 'billed', first ? Math.max(1, snap.size) : n);
          first = false;
        }
        onSnapshotMeta(coll, { fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites });
        onSnap({ changes, fromCache: !server, hasPendingWrites: snap.metadata.hasPendingWrites, ...(full ? { full: true, docs: snap.docs.map(d => ({ ...d.data(), id: d.id })) } : {}) });
      }, onError);
    }).catch(onError);
    return () => { stopped = true; if (stop) stop(); };
  }

  // one document from the server (throws offline: the engine then can't tell)
  async function fetchOne(scope, coll, id) {
    const { db, F } = await sdk();
    const snap = await F.getDocFromServer(F.doc(colRef(db, F, scope, coll), String(id)));
    onRead(coll, 'billed', 1);
    return snap.exists() ? { ...snap.data(), id: snap.id } : null;
  }

  async function commit(scope, coll, record, base, { key = '', ops } = {}) {
    const merging = mergeOf(coll);
    if (merging) return commitMerged(scope, coll, record, base, merging, key, ops);
    const deleted = record && record._deleted === true;
    const doc = deleted ? { id: String(record.id), _deleted: true } : plain(stampDoc(plain(record), coll));
    const canon = v => v ? canonical(coll, v) : null;
    const { db, F } = await sdk();
    const ref = F.doc(colRef(db, F, scope, coll), String(doc.id));
    return F.runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists() ? { ...snap.data(), id: snap.id } : null;
      if (!checkWrite(canon(current), deleted ? null : canon(doc), canon(base))) return current || doc;
      if (deleted) tx.delete(ref); else tx.set(ref, doc);
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
      const current = snap.exists() ? { ...snap.data(), id: snap.id } : null;
      if (deleted) { if (current) tx.delete(ref); return { id, _deleted: true }; }
      if (mark && key && Array.isArray(current?.[mark]) && current[mark].includes(key)) return current;   // applied already
      if (base && !current) { const e = new Error('This record was deleted elsewhere; your version is kept'); e.code = 'not-found'; throw e; }
      const next = plain(stampDoc(plain({ ...merging(current ? plain(current) : null, plain(record), base ? plain(base) : null, ops), id }), coll));
      if (mark) { if (key) next[mark] = [...(Array.isArray(current?.[mark]) ? current[mark] : []), key].slice(-MARKS); else if (current?.[mark]) next[mark] = current[mark]; }
      if (current && recordSignature(bare(current)) === recordSignature(bare(next))) return current;   // nothing changed
      tx.set(ref, next);
      return next;
    });
  }

  return { listen, fetchOne, commit, stamp: () => at(Date.now()) };
}
