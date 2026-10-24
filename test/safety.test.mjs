// Run with: node --test test/safety.test.mjs
// 0.4.0: stamps that only move forward, the commit hook, aborted transactions retried, an honest status, the record
// that leaves a query with unsent saves, and one sign-out (forgetDevice). Each test failed before its change. The
// adapter runs here on a small fake of the Firestore SDK (its emulator test is in firestore.emulator.mjs). Made-up
// data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreBackend } from '../src/firestore.js';
import { createWriteQueue } from '../src/writes.js';
import { syncStatus } from '../src/status.js';
import { createCollectionSync, createSyncHub, leaveEntry } from '../src/sync.js';
import { createStores } from '../src/store.js';
import { forgetDevice } from '../src/forget.js';
import { fakeServer } from './fake-server.mjs';

const H = 3600e3;
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const S = 'fake-space';

// ---- a fake of the modular Firestore SDK: documents by path, transactions applied whole at the end ----
function fakeSdk() {
  const docs = new Map(), calls = [], commits = [];
  const db = { name: 'fake-db' };
  const SERVER = { serverTimestamp: true };
  const F = {
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    doc: (parent, ...segs) => {
      const path = parent === db ? segs.join('/') : parent.path + '/' + segs.join('/');
      return { path, id: path.split('/').at(-1) };
    },
    serverTimestamp: () => SERVER,
    async runTransaction(_db, fn) {
      const writes = [];
      const tx = {
        async get(ref) { const d = docs.get(ref.path); return { id: ref.id, exists: () => !!d, data: () => structuredClone(d) }; },
        set(ref, data) { writes.push({ path: ref.path, data: structuredClone(data) }); return tx; },
        delete(ref) { writes.push({ path: ref.path, delete: true }); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) if (w.delete) docs.delete(w.path); else docs.set(w.path, w.data);
      commits.push(writes);
      return out;
    },
    async terminate(d) { calls.push(['terminate', d.name]); },
    async clearIndexedDbPersistence(d) { calls.push(['clearIndexedDbPersistence', d.name]); },
  };
  return { db, F, docs, calls, commits, sdk: async () => ({ db, F }) };
}
const backendOf = (fake, opts = {}) => createFirestoreBackend({ sdk: fake.sdk, path: (scope, coll) => ['spaces', scope, coll], ...opts });

// ---- stamps move forward ----

test('commit stamps max(now, the server copy + 1): a writer whose clock is behind still moves the stamp forward', async () => {
  const fake = fakeSdk(), b = backendOf(fake);
  const ahead = Date.now() + H;   // last written by a device whose clock was an hour fast
  fake.docs.set(`spaces/${S}/items/r1`, { id: 'r1', text: 'Fake one', updatedAt: ahead });
  const base = { id: 'r1', text: 'Fake one', updatedAt: ahead };
  const out = await b.commit(S, 'items', { id: 'r1', text: 'Fake edit' }, base);
  assert.equal(out.updatedAt, ahead + 1);
  assert.equal(fake.docs.get(`spaces/${S}/items/r1`).updatedAt, ahead + 1);
  // a new record, or a server copy behind this clock: now
  const t = Date.now(), fresh = await b.commit(S, 'items', { id: 'r2', text: 'Fake two' }, null);
  assert.ok(fresh.updatedAt >= t && fresh.updatedAt < t + 1000);
});

test('merge commits and ISO stamps move forward too; an app\'s own stamp function is left alone', async () => {
  const fake = fakeSdk(), ahead = Date.now() + H;
  fake.docs.set(`spaces/${S}/notes/n1`, { id: 'n1', a: 1, updatedAt: ahead });
  const out = await backendOf(fake, { merge: { notes: true } }).commit(S, 'notes', { id: 'n1', a: 2 }, { id: 'n1', a: 1 });
  assert.equal(out.updatedAt, ahead + 1);
  const iso = fakeSdk();
  iso.docs.set(`spaces/${S}/items/i1`, { id: 'i1', updatedAt: new Date(ahead).toISOString() });
  const o2 = await backendOf(iso, { time: 'iso' }).commit(S, 'items', { id: 'i1', x: 1 }, { id: 'i1' });
  assert.equal(o2.updatedAt, new Date(ahead + 1).toISOString());
  const own = fakeSdk();
  own.docs.set(`spaces/${S}/items/i1`, { id: 'i1', updatedAt: ahead });
  const o3 = await backendOf(own, { stamp: d => ({ ...d, updatedAt: 5 }) }).commit(S, 'items', { id: 'i1', x: 1 }, { id: 'i1' });
  assert.equal(o3.updatedAt, 5, 'stamp option: unchanged from 0.3.0');
});

test('stamp(prev) and stampFields(prev) give max(now, prev + 1) for an app\'s own writes', async () => {
  const b = backendOf(fakeSdk()), ahead = Date.now() + H;
  assert.equal(b.stamp(ahead), ahead + 1);
  assert.ok(Math.abs(b.stamp() - Date.now()) < 1000, 'no argument: now, as before');
  assert.equal((await b.stampFields(ahead)).updatedAt, ahead + 1);
});

test('leaveEntry stamps after the record it removes, in the type of at', () => {
  const ahead = Date.now() + H, rec = { id: 'r1', updatedAt: ahead };
  assert.equal(leaveEntry('item', rec).deletedAt, ahead + 1);
  assert.equal(leaveEntry('item', rec, ahead + 50).deletedAt, ahead + 50);
  assert.equal(leaveEntry('item', { id: 'r2', updatedAt: 10 }, 99).deletedAt, 99, 'later than the record: at, as before');
  assert.equal(leaveEntry('item', rec, new Date(ahead - H).toISOString()).deletedAt, new Date(ahead + 1).toISOString());
});

// ---- the commit hook: more writes in the same transaction ----

test('onCommit adds writes to the same transaction (a leave entry with a lock), only when the record is written', async () => {
  const fake = fakeSdk(), seen = [];
  const b = backendOf(fake, {
    onCommit: ctx => {
      seen.push(ctx);
      return ctx.after && ctx.after.locked && !(ctx.before && ctx.before.locked)
        ? [{ path: ['spaces', ctx.scope, 'leaves', 'item:' + ctx.after.id], data: { ...leaveEntry('item', ctx.after, ctx.at), ...ctx.fields } }]
        : [];
    },
  });
  const v1 = await b.commit(S, 'items', { id: 'r1', text: 'Fake' }, null);
  const v2 = await b.commit(S, 'items', { ...v1, locked: true }, v1);
  const entry = fake.docs.get(`spaces/${S}/leaves/item:r1`);
  assert.ok(entry, 'the leave entry was written');
  assert.equal(entry.data.updatedAt, v2.updatedAt);
  assert.ok(entry.deletedAt > v2.updatedAt);
  assert.deepEqual(fake.commits.at(-1).map(w => w.path), [`spaces/${S}/items/r1`, `spaces/${S}/leaves/item:r1`], 'one transaction');
  const n = seen.length;
  await b.commit(S, 'items', { ...v2 }, v2);   // nothing to write
  assert.equal(seen.length, n, 'not called when nothing is written');
  await b.commit(S, 'items', { id: 'r1', _deleted: true }, v2);
  assert.equal(seen.at(-1).after, null, 'a delete: after is null');
  assert.equal(fake.docs.has(`spaces/${S}/items/r1`), false);
  await b.commit(S, 'items', { id: 'r9', text: 'x' }, null);
  const del = backendOf(fake, { onCommit: () => [{ path: ['spaces', S, 'leaves', 'item:r1'], delete: true }] });
  await del.commit(S, 'items', { id: 'r9', text: 'y' }, { id: 'r9', text: 'x' });
  assert.equal(fake.docs.has(`spaces/${S}/leaves/item:r1`), false, 'a hook write may delete');
});

test('clearCache terminates the SDK, then clears its offline cache', async () => {
  const fake = fakeSdk();
  await backendOf(fake).clearCache();
  assert.deepEqual(fake.calls, [['terminate', 'fake-db'], ['clearIndexedDbPersistence', 'fake-db']]);
});

// ---- the write queue ----

function queueFixture(backend) {
  const records = new Map(), clone = x => structuredClone(x);
  const store = { async put(x) { records.set(x.key, clone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(clone); }, async get(k) { return records.has(k) ? clone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); } };
  return { store, getOwner: () => 'a', delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 20)), backend };
}

test('an aborted transaction (two phones at once) is retried, not a failure that needs the user', async () => {
  let n = 2;
  const q = createWriteQueue(queueFixture(async (_o, _k, record) => {
    if (n-- > 0) throw Object.assign(new Error('Transaction aborted'), { code: 'aborted' });
    return record;
  }));
  await q.save('item', 'a', { id: '1', text: 'Fake' });
  for (let i = 0; i < 100 && q.status('item', '1') !== 'synced'; i++) await settle(20);
  assert.equal(q.status('item', '1'), 'synced');
});

test('otherPending keeps the sign-out gate shut; unsent(kind, id) says a record has saves not yet sent', async () => {
  let other = 1, online = false;
  const cfg = { ...queueFixture(async (_o, _k, r) => r), online: () => online };
  const q = createWriteQueue({ ...cfg, otherPending: async () => other });
  await q.activate('a');
  assert.equal(await q.flush(20), false, 'another write path still sending');
  other = 0;
  assert.equal(await q.flush(20), true);
  const bad = createWriteQueue({ ...cfg, otherPending: async () => { throw new Error('unknown'); } });
  await bad.activate('a');
  assert.equal(await bad.flush(20), false, 'can\'t tell: stays shut');
  await q.save('item', 'a', { id: 'x', text: 'Fake offline' });
  assert.equal(q.unsent('item', 'x'), true);
  assert.equal(q.unsent('item', 'y'), false);
  online = true; await q.flush(200);
  assert.equal(q.unsent('item', 'x'), false);
});

// ---- status ----

test('status: unknown until the server has confirmed once; at-risk only offline when asked', () => {
  assert.deepEqual(syncStatus({ confirmed: false }), { state: 'unknown', count: 0 });
  assert.equal(syncStatus({ confirmed: false, pending: 1 }).state, 'saving');
  assert.equal(syncStatus({ confirmed: true }).state, 'synced');
  assert.equal(syncStatus({}).state, 'synced', 'left out: as 0.3.0');
  assert.equal(syncStatus({ pending: 1, persisted: false }).state, 'at-risk', 'as 0.3.0');
  assert.equal(syncStatus({ pending: 1, persisted: false, atRiskOnlyOffline: true }).state, 'saving');
  assert.equal(syncStatus({ pending: 1, persisted: false, online: false, atRiskOnlyOffline: true }).state, 'at-risk');
});

// ---- a record that leaves the query with saves not yet sent ----

test('a record leaving the query while it has unsent saves stays, and onLeave reports it', async () => {
  const { openStore } = createStores({ prefix: 'safe-leave:', colls: ['items'] });
  const srv = fakeServer(), store = await openStore(S), left = [];
  const t = Date.now();
  srv.set('items', { id: 'a', text: 'Fake a', updatedAt: t });
  srv.set('items', { id: 'b', text: 'Fake b', updatedAt: t });
  const e = createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, fetchOne: srv.fetchOne,
    unsent: id => id === 'a', onLeave: (id, doc) => left.push([id, doc && doc.text]) });
  let list = [];
  e.subscribe(l => { list = l; });
  await e.ready; await settle();
  srv.del('items', 'a'); srv.del('items', 'b');   // both leave (locked, moved, deleted elsewhere)
  await settle(20); await e.flush();
  assert.deepEqual(list.map(d => d.id), ['a'], 'a has unsent saves: kept; b goes');
  assert.deepEqual(left, [['a', 'Fake a']]);
  await e.stop();
});

test('the hub passes unsent(scope, coll, id) and onLeave(scope, coll, id, doc) to each collection', async () => {
  const { openStore } = createStores({ prefix: 'safe-hub:', colls: ['items'] });
  const srv = fakeServer(), left = [];
  srv.set('items', { id: 'a', text: 'Fake a', updatedAt: Date.now() });
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, grace: 0,
    unsent: (scope, coll, id) => scope === S && coll === 'items' && id === 'a', onLeave: (...a) => left.push(a.slice(0, 3)) });
  let list = [];
  const off = hub.watch(S, 'items', l => { list = l; });
  await settle(20);
  srv.del('items', 'a');
  await settle(20); await hub.flush();
  assert.deepEqual(list.map(d => d.id), ['a']);
  assert.deepEqual(left, [[S, 'items', 'a']]);
  off(); await hub.stopAll();
});

// ---- forgetDevice ----

function forgetFixture({ proceed = async () => true, failCache = false } = {}) {
  const log = [];
  return {
    log,
    opts: {
      hub: { stopAll: async () => { log.push('stopAll'); } },
      stores: { wipeStores: async keep => { log.push('wipe:' + JSON.stringify(keep)); } },
      queue: { forget: async () => { log.push('forget'); } },
      proceed: async () => { log.push('proceed'); return proceed(); },
      keep: () => ['now@example.com'],
      clearBackendCache: async () => { log.push('cache'); if (failCache) throw new Error('blocked'); },
      extra: async () => { log.push('extra'); },
    },
  };
}

test('forgetDevice: stop all, check again, wipe keeping the current account, the outbox, the SDK cache, the app\'s own', async () => {
  const f = forgetFixture();
  assert.deepEqual(await forgetDevice(f.opts), { wiped: true, failed: [] });
  assert.deepEqual(f.log, ['stopAll', 'proceed', 'wipe:["now@example.com"]', 'forget', 'cache', 'extra']);
});

test('forgetDevice stops when proceed says no (another tab signed in meanwhile), and reports a step that failed', async () => {
  const no = forgetFixture({ proceed: async () => false });
  assert.deepEqual(await forgetDevice(no.opts), { wiped: false, failed: [] });
  assert.deepEqual(no.log, ['stopAll', 'proceed']);
  const bad = forgetFixture({ failCache: true });
  const r = await forgetDevice(bad.opts);
  assert.deepEqual(r, { wiped: true, failed: ['clearBackendCache'] });
  assert.deepEqual(bad.log.at(-1), 'extra', 'the steps after a failed one still run');
});
