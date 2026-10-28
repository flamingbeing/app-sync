// 1.5.0: the Firestore adapter is its own entry (sync/firestore.js, @core/sync/firestore). sync() without an adapter
// still loads it (the 1.x default); sync({ adapter: firestore(options) }) is the same adapter, its options the same as
// backend's. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './factory.mjs';
import { firestore, createFirestoreBackend } from '../sync/firestore.js';
import * as index from '../index.js';
import { memOutbox, sharedSdk } from './fake-sdk.mjs';

let n = 0;
const S = 'fake-space', path = (s, c) => ['spaces', s, c];
async function saved(extra) {
  const shared = sharedSdk(), { db, F } = shared.device();
  const user = { uid: 'u1', email: 'fake@example.test', getIdTokenResult: async () => ({ claims: {} }), getIdToken: async () => 't' };
  const A = { onAuthStateChanged: (_a, cb) => { cb(user); return () => {}; } };
  const app = await createApp({ name: 'fstest' + (++n), colls: ['items'], path, sdk: async () => ({ A, F, auth: { currentUser: user }, db }),
    outbox: memOutbox(), storage: null, win: null, watchEvery: 0, nav: { onLine: true }, ...extra });
  await app.open(S);
  await app.save('items', S, { id: 'r1', text: 'Fake' }, null);
  assert.equal(await app.flush(2000), true);
  return { app, doc: shared.docs.get(`spaces/${S}/items/r1`) };
}

test('sync() with no adapter still writes through the Firestore adapter (the 1.x default, loaded at start)', async () => {
  const { app, doc } = await saved({});
  assert.equal(doc.text, 'Fake');
  assert.equal(typeof doc.updatedAt, 'number');
  assert.equal(typeof app.parts.adapter.listen, 'function');
});

test('sync({ adapter: firestore(options) }): the same adapter, its options counted as backend options', async () => {
  const { doc } = await saved({ adapter: firestore({ field: 'modifiedAt' }) });
  assert.equal(doc.text, 'Fake');
  assert.equal(typeof doc.modifiedAt, 'number');
  assert.equal(doc.updatedAt, undefined);
  assert.equal(createFirestoreBackend, index.createFirestoreBackend, 'the same function index.js names');
  assert.deepEqual(firestore({ field: 'x' }).options, { field: 'x' });
});
