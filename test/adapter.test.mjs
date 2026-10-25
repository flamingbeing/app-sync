// Run with: node --test test/adapter.test.mjs
// The Firestore adapter's 1.2.0 options on the fake SDK: a save to a path of its own (G15), collections written
// without the engine's stamps (G17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreBackend } from '../src/firestore.js';
import { sharedSdk } from './fake-sdk.mjs';

const S = 'fake-scope';
const path = (/** @type {string} */ s, /** @type {string} */ c) => ['spaces', s, c];

test('commit with extra.path (1.2.0) writes to that collection path instead of the scope\'s, conflict check as ever', async () => {
  const shared = sharedSdk(), b = createFirestoreBackend({ sdk: shared.device().sdk, path });
  const doc = await b.commit(S, 'answers', { id: 'a1', text: 'Fake' }, null, { path: ['links', 'fake-token', 'answers'] });
  assert.ok(shared.docs.has('links/fake-token/answers/a1'));
  assert.ok(![...shared.docs.keys()].some(k => k.startsWith('spaces/')), 'nothing under the scope');
  await assert.rejects(b.commit(S, 'answers', { ...doc, text: 'Fake 2' }, { ...doc, text: 'Fake other' }, { path: ['links', 'fake-token', 'answers'] }), /changed|conflict/i);
  await b.commit(S, 'answers', { id: 'a1', _deleted: true }, doc, { path: ['links', 'fake-token', 'answers'] });
  assert.ok(!shared.docs.has('links/fake-token/answers/a1'), 'a delete goes to the same path');
});

test('backend.unstampedColls (1.2.0): those collections are written without the id, the stamp or the server stamp', async () => {
  const shared = sharedSdk();
  const b = createFirestoreBackend({ sdk: shared.device().sdk, path, stampMode: 'server', unstampedColls: ['applications'] });
  const doc = await b.commit(S, 'applications', { id: 'p1', name: 'Fake Applicant' }, null);
  assert.deepEqual(shared.docs.get('spaces/' + S + '/applications/p1'), { name: 'Fake Applicant' }, 'only the app\'s fields');
  assert.deepEqual(doc, { id: 'p1', name: 'Fake Applicant' });
  await b.commit(S, 'applications', { id: 'p1', name: 'Fake Renamed' }, doc);
  assert.equal(shared.docs.get('spaces/' + S + '/applications/p1').name, 'Fake Renamed');
  shared.meddle('spaces/' + S + '/applications/p1', { name: 'Fake Elsewhere' });
  await assert.rejects(b.commit(S, 'applications', { id: 'p1', name: 'Fake Mine' }, { id: 'p1', name: 'Fake Renamed' }), /changed|conflict/i, 'changed elsewhere since base: a conflict, as stamped ones');
  const plain = await b.commit(S, 'items', { id: 'i1', text: 'Fake' }, null);
  assert.ok(plain.updatedAt > 0 && 'serverAt' in shared.docs.get('spaces/' + S + '/items/i1'), 'other collections keep their stamps');
  assert.throws(() => createFirestoreBackend({ sdk: shared.device().sdk, path, unstampedColls: ['applications'], merge: { '*': (c, r) => r } }), /unstampedColls/);
  assert.throws(() => createFirestoreBackend({ sdk: shared.device().sdk, path, unstampedColls: ['applications'], held: true }), /unstampedColls/);
});

test('backend.unstampedColls (1.2.0): those collections are listened to whole, never "changed since" (no stamp to compare)', async () => {
  /** @type {any[]} */
  const queries = [];
  /** @type {any[]} */
  const snaps = [];
  const F = {
    collection: (/** @type {any} */ _db, /** @type {string[]} */ ...p) => ({ path: p.join('/') }),
    where: (/** @type {any[]} */ ...w) => ({ where: w }),
    query: (/** @type {any} */ col, /** @type {any[]} */ ...fs) => ({ ...col, fs }),
    onSnapshot: (/** @type {any} */ q, /** @type {any} */ _o, /** @type {(s: any) => void} */ cb) => {
      queries.push(q);
      const d = { id: 'p1', data: () => ({ name: 'Fake Applicant' }), metadata: { hasPendingWrites: false } };
      cb({ metadata: { fromCache: false, hasPendingWrites: false }, size: 1, docs: [d], docChanges: () => [{ type: 'added', doc: d }] });
      return () => {};
    },
  };
  const b = createFirestoreBackend({ sdk: async () => /** @type {any} */ ({ db: {}, F }), path, unstampedColls: ['applications'] });
  b.listen(S, 'applications', { since: 1000 }, s => snaps.push(s), e => { throw e; });
  b.listen(S, 'items', { since: 1000 }, s => snaps.push(s), e => { throw e; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(queries[0].fs, undefined, 'no "changed since" filter on the unstamped collection');
  assert.equal(snaps[0].full, true, 'its server snapshot is the whole collection');
  assert.equal(queries[1].fs.length, 1, 'other collections still read what changed since');
  assert.equal(snaps[1].full, undefined);
});
