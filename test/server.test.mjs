// Run with: node --test test/server.test.mjs
// 0.3.0: server stamps (stampMode: 'server'), the weekly full read re-planned on a timer, and extra tombstone feeds
// (records that left a query). Each test failed before its change. Made-up data only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHub, createCollectionSync, planServer, replanOnWake, leaveEntry, FULL_EVERY, SKEW } from '../src/sync.js';
import { createStores } from '../src/store.js';
import { fakeServer } from './fake-server.mjs';

const DAY = 864e5, H = 3600e3, T0 = Date.parse('2026-01-05T08:00:00Z');
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const S = 'fake-space';

test('planServer: a full read first and weekly; otherwise from the newest server stamp, whatever this clock says', () => {
  assert.equal(planServer({}, T0).full, true);
  assert.equal(planServer({ syncAt: T0, fullAt: T0 }, T0 + 1000).full, true, 'no server anchor yet: full');
  const meta = { syncAt: T0 - 3 * H, fullAt: T0 - 3 * H, anchor: T0 - 5 * DAY };
  for (const now of [T0 - 2 * H, T0 + 1000, T0 + 2 * H]) {
    const p = planServer(meta, now);
    assert.equal(p.full, false);
    assert.equal(p.since, T0 - 5 * DAY - 1, 'no SKEW and no local clock in the delta read');
  }
  assert.equal(planServer(meta, T0 + FULL_EVERY + 1).full, true, 'weekly full read');
  assert.equal(planServer({ ...meta, fullAt: T0 + 2 * SKEW }, T0).full, true, 'a clock gone back reads in full');
});

test('server stamps: a write that reached the server late is seen by readers whose clocks are hours off', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'srv-late:', colls: ['items'] });
  const srv = fakeServer(), seen = [];
  srv.set('items', { id: 'a', text: 'Fake', updatedAt: T0 - DAY, serverAt: T0 - DAY });
  const listen = (...a) => { seen.push({ since: a[2].since, field: a[2].field }); return srv.listen(...a); };
  const open = async now => {
    const e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now, stampMode: 'server' });
    let list = []; e.subscribe(l => { list = l; });
    await e.ready; await settle(); await e.stop(); return list;
  };
  await open(T0 + 2 * H);   // this reader's clock is 2 h fast
  // a writer offline for days (its clock 3 days behind) reaches the server now: the server stamps it
  srv.set('items', { id: 'b', text: 'Fake, written offline', updatedAt: T0 - 3 * DAY, serverAt: T0 + 60e3 });
  let list = await open(T0 + 2 * H + 60e3);
  assert.ok(list.some(d => d.id === 'b'), 'fast reader sees it');
  assert.equal(seen[1].field, 'serverAt');
  assert.equal(seen[1].since, T0 - DAY - 1, 'read from the newest server stamp held');
  srv.set('items', { id: 'c', text: 'Fake, later', updatedAt: T0 - 3 * DAY, serverAt: T0 + 120e3 });
  list = await open(T0 - 2 * H);   // the same reader, its clock now 2 h slow
  assert.ok(list.some(d => d.id === 'c'), 'slow reader sees it');
  await wipeStores();
});

test('server stamps: pending stamps and cached snapshots never move the anchor', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'srv-pending:', colls: ['items'] });
  const seen = [];
  let emit;
  const listen = (_s, _c, opts, onSnap) => { seen.push(opts.since); emit = onSnap; return () => {}; };
  let now = T0;
  const e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now, stampMode: 'server' });
  await e.ready;
  emit({ full: true, docs: [{ id: 'a', serverAt: T0 - DAY }], changes: [], fromCache: false });
  // this device's own write, not on the server yet: its stamp is unresolved (null) or an estimate
  emit({ changes: [{ type: 'modified', id: 'a', pending: true, doc: { id: 'a', text: 'Fake edit', serverAt: null } }], fromCache: false, hasPendingWrites: true });
  emit({ changes: [{ type: 'added', id: 'x', pending: true, doc: { id: 'x', serverAt: T0 + DAY } }], fromCache: false, hasPendingWrites: true });
  // a cached snapshot (not confirmed by the server)
  emit({ changes: [{ type: 'added', id: 'y', doc: { id: 'y', serverAt: T0 + 2 * DAY } }], fromCache: true, hasPendingWrites: false });
  // the server confirms: the write now has its server stamp
  emit({ changes: [{ type: 'modified', id: 'a', doc: { id: 'a', text: 'Fake edit', serverAt: T0 + 5 } }, { type: 'modified', id: 'x', doc: { id: 'x', serverAt: T0 + 4 } }], fromCache: false, hasPendingWrites: false });
  await e.stop();
  const meta = (await (await openStore(S)).load('items')).meta;
  assert.equal(meta.anchor, T0 + 5, 'only confirmed server stamps count');
  await wipeStores();
});

test('server stamps: a held document without a resolved server stamp makes the next open a full read', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'srv-unstamped:', colls: ['items'] });
  const srv = fakeServer(), seen = [];
  srv.set('items', { id: 'old', text: 'Fake, from before server stamps', updatedAt: T0 - DAY });
  srv.set('items', { id: 'new', text: 'Fake', updatedAt: T0 - DAY, serverAt: T0 - DAY });
  const listen = (...a) => { seen.push(a[2].since); return srv.listen(...a); };
  const open = async now => {
    const e = createCollectionSync({ scope: S, coll: 'items', store: await openStore(S), listen, now: () => now, stampMode: 'server' });
    await e.ready; await settle(); await e.stop();
  };
  await open(T0); await open(T0 + 60e3);
  assert.deepEqual(seen, [null, null], 'unstamped: full reads');
  srv.set('items', { id: 'old', text: 'Fake, from before server stamps', updatedAt: T0 - DAY, serverAt: T0 });   // the backfill
  await open(T0 + 120e3); await open(T0 + 180e3);
  assert.equal(seen.at(-1), T0 - 1, 'a delta read once every held document has a server stamp');
  await wipeStores();
});

test('a page left open and visible for days re-plans its weekly full read on a timer (B4)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const win = { addEventListener() {}, removeEventListener() {}, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } };
    let calls = 0;
    const stop = replanOnWake({ replan: () => { calls++; return 0; } }, win);
    mock.timers.tick(8 * DAY);
    assert.ok(calls >= 8 * 24, 'checked at least hourly: ' + calls);
    stop();
    const after = calls;
    mock.timers.tick(DAY);
    assert.equal(calls, after, 'stopped');
  } finally { mock.timers.reset(); }
});

test('extra tombstone feeds: a record that left the query (locked) leaves a closed device at its next open', async () => {
  const { openStore, wipeStores } = createStores({ prefix: 'srv-leave:', colls: ['items'], metaOnly: ['bin', 'leaves'] });
  const srv = fakeServer();
  srv.set('items', { id: 'p1', updatedAt: T0 - DAY }); srv.set('items', { id: 'p2', updatedAt: T0 - DAY });
  let now = T0;
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now, grace: 0, bin: null, feeds: { leaves: { item: 'items' } } });
  let last = [];
  let off = hub.watch(S, 'items', l => { last = l.map(d => d.id).sort(); });
  await settle(); await hub.flush(); off(); await settle(); await hub.stopAll();
  assert.deepEqual(last, ['p1', 'p2']);
  // while this device is closed, p1 is locked: it leaves the query (here: gone from it), and a leave entry is published
  const locked = { id: 'p1', updatedAt: T0 + H, locked: true };
  srv.del('items', 'p1');
  const entry = leaveEntry('item', locked, T0 + H);
  // 0.4.0: deletedAt is max(at, updatedAt + 1), always after the version it removes (0.3.0 gave at itself)
  assert.deepEqual(entry, { id: 'item:p1', kind: 'item', data: { id: 'p1', updatedAt: T0 + H }, deletedAt: T0 + H + 1 });
  srv.set('leaves', entry);
  now = T0 + 2 * H;
  off = hub.watch(S, 'items', l => { last = l.map(d => d.id).sort(); });
  await settle(); await hub.flush(); await settle(); await hub.flush();
  assert.deepEqual(last, ['p2'], 'dropped at the next open, not at the weekly full read');
  // unlocked later (a newer version): it shows again
  srv.set('items', { id: 'p1', updatedAt: T0 + 3 * H });
  now = T0 + 3 * H;
  await settle(); await hub.flush();
  assert.deepEqual(last, ['p1', 'p2']);
  off(); await hub.stopAll(); await wipeStores();
});
