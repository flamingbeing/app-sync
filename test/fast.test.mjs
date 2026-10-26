// Run with: node --test test/fast.test.mjs
// (1.3.12) the hot paths made cheaper (tools/bench.mjs) hand exactly what they handed before: watchSaved, the queue's
// newest-job reads and overlay, the hub's lists, the Firestore adapter's whole read. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHub } from '../src/sync.js';
import { createStores } from '../src/store.js';
import { createWriteQueue, watchSaved } from '../src/writes.js';
import { createFirestoreBackend } from '../src/firestore.js';

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
let n = 0;
function memStore() {
  const records = new Map();
  return { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); },
    async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
}
async function makeQueue({ hold = false } = {}) {
  /** @type {(() => void)[]} */
  const waiting = [];
  const backend = async (_o, _k, r) => { if (hold) await new Promise(res => { waiting.push(res); }); return { ...r, updatedAt: (r.updatedAt || 0) + 100 }; };
  const q = createWriteQueue({ store: memStore(), getOwner: () => 'a', backend, delay: () => settle(1) });
  await q.activate('a');
  return { q, release: () => { for (const r of waiting.splice(0)) r(); }, done: async () => { hold = false; for (const r of waiting.splice(0)) r(); await settle(30); } };
}
function fakeHub() {
  const subs = new Set();
  return { hub: { watch: (_s, _c, cb) => { subs.add(cb); return () => subs.delete(cb); } }, hear: list => { for (const cb of subs) cb(structuredClone(list), { fromCache: false, hasPendingWrites: false }); } };
}

test('watchSaved (1.3.12): a queue change that changes no record hands nothing; each list handed is its own copy', async () => {
  const { q, release } = await makeQueue({ hold: true });
  const { hub, hear } = fakeHub();
  /** @type {{ list: any[], meta: any }[]} */
  const shown = [];
  const off = watchSaved({ hub, queue: q, scope: 'a', coll: 'items', kind: 'item' }, (list, meta) => shown.push({ list, meta }));
  const one = { id: 'one', text: 'Fake one', updatedAt: 1 }, two = { id: 'two', text: 'Fake two', updatedAt: 1 };
  hear([one, two]);
  assert.equal(shown.length, 1);
  shown[0].list[0].text = 'changed by the app';   // the app's copy: the engine's is not touched
  const saving = q.save('note', 'a', { id: 'n1', text: 'Fake note' });   // another kind: nothing here changes
  await settle(10);
  assert.equal(shown.length, 1, 'a save of another kind hands nothing');
  const mine = q.save('item', 'a', { ...two, text: 'Fake mine', updatedAt: 2 }, two);
  await settle(10);
  assert.equal(shown.length, 2);
  assert.deepEqual(shown[1].list, [one, { ...two, text: 'Fake mine', updatedAt: 2 }]);
  assert.deepEqual(shown[1].meta.changed, ['two']);
  assert.notEqual(shown[1].list[0], shown[0].list[0]);
  assert.deepEqual(off.copyOf('one'), one);
  release(); await saving; release(); await mine; await settle(20); release(); await settle(20);
  assert.equal(q.status('item', 'two'), 'synced');
  hear([one, { ...two, text: 'Fake mine', updatedAt: 102 }]);
  assert.deepEqual(shown.at(-1).list, [one, { ...two, text: 'Fake mine', updatedAt: 102 }]);
  off();
});

test('queue.status and jobKey (1.3.12): the newest job of that record of that kind, as before', async () => {
  const { q } = await makeQueue();
  await q.save('item', 'a', { id: 'r1', text: 'Fake 1', updatedAt: 1 });
  await q.save('note', 'a', { id: 'r1', text: 'Fake note', updatedAt: 1 });
  await q.save('item', 'a', { id: 'r1', text: 'Fake 2', updatedAt: 2 });
  await settle(30);
  const items = q.entries().filter(x => x.kind === 'item' && x.record.id === 'r1');   // newest first
  assert.equal(q.jobKey('item', 'r1'), items[0].key);
  assert.equal(q.status('item', 'r1'), items[0].state);
  assert.equal(q.jobKey('note', 'r1'), q.entries().find(x => x.kind === 'note').key);
  assert.equal(q.jobKey('item', 'nope'), '');
  assert.equal(q.status('item', 'nope'), '');
});

test('queue.overlay (1.3.12): each record shows its newest unsent save, several records and saves at once', async () => {
  const { q, done } = await makeQueue({ hold: true });
  const list = [{ id: 'r1', text: 'Fake server 1', updatedAt: 1 }, { id: 'r2', text: 'Fake server 2', updatedAt: 1 }, { id: 'r3', text: 'Fake server 3', updatedAt: 1 }];
  void q.save('item', 'a', { id: 'r1', text: 'Fake r1 a', updatedAt: 2 }, list[0]).catch(() => {});
  void q.save('item', 'a', { id: 'r2', _deleted: true, updatedAt: 2 }, list[1]).catch(() => {});
  void q.save('item', 'a', { id: 'r4', text: 'Fake new', updatedAt: 2 }).catch(() => {});
  await settle(10);
  void q.save('item', 'a', { id: 'r1', text: 'Fake r1 b', updatedAt: 3 }, list[0]).catch(() => {});
  void q.save('note', 'a', { id: 'r3', text: 'Fake other kind', updatedAt: 3 }).catch(() => {});
  await settle(10);
  assert.deepEqual(q.overlay('item', 'a', list).map(d => [d.id, d.text]), [['r1', 'Fake r1 b'], ['r3', 'Fake server 3'], ['r4', 'Fake new']]);
  assert.equal(q.overlay('item', 'someone else', list), list);
  await done();
});

test('the hub (1.3.12): every subscriber gets its own copy of each list', async () => {
  /** @type {((s: any) => void) | null} */
  let snap = null;
  const listen = (_s, _c, _p, onSnap) => { snap = onSnap; queueMicrotask(() => onSnap({ full: true, fromCache: false, hasPendingWrites: false, changes: [], docs: [{ id: 'r1', text: 'Fake', updatedAt: 1 }] })); return () => {}; };
  const { openStore } = createStores({ prefix: 'fast' + (++n) + ':', colls: ['items'] });
  const hub = createSyncHub({ openStore, listen, bin: null, grace: 0 });
  /** @type {any[][]} */
  const a = [], b = [];
  hub.watch('s', 'items', l => a.push(l)); hub.watch('s', 'items', l => b.push(l));
  await settle(20);
  /** @type {any} */ (snap)({ fromCache: false, hasPendingWrites: false, changes: [{ type: 'modified', id: 'r1', doc: { id: 'r1', text: 'Fake 2', updatedAt: 2 } }] });
  await hub.flush(); await settle(5);
  assert.deepEqual(a.at(-1), [{ id: 'r1', text: 'Fake 2', updatedAt: 2 }]);
  assert.deepEqual(b.at(-1), a.at(-1));
  assert.notEqual(a.at(-1), b.at(-1)); assert.notEqual(a.at(-1)[0], b.at(-1)[0]);
  a.at(-1)[0].text = 'changed by one app view';
  assert.equal(b.at(-1)[0].text, 'Fake 2');
});

test('Firestore listen (1.3.12): a whole read after a cached answer lists every record, read once each', async () => {
  /** @type {any[]} */
  const snaps = [];
  let reads = 0;
  const doc = (id, v) => ({ id, data: () => { reads++; return { text: v }; }, metadata: { hasPendingWrites: false } });
  const F = {
    collection: (_db, ...p) => ({ path: p.join('/') }), where: (...w) => ({ where: w }), query: (col, ...fs) => ({ ...col, fs }),
    onSnapshot: (_q, _o, cb) => {
      const d1 = doc('p1', 'Fake 1'), d2 = doc('p2', 'Fake 2'), d3 = doc('p3', 'Fake 3 new');
      cb({ metadata: { fromCache: true, hasPendingWrites: false }, size: 2, docs: [d1, d2], docChanges: () => [{ type: 'added', doc: d1 }, { type: 'added', doc: d2 }] });
      reads = 0;
      cb({ metadata: { fromCache: false, hasPendingWrites: false }, size: 2, docs: [d1, d3], docChanges: () => [{ type: 'removed', doc: d2 }, { type: 'added', doc: d3 }] });
      return () => {};
    },
  };
  const b = createFirestoreBackend({ sdk: async () => /** @type {any} */ ({ db: {}, F }), path: (s, c) => ['scopes', s, c], unstampedColls: ['items'] });
  b.listen('s', 'items', { since: null }, s => snaps.push(s), e => { throw e; });
  await settle(5);
  const full = snaps.find(s => s.full);
  assert.deepEqual(full.docs.map(d => [d.id, d.text]), [['p1', 'Fake 1'], ['p3', 'Fake 3 new']]);
  assert.deepEqual(full.changes.map(c => [c.type, c.id]), [['removed', 'p2'], ['added', 'p3']]);
  assert.equal(reads, 2, 'p3 read once for its change and reused, p1 read for the list');
});
