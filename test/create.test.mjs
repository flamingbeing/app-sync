// 0.5.1: the adapter's create (a new record written without a read, for rules that can't answer a read of a document
// that isn't there yet) and existing (which ids the server has, for a restore that only adds what is missing).
// Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreBackend } from '../src/firestore.js';

// a small fake of the modular SDK: documents by path, reads that can be refused, a transaction's writes applied at
// the end; offline: every server read and transaction fails with 'unavailable'
function fakeSdk({ canRead = () => true } = {}) {
  const docs = new Map(), db = {}, log = { reads: [], queries: [], txGets: 0 };
  const state = { offline: false, onTx: null };
  const down = () => { const e = new Error('offline'); e.code = 'unavailable'; return e; };
  const denied = () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; return e; };
  const snapOf = (path, data) => ({ id: path.split('/').at(-1), exists: () => data !== undefined, data: () => structuredClone(data), ref: { path } });
  const F = {
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    doc: (parent, ...segs) => { const path = parent === db ? segs.join('/') : parent.path + '/' + segs.join('/'); return { path, id: path.split('/').at(-1) }; },
    documentId: () => '__id__',
    where: (field, op, value) => ({ field, op, value }),
    query: (col, ...w) => ({ path: col.path, w }),
    serverTimestamp: () => ({ serverTimestamp: true }),
    async getDocFromServer(ref) {
      if (state.offline) throw down();
      log.reads.push(ref.path);
      if (!canRead(ref.path, docs.get(ref.path))) throw denied();
      return snapOf(ref.path, docs.get(ref.path));
    },
    async getDocsFromServer(q) {
      if (state.offline) throw down();
      const ids = q.w.find(w => w.field === '__id__').value;
      log.queries.push(ids.slice());
      const found = ids.map(id => q.path + '/' + id).filter(p => docs.has(p)).map(p => snapOf(p, docs.get(p)));
      return { docs: found, size: found.length };
    },
    async runTransaction(_db, fn) {
      if (state.offline) throw down();
      const writes = [];
      const tx = { get: async ref => { log.txGets++; return snapOf(ref.path, docs.get(ref.path)); }, set: (ref, data) => writes.push([ref.path, data]), delete: ref => writes.push([ref.path, undefined]) };
      const out = await fn(tx);
      if (state.onTx) await state.onTx(writes);
      for (const [p, d] of writes) if (d === undefined) docs.delete(p); else docs.set(p, structuredClone(d));
      return out;
    },
  };
  return { docs, log, state, sdk: async () => ({ db, F }) };
}
const path = (s, c) => ['spaces', s, c];

test('create writes a new record without reading it inside the transaction, stamped as commit stamps', async () => {
  const f = fakeSdk();
  const b = createFirestoreBackend({ sdk: f.sdk, path, stampMode: 'server' });
  const out = await b.create('s1', 'items', { id: 'r1', text: 'Fake' });
  assert.equal(out.text, 'Fake');
  assert.equal(f.log.txGets, 0, 'no read in the transaction');
  const doc = f.docs.get('spaces/s1/items/r1');
  assert.equal(doc.text, 'Fake'); assert.equal(typeof doc.updatedAt, 'number'); assert.deepEqual(doc.serverAt, { serverTimestamp: true });
});

test('create leaves a record already on the server as it is (a resend whose answer was lost)', async () => {
  const f = fakeSdk();
  f.docs.set('spaces/s1/items/r1', { id: 'r1', text: 'Fake, sent before', updatedAt: 5 });
  const b = createFirestoreBackend({ sdk: f.sdk, path });
  const out = await b.create('s1', 'items', { id: 'r1', text: 'Fake, sent again' });
  assert.equal(out.text, 'Fake, sent before');
  assert.equal(f.docs.get('spaces/s1/items/r1').text, 'Fake, sent before', 'nothing overwritten');
});

test('create: a read the rules refuse counts as not there; a refused write finds the earlier send if it landed', async () => {
  // the writer may create but may not read a document that isn't there yet
  const f = fakeSdk({ canRead: (_p, data) => data !== undefined });
  const b = createFirestoreBackend({ sdk: f.sdk, path });
  await b.create('s1', 'items', { id: 'r1', text: 'Fake' });
  assert.equal(f.docs.get('spaces/s1/items/r1').text, 'Fake');
  // the transaction is refused (a create that is now an update), but the earlier send is there: that copy comes back
  const g = fakeSdk({ canRead: (_p, data) => data !== undefined });
  let once = true;
  g.state.onTx = () => { if (once) { once = false; g.docs.set('spaces/s1/items/r2', { id: 'r2', text: 'Fake, landed', updatedAt: 3 }); const e = new Error('denied'); e.code = 'permission-denied'; throw e; } };
  const bg = createFirestoreBackend({ sdk: g.sdk, path });
  assert.equal((await bg.create('s1', 'items', { id: 'r2', text: 'Fake' })).text, 'Fake, landed');
  // refused and not there: the refusal stands (the queue keeps the save as failed)
  const h = fakeSdk({ canRead: (_p, data) => data !== undefined });
  h.state.onTx = () => { const e = new Error('denied'); e.code = 'permission-denied'; throw e; };
  const bh = createFirestoreBackend({ sdk: h.sdk, path });
  await assert.rejects(bh.create('s1', 'items', { id: 'r3', text: 'Fake' }), e => e.code === 'permission-denied');
});

test('create offline throws unavailable (the queue keeps the save and tries again)', async () => {
  const f = fakeSdk();
  f.state.offline = true;
  const b = createFirestoreBackend({ sdk: f.sdk, path });
  await assert.rejects(b.create('s1', 'items', { id: 'r1', text: 'Fake' }), e => e.code === 'unavailable');
  assert.equal(f.docs.size, 0);
});

test('existing gives the ids the server has, 30 per query, from the server only, reads counted', async () => {
  const f = fakeSdk(), billed = [];
  for (let i = 0; i < 100; i += 3) f.docs.set('spaces/s1/items/r' + i, { id: 'r' + i, updatedAt: 1 });
  const b = createFirestoreBackend({ sdk: f.sdk, path, onRead: (coll, kind, n) => billed.push([coll, kind, n]) });
  const ids = Array.from({ length: 100 }, (_, i) => 'r' + i);
  const have = await b.existing('s1', 'items', [...ids, 'r0']);
  assert.deepEqual([...have].sort(), ids.filter((_, i) => i % 3 === 0).sort());
  assert.ok(f.log.queries.every(q => q.length <= 30), 'at most 30 ids a query');
  assert.equal(f.log.queries.flat().length, 100, 'each id asked once');
  assert.ok(billed.every(([c, k, n]) => c === 'items' && k === 'billed' && n >= 1), 'at least one billed read a query');
  assert.deepEqual([...await b.existing('s1', 'items', [])], []);
  f.state.offline = true;
  await assert.rejects(b.existing('s1', 'items', ['r0']), e => e.code === 'unavailable', 'offline it throws: it cannot tell');
});
