// Run with: node --test test/adopt.test.mjs
// 0.2.0: what apps that used whole-collection listeners and last-write-wins saves need to adopt the engine (see
// CHANGELOG.md). Each test failed before its change. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHub, createCollectionSync, applyChanges, plan, timeOf, expireDocs } from '../src/sync.js';
import { createWriteQueue } from '../src/writes.js';
import { mergeFields } from '../src/conflict.js';
import { createStores } from '../src/store.js';
import { fakeServer } from './fake-server.mjs';

const DAY = 864e5, T0 = Date.parse('2026-01-05T08:00:00Z');
const iso = t => new Date(t).toISOString();
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const S = 'fake-space';

test('stamps may be ISO strings as well as numbers', () => {
  assert.equal(timeOf(iso(T0)), T0);
  assert.equal(timeOf(T0), T0);
  assert.equal(timeOf('not a time'), 0);
  assert.equal(timeOf(undefined), 0);
  // a copy older than a known deletion is skipped, whatever form its stamp takes
  const docs = new Map();
  applyChanges(docs, [{ type: 'added', id: 'a', doc: { id: 'a', updatedAt: iso(T0) } }], { a: T0 + 1 });
  assert.equal(docs.size, 0);
  applyChanges(docs, [{ type: 'added', id: 'a', doc: { id: 'a', updatedAt: iso(T0 + 2) } }], { a: T0 + 1 });
  assert.equal(docs.size, 1);
});

test('the delta read is anchored to the newest ISO stamp held', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'adopt-iso:', colls: ['items'] });
  const srv = fakeServer(), seen = [];
  srv.set('items', { id: 'a', updatedAt: iso(T0 - DAY) });
  let now = T0;
  const listen = (...a) => { seen.push(a[2].since); return srv.listen(...a); };
  let e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now });
  await e.ready; await settle(); await e.stop();
  now = T0 + DAY;
  e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now });
  await e.ready; await settle(); await e.stop();
  assert.equal(seen[0], null);
  assert.equal(seen[1], T0 - DAY, 'read from the newest stamp held (an ISO string), not from 0');
  await wipeStores();
});

test('unstamped: "full" keeps reading in full while a held document has no stamp', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'adopt-unstamped:', colls: ['items'] });
  const srv = fakeServer(), seen = [];
  srv.set('items', { id: 'old', text: 'Fake, from before stamps' });
  srv.set('items', { id: 'new', text: 'Fake', updatedAt: T0 - DAY });
  let now = T0;
  const listen = (...a) => { seen.push(a[2].since); return srv.listen(...a); };
  const open = async () => {
    const e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now, unstamped: 'full' });
    let list = []; e.subscribe(l => { list = l; });
    await e.ready; await settle(); await e.stop(); return list;
  };
  await open();
  now += 60e3;
  // an older app version changes the unstamped document: a delta read would never see it
  srv.set('items', { id: 'old', text: 'Fake, changed without a stamp' });
  const list = await open();
  assert.deepEqual(seen, [null, null], 'both opens read in full');
  assert.equal(list.find(d => d.id === 'old').text, 'Fake, changed without a stamp');
  // once every document is stamped (the backfill), opens read only changes again
  srv.set('items', { id: 'old', text: 'Fake, changed without a stamp', updatedAt: now - 1000 });
  now += 60e3; await open();
  now += 60e3; await open();
  assert.notEqual(seen.at(-1), null, 'a delta read once nothing held lacks a stamp');
  await wipeStores();
});

test('a planned delta read still happens by default with an unstamped document (as in 0.1.0)', () => {
  assert.equal(plan({ syncAt: T0, fullAt: T0 }, T0 + 1000, 0).full, false);
});

test('expire: a soft-deleted record goes from this device once its removal is older than "after"', async () => {
  const docs = new Map([
    ['a', { id: 'a', removedAt: iso(T0 - 31 * DAY), updatedAt: iso(T0 - 31 * DAY) }],
    ['b', { id: 'b', removedAt: iso(T0 - DAY), updatedAt: iso(T0 - DAY) }],
    ['c', { id: 'c', updatedAt: iso(T0 - 40 * DAY) }],
  ]);
  const gone = {};
  assert.deepEqual(expireDocs(docs, gone, { field: 'removedAt', after: 30 * DAY }, T0), ['a']);
  assert.deepEqual([...docs.keys()], ['b', 'c']);
  assert.equal(gone.a, T0 - 31 * DAY, 'remembered at its stamp: a restored copy (stamped later) shows again');

  // through the hub: the swept record leaves the device even though no delete reaches a delta listener
  const { openStore, wipeStores } = createStores({ prefix: 'adopt-expire:', colls: ['places'] });
  const srv = fakeServer();
  srv.set('places', { id: 'p1', name: 'Fake shelf', updatedAt: T0 - 2 * DAY });
  srv.set('places', { id: 'p2', name: 'Fake box', removedAt: T0 - 29 * DAY, updatedAt: T0 - 29 * DAY });
  let now = T0;
  const hub = createSyncHub({ openStore, listen: srv.listen, now: () => now, grace: 0, bin: null, expire: { places: { field: 'removedAt', after: 30 * DAY } } });
  let list = [];
  let off = hub.watch(S, 'places', l => { list = l; });
  await settle(20); off(); await settle(5); await hub.stopAll();
  assert.equal(list.length, 2);
  srv.del('places', 'p2');            // another device's sweep, two days later
  now = T0 + 2 * DAY;
  off = hub.watch(S, 'places', l => { list = l; });
  await settle(20);
  assert.deepEqual(list.map(d => d.id), ['p1']);
  off(); await settle(5); await hub.stopAll(); await wipeStores();
});

test('mergeFields: fields changed since base win, the rest keep what the server holds now (deep)', () => {
  const base = { id: 'r', site: 'X', f: { a: { v: 1 }, b: { v: 2 } }, note: 'old', updatedAt: 1 };
  const record = { id: 'r', site: 'X', f: { a: { v: 10 }, b: { v: 2 } }, updatedAt: 1 };          // a changed, note removed
  const current = { id: 'r', site: 'X', f: { a: { v: 1 }, b: { v: 20 }, c: { v: 3 } }, note: 'old', other: 'kept', updatedAt: 5 };
  assert.deepEqual(mergeFields(current, record, base), { id: 'r', site: 'X', f: { a: { v: 10 }, b: { v: 20 }, c: { v: 3 } }, other: 'kept', updatedAt: 5 });
  // no base (not known here yet): every field sent is merged into whatever is there
  assert.deepEqual(mergeFields({ id: 'r', x: 1, m: { k: 1 } }, { id: 'r', y: 2, m: { j: 2 } }, null), { id: 'r', x: 1, y: 2, m: { k: 1, j: 2 } });
  assert.deepEqual(mergeFields(null, { id: 'r', y: 2 }, null), { id: 'r', y: 2 });
});

test('save(…, { ops }) hands the ops and the job key to the backend; a failed save replaced keeps its ops', async () => {
  const records = new Map(), calls = [];
  let fail = true;
  const store = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
  const q = createWriteQueue({ store, getOwner: () => 'a', delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 50)),
    backend: async (_o, _k, record, _base, extra) => { calls.push(structuredClone(extra)); if (fail) throw new Error('refused'); return record; } });
  await assert.rejects(q.save('item', 'a', { id: 'i', qty: 2 }, { id: 'i', qty: 3 }, { ops: { inc: { qty: -1 } } }));
  assert.deepEqual(calls[0].ops, [{ inc: { qty: -1 } }]);
  assert.ok(calls[0].key);
  fail = false;
  await q.save('item', 'a', { id: 'i', qty: 1 }, { id: 'i', qty: 2 }, { ops: { inc: { qty: -1 } } });
  assert.deepEqual(calls[1].ops, [{ inc: { qty: -1 } }, { inc: { qty: -1 } }], 'both changes are sent: the failed one is not lost');
  assert.equal(q.status('item', 'i'), 'synced');
  // a save without ops (0.1.0 callers) sends none
  await q.save('item', 'a', { id: 'j', qty: 1 }, null);
  assert.equal(calls.at(-1).ops, undefined);
});
