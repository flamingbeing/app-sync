// Run with: node --test test/fixes.test.mjs
// One test per bug fixed in this module (see CHANGELOG.md). Each failed before its fix. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTombFeed, createCollectionSync, createSyncHub, SKEW, FULL_EVERY } from '../src/sync.js';
import { createWriteQueue } from '../src/writes.js';
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
