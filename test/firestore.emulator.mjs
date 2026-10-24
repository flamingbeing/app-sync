// The Firestore adapter (src/firestore.js) with the engine and the write queue, against the local Firestore emulator
// (demo project: nothing reaches a real Firebase project). Run with: npm run test:emulator (needs Java).
// Made-up data only.
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import * as F from 'firebase/firestore';
import { createFirestoreBackend } from '../src/firestore.js';
import { createSyncHub } from '../src/sync.js';
import { createWriteQueue } from '../src/writes.js';
import { createStores } from '../src/store.js';

const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(50); }
  return false;
}
function device(name, stamp) {
  const app = initializeApp({ projectId: 'demo-app-sync', apiKey: 'fake-key' }, name);
  const db = F.getFirestore(app);
  F.connectFirestoreEmulator(db, HOST[0], Number(HOST[1]));
  const reads = {};
  const backend = createFirestoreBackend({
    sdk: async () => ({ db, F }),
    path: (scope, coll) => ['spaces', scope, coll],
    stamp,
    onRead: (coll, kind, n) => { (reads[coll] ||= { billed: 0, served: 0 })[kind] += n; },
  });
  return { app, db, backend, reads };
}

const S = 'space-' + Date.now().toString(36);
const A = device('a'), B = device('b');
// a writer whose records were last changed an hour ago (outside the engine's 10 min overlap)
const OLD = device('old', doc => ({ ...doc, updatedAt: Date.now() - 3600e3 }));

// ---- commit: writes, then refuses a write made on a stale base, keeping both versions ----
const first = await A.backend.commit(S, 'items', { id: 'i1', text: 'Fake one' }, null);
assert.equal(first.text, 'Fake one'); assert.ok(first.updatedAt > 0);
const again = await A.backend.commit(S, 'items', { id: 'i1', text: 'Fake one' }, null);
assert.equal(again.text, 'Fake one', 'the same content sent again (a lost acknowledgement) is not a conflict');
await B.backend.commit(S, 'items', { id: 'i1', text: 'Fake edit on B' }, first);
await assert.rejects(A.backend.commit(S, 'items', { id: 'i1', text: 'Fake edit on A' }, first), e => e.code === 'write-conflict' && e.remote.text === 'Fake edit on B');
assert.equal((await A.backend.fetchOne(S, 'items', 'i1')).text, 'Fake edit on B', 'nothing overwritten');
assert.equal(await A.backend.fetchOne(S, 'items', 'nope'), null);

// ---- the engine on Firestore: a full read first, then only changes; a bin entry removes the record elsewhere ----
for (let i = 2; i <= 6; i++) await OLD.backend.commit(S, 'items', { id: 'i' + i, text: 'Fake ' + i }, null);
const stores = createStores({ prefix: 'emu-a:', colls: ['items'] });
const hub = createSyncHub({ openStore: stores.openStore, listen: A.backend.listen, fetchOne: A.backend.fetchOne, binKinds: { item: 'items' }, grace: 0 });
let list = [];
let off = hub.watch(S, 'items', l => { list = l; });
assert.ok(await until(() => list.length === 6), 'full read: ' + list.length);
off(); await settle(50); await hub.stopAll();
const billedFull = A.reads.items.billed;
assert.ok(billedFull >= 6);

// reopen: a delta listener, nothing changed: one billed read
off = hub.watch(S, 'items', l => { list = l; });
assert.ok(await until(() => A.reads.items.billed > billedFull));
await settle();
assert.equal(A.reads.items.billed - billedFull, 1, 'reopening costs one read (only i1 is inside the overlap)');
// a change made on B arrives live, and a delete through the bin removes it here
await B.backend.commit(S, 'items', { id: 'i3', text: 'Fake 3 edited' }, (await B.backend.fetchOne(S, 'items', 'i3')));
assert.ok(await until(() => list.find(d => d.id === 'i3')?.text === 'Fake 3 edited'), 'live change');
const binned = await B.backend.fetchOne(S, 'items', 'i4');
await F.setDoc(F.doc(B.db, 'spaces', S, 'bin', 'x4'), { id: 'x4', kind: 'item', data: binned, deletedAt: Date.now() });
await B.backend.commit(S, 'items', { id: 'i4', _deleted: true }, binned);
assert.ok(await until(() => !list.some(d => d.id === 'i4')), 'the binned record goes');
off(); await settle(50); await hub.stopAll();

// ---- the write queue with the adapter: a conflict is kept with the other version ----
const records = new Map();
const outbox = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
const q = createWriteQueue({ store: outbox, getOwner: () => S, backend: (scope, _kind, record, base) => A.backend.commit(scope, 'items', record, base) });
const base5 = await A.backend.fetchOne(S, 'items', 'i5');
await B.backend.commit(S, 'items', { id: 'i5', text: 'Fake 5 from B' }, base5);
await assert.rejects(q.save('item', S, { ...base5, text: 'Fake 5 from A' }, base5), /kept in Recover/);
assert.equal(q.status('item', 'i5'), 'conflict');
assert.equal(q.entries()[0].remote.text, 'Fake 5 from B');
const shown = await A.backend.fetchOne(S, 'items', 'i5');
await q.save('item', S, { ...shown, text: 'Fake 5 merged' }, shown);
assert.ok(await until(() => q.status('item', 'i5') === 'synced'));
assert.equal((await B.backend.fetchOne(S, 'items', 'i5')).text, 'Fake 5 merged');
assert.equal(await q.flush(), true);

await Promise.all([A, B, OLD].map(d => F.terminate(d.db)));
console.log('firestore emulator tests passed');
process.exit(0);
