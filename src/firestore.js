// The Firestore side of the engine (sync.js) and the write queue (writes.js). No Firebase import here: the app passes
// its own SDK module (the modular API: collection, doc, query, where, onSnapshot, getDocFromServer, runTransaction),
// so this file works with whichever SDK build and version the app loads.
//
// createFirestoreBackend({ sdk, path, field = 'updatedAt', stamp, canonical, onSnapshotMeta, onRead })
//   sdk: async () => ({ db, F }), F the SDK's functions. path(scope, coll) -> the collection's path segments
//   (e.g. ['accounts', scope, coll]). stamp(doc, coll) -> the doc as written (default: updatedAt = Date.now()).
//   canonical(coll, value) -> the form compared for conflicts (default: as stored). onSnapshotMeta(coll, meta): every
//   snapshot's { fromCache, hasPendingWrites } (for the watchdog). onRead(coll, kind, n): documents read ('billed' /
//   'served'), for read counts in tests.
// -> { listen, fetchOne, commit }
//   commit(scope, coll, record, base): a transaction that writes record (record._deleted: deletes it) only when the
//   server's copy still matches base; throws { code: 'write-conflict', remote } otherwise (conflict.js). The write
//   queue's backend(owner, kind, record, base) maps kind to coll and calls it.
import { checkWrite } from './conflict.js';

const plain = v => JSON.parse(JSON.stringify(v));

export function createFirestoreBackend({ sdk, path, field: stampField = 'updatedAt', stamp, canonical = (_coll, v) => v, onSnapshotMeta = () => {}, onRead = () => {} }) {
  if (typeof sdk !== 'function' || typeof path !== 'function') throw new Error('createFirestoreBackend needs sdk and path');
  const stampDoc = stamp || (doc => ({ ...doc, [stampField]: Date.now() }));
  const colRef = (db, F, scope, coll) => F.collection(db, ...path(scope, coll));

  // the collection (since null) or the documents changed since a time, live, with metadata changes so the engine
  // learns when the server has confirmed an unchanged offline copy
  function listen(scope, coll, { since = null, field = stampField } = {}, onSnap, onError) {
    let stop = null, stopped = false, first = true;
    sdk().then(({ db, F }) => {
      if (stopped) return;
      const col = colRef(db, F, scope, coll);
      stop = F.onSnapshot(since === null ? col : F.query(col, F.where(field, '>', since)), { includeMetadataChanges: true }, snap => {
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

  async function commit(scope, coll, record, base) {
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

  return { listen, fetchOne, commit };
}
