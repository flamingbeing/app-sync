// Run with: node --test test/fixes.test.mjs
// One test per bug fixed in this module (see CHANGELOG.md). Each failed before its fix. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTombFeed, createCollectionSync, createSyncHub, SKEW, FULL_EVERY } from '../src/sync.js';
import { createWriteQueue, watchSaved } from '../src/writes.js';
import { createStores } from '../src/store.js';
import { fakeServer } from './fake-server.mjs';

const DAY = 864e5, H = 3600e3, T0 = Date.parse('2026-01-05T08:00:00Z');
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const KINDS = { item: 'items' };
const S = 'fake@example.com';

test('the bin feed is anchored to the newest deletedAt it has seen (a reader whose clock ran ahead)', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'fix-b1:', colls: ['items'] });
  const srv = fakeServer(), store = await openStore(S), got = [];
  const apply = async byColl => { for (const t of byColl.items || []) got.push(t.id); };
  srv.set('bin', { id: 'b0', kind: 'item', data: { id: 'x0' }, deletedAt: T0 - 60e3 });
  // first open: this device's clock is 2 h fast
  let now = T0 + 2 * H;
  let feed = createTombFeed({ scope: S, store, listen: srv.listen, apply, kinds: KINDS, now: () => now });
  await feed.ready; await settle(); await feed.flush(); await feed.stop();
  assert.deepEqual(got, ['x0']);
  // another device bins a record at T0 + 1 h (its clock right); this device opens again with its clock put right
  srv.set('bin', { id: 'b1', kind: 'item', data: { id: 'x1' }, deletedAt: T0 + H });
  now = T0 + 4 * H;
  feed = createTombFeed({ scope: S, store, listen: srv.listen, apply, kinds: KINDS, now: () => now });
  await feed.ready; await settle(); await feed.flush(); await feed.stop();
  assert.ok(got.includes('x1'), 'the entry stamped before the fast clock\'s syncAt still arrives');
  await wipeStores();
});

test('a page left open past the weekly full read reads in full when it wakes (replan)', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'fix-b4:', colls: ['items'] });
  const srv = fakeServer();
  srv.set('items', { id: 'keep', updatedAt: T0 - DAY }); srv.set('items', { id: 'gone', updatedAt: T0 - DAY });
  let now = T0;
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now, grace: 0, bin: null });
  let last = [];
  const off = hub.watch(S, 'items', l => { last = l.map(d => d.id).sort(); });
  await settle(); await hub.flush();
  off(); await settle(); await hub.stopAll();
  // the next open is a delta listener; then the page stays open 8 days, and a record is deleted with no tombstone
  now = T0 + H;
  const off2 = hub.watch(S, 'items', l => { last = l.map(d => d.id).sort(); });
  await settle(); await hub.flush();
  assert.deepEqual(last, ['gone', 'keep']);
  now = T0 + 8 * DAY; srv.del('items', 'gone'); await settle();
  assert.deepEqual(last, ['gone', 'keep'], 'a delta query never hears of a delete outside its result set');
  assert.equal(hub.replan(), 1);
  await settle(); await hub.flush();
  assert.deepEqual(last, ['keep'], 'healed by the full read');
  assert.equal(hub.replan(), 0, 'not again until due');
  off2(); await hub.stopAll(); await wipeStores();
});

test('sign-out check fails closed when the shared outbox cannot be read', async () => {
  const records = new Map(); let broken = false;
  const store = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { if (broken) throw new Error('unreadable'); return [...records.values()].filter(x => x.owner === o); }, async get(k) { return records.get(k) || null; }, async remove(k) { records.delete(k); }, async forget() {} };
  const q = createWriteQueue({ store, getOwner: () => 'a', backend: async (_o, _k, r) => r, delay: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))) });
  await q.activate('a');
  assert.equal(await q.flush(), true);
  broken = true;
  assert.equal(await q.flush(), false, 'not known to be empty: another tab\'s unsent saves may be there');
});

test('a backend call that never settles times out and the save is sent again', async () => {
  const records = new Map(), remote = new Map(); let hang = true, calls = 0;
  const store = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
  const backend = async (_o, _k, r) => { calls++; if (hang) return new Promise(() => {}); remote.set(r.id, r); return r; };
  const q = createWriteQueue({ store, getOwner: () => 'a', backend, sendTimeout: 30, delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 10)) });
  await q.save('item', 'a', { id: '1', text: 'Fake' });
  await settle(60);
  assert.equal(q.status('item', '1'), 'pending', 'still pending: nothing lost');
  hang = false; q.kick();
  await settle(40);
  assert.equal(q.status('item', '1'), 'synced');
  assert.ok(calls >= 2); assert.equal(remote.get('1').text, 'Fake');
});

test('tombstones written while a collection\'s engine starts are kept in its meta', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'fix-b9:', colls: ['items'] });
  const srv = fakeServer();
  srv.set('items', { id: 'a', updatedAt: T0 - DAY }); srv.set('items', { id: 'b', updatedAt: T0 - DAY });
  const st = await openStore(S);
  await st.write('items', { put: [srv.get('items', 'a'), srv.get('items', 'b')], meta: { syncAt: T0 - H, fullAt: T0 - DAY } });
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, now: () => T0, grace: 0, bin: null });
  const dropped = hub.drop(S, 'items', ['a']);   // no engine yet: straight into the store
  let last = null;
  const off = hub.watch(S, 'items', l => { last = l.map(d => d.id); });
  await dropped; await settle(); await hub.flush();
  off(); await settle(); await hub.stopAll();
  const meta = (await (await openStore(S)).load('items')).meta;
  assert.ok(meta.gone && meta.gone.a, 'the deleted id is remembered');
  assert.ok(!last.includes('a'));
  await wipeStores();
});

test('the server\'s copy that arrives while this device\'s save is being sent shows once the save is done (0.5.2)', async () => {
  // Two devices name themselves on one shared record at once. This device's save is in flight when the listener hears
  // the server's copy (the other device's change merged with this one): overlaid by the save, which is fine while it is
  // sent, but once it is done that copy must show, though the listener hears nothing new. Laying the queue over the
  // list only when the engine sends one (as the README showed) kept the save's own copy, without the other device's
  // change, until the record changed again.
  const records = new Map();
  const store = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
  let answer = null;
  const backend = (_o, _k, r) => new Promise(res => { answer = () => res(r); });
  const q = createWriteQueue({ store, getOwner: () => 'a', backend, delay: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))) });
  await q.activate('a');
  const subs = new Set();
  const hub = { watch: (scope, coll, cb) => { assert.equal(scope, 'a'); assert.equal(coll, 'settings'); subs.add(cb); return () => subs.delete(cb); } };
  const hear = list => { for (const cb of subs) cb(structuredClone(list), { fromCache: false, hasPendingWrites: false }); };
  const shown = [], plain = [];
  const off = watchSaved({ hub, queue: q, scope: 'a', coll: 'settings', kind: 'settings' }, (list, meta) => shown.push({ list, meta }));
  hub.watch('a', 'settings', list => plain.push(q.overlay('settings', 'a', list)));   // the old pattern, for contrast
  const v1 = { id: 'people', names: { a: 'Ann' }, updatedAt: 1 };
  hear([v1]);
  assert.deepEqual(shown.at(-1).list, [v1]);
  // this device names b; the save is sent and the server merges it with another device's rename of a
  await q.save('settings', 'a', { id: 'people', names: { a: 'Ann', b: 'Bo' }, updatedAt: 2 }, v1);
  await settle(10);
  assert.ok(answer, 'the save is being sent');
  assert.deepEqual(shown.at(-1).list[0].names, { a: 'Ann', b: 'Bo' }, 'the save shows at once');
  const merged = { id: 'people', names: { a: 'Ann 2', b: 'Bo' }, updatedAt: 3 };
  hear([merged]);
  assert.deepEqual(shown.at(-1).list[0].names, { a: 'Ann', b: 'Bo' }, 'while it is being sent the save still shows');
  answer(); await q.settle('settings', ['people']); await settle(10);
  assert.equal(q.status('settings', 'people'), 'synced');
  assert.deepEqual(plain.at(-1)[0].names, { a: 'Ann', b: 'Bo' }, 'the old pattern stays on the save\'s copy (the bug)');
  assert.deepEqual(shown.at(-1).list[0].names, { a: 'Ann 2', b: 'Bo' }, 'the server\'s copy shows once the save is done');
  assert.deepEqual((({ fromCache, hasPendingWrites }) => ({ fromCache, hasPendingWrites }))(shown.at(-1).meta), { fromCache: false, hasPendingWrites: false }, 'with the listener\'s last meta');
  assert.deepEqual(shown.at(-1).meta.removed, [], 'and the change info (0.8.2)');
  // nothing changes: nothing is handed over again
  const n = shown.length; q.kick(); await settle(10);
  assert.equal(shown.length, n);
  off();
  assert.equal(subs.size, 1, 'off stops listening (only the contrast listener is left)');
});

test('a delete heard while a save is held is applied once that record\'s saves are done (0.6.3)', async () => {
  // A record's bin entry arrives while this device holds a save of it (a conflict waiting for the user): the record
  // stays, as it must. The user then keeps the other version, which is the deleted one: the record must go. Before,
  // the kept tombstone was forgotten and the stale copy showed until the weekly full read.
  const { openStore } = createStores({ prefix: 'fix-h1:', colls: ['items'] });
  const srv = fakeServer(), store = await openStore(S);
  srv.set('items', { id: 'x1', title: 'Fake', updatedAt: 5 });
  srv.set('items', { id: 'x2', title: 'Fake 2', updatedAt: 5 });
  let held = true, shown = [];
  const sync = createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, unsent: () => held });
  sync.subscribe(list => { shown = list.map(d => d.id); });
  await sync.ready; await settle();
  assert.deepEqual(shown, ['x1', 'x2']);
  await sync.tombs([{ id: 'x1', deletedAt: 5 }]);
  assert.deepEqual(shown, ['x1', 'x2'], 'kept while its save is held');
  assert.equal(sync.tomb('x1'), 5, 'the tombstone is known');
  held = false;
  await sync.settle(); await settle();
  assert.deepEqual(shown, ['x2'], 'gone once its saves are done');
  // the same across a reload: deferred on one page, settled when the next one opens
  held = true;
  await sync.tombs([{ id: 'x2', deletedAt: 5 }]);
  await sync.stop();
  held = false;
  const again = createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, unsent: () => held });
  let after = null;
  again.subscribe(list => { after = list.map(d => d.id); });
  await again.ready; await settle();
  assert.deepEqual(after, [], 'settled when the next page opens');
  await again.stop();
});

test('a record deleted elsewhere and saved again here is stamped above the delete\'s tombstone (0.6.3)', async () => {
  // "Keep mine" after another phone deleted the record: other devices hold a tombstone at the deleted version's stamp
  // and hide any copy at or below it. A re-create stamped by a clock behind the deleter's was hidden there for good.
  const { sharedSdk } = await import('./fake-sdk.mjs');
  const { createFirestoreBackend } = await import('../src/firestore.js');
  for (const held of [false, true]) {
    const shared = sharedSdk(), b = createFirestoreBackend({ sdk: shared.device().sdk, path: (s, c) => ['spaces', s, c], ...(held ? { held: true } : {}) });
    const tomb = Date.now() + H;   // the deleter's clock an hour ahead
    const doc = await b.commit(S, 'items', { id: 'x1', title: 'Fake' }, null, { after: tomb });
    assert.ok(doc.updatedAt > tomb, (held ? 'held' : 'plain') + ': stamped after the tombstone');
    // an update still stamps from the server's copy
    const next = await b.commit(S, 'items', { ...doc, title: 'Fake 2' }, doc, { after: tomb + H });
    assert.equal(next.updatedAt, doc.updatedAt + 1);
  }
});

test('a save shows in the lists from the moment save() is called, before it is stored or accepted (0.7.2, #19)', async () => {
  const records = new Map();
  let release = null;
  const gate = () => new Promise(r => { release = r; });
  const store = { async put(x) { if (!x.accepted && x.state === 'pending' && release === null) await gate(); records.set(x.key, structuredClone(x)); },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
  const q = createWriteQueue({ store, getOwner: () => 'a', online: () => false, delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 30 : 100)),
    backend: async (_o, _k, record) => record });
  await q.activate('a');
  const list = [{ id: 'p1', order: 1 }, { id: 'p2', order: 2 }];
  const handed = [];
  q.onChange(() => handed.push(q.overlay('place', 'a', list).find(x => x.id === 'p1').order));
  const saving = q.save('place', 'a', { id: 'p1', order: 3 }, list[0]);
  // not stored yet (the outbox write waits): already shown
  assert.equal(q.overlay('place', 'a', list).find(x => x.id === 'p1').order, 3, 'shown before it is stored');
  assert.equal(handed.at(-1), 3, 'and the lists were told');
  while (!release) await new Promise(r => setTimeout(r, 1));
  assert.equal(q.overlay('place', 'a', list).find(x => x.id === 'p1').order, 3, 'still shown while it is being stored');
  release(); await new Promise(r => setTimeout(r, 5));
  // stored, offline, not accepted yet (save() has not returned): still shown
  assert.equal(q.overlay('place', 'a', list).find(x => x.id === 'p1').order, 3, 'shown while not accepted');
  await saving;
  assert.equal(q.overlay('place', 'a', list).find(x => x.id === 'p1').order, 3);
  // a save the queue refuses at once (storage) leaves the lists again
  const q2 = createWriteQueue({ store: { ...store, async put() { throw new Error('quota'); } }, getOwner: () => 'a', online: () => false, backend: async (_o, _k, r) => r });
  await q2.activate('a');
  const p = q2.save('place', 'a', { id: 'p2', order: 9 }, list[1]);
  assert.equal(q2.overlay('place', 'a', list).find(x => x.id === 'p2').order, 9);
  await assert.rejects(p);
  assert.equal(q2.overlay('place', 'a', list).find(x => x.id === 'p2').order, 2, 'refused: the list shows the server copy again');
});
