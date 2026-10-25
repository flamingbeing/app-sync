// Run with: node --test test/origin.test.mjs
// 0.4.2: one origin, several apps. Sign-in is shared, so signing out in one app signs out all of them, and a
// sign-out on a shared device has to wait for every app's unsent saves (the outbox registry), and must not hang
// when another tab still holds the SDK's cache (clearCache and forgetDevice time out). Each test failed before its
// change. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteQueue } from '../src/writes.js';
import { createFirestoreBackend } from '../src/firestore.js';
import { forgetDevice } from '../src/forget.js';
import { createOutboxRegistry } from '../src/registry.js';

const U = 'fake@example.com';
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const never = () => new Promise(() => {});

// an outbox in memory, shaped like createOutbox's (name and realm say which one it is)
function memoryOutbox(name, realm = 'default', records = new Map()) {
  return {
    name, realm, records,
    async put(x) { records.set(x.key, structuredClone(x)); },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); },
    async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; },
    async remove(k) { records.delete(k); },
    async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); },
  };
}
function memoryStorage() {
  const m = new Map();
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
// two apps' outboxes on one origin, and a registry both use
function origin() {
  const boxes = new Map();
  const open = (name, realm) => { const id = name + '|' + realm; if (!boxes.has(id)) boxes.set(id, memoryOutbox(name, realm)); return boxes.get(id); };
  const registry = createOutboxRegistry({ storage: memoryStorage(), open });
  return { open, registry };
}
const unsentEntry = (owner, key = owner + ':x1') => ({ key, owner, kind: 'item', record: { id: 'r1' }, base: null, state: 'pending', at: 1 });

// ---- clearCache and forgetDevice: no hang ----

test('clearCache gives up after its timeout when clearing the cache hangs (another tab still uses it)', async () => {
  const calls = [];
  const F = { terminate: async () => { calls.push('terminate'); }, clearIndexedDbPersistence: () => { calls.push('clear'); return never(); } };
  const b = createFirestoreBackend({ sdk: async () => ({ db: {}, F }), path: (s, c) => [s, c] });
  const t = Date.now();
  await assert.rejects(b.clearCache({ timeout: 40 }), e => e.code === 'deadline-exceeded');
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(calls, ['terminate', 'clear']);
});

test('forgetDevice: a hanging clearBackendCache times out, is reported, and extra still runs (it reloads)', async () => {
  const log = [];
  const r = await forgetDevice({ queue: { forget: async () => { log.push('forget'); } }, clearBackendCache: never, extra: async () => { log.push('extra'); }, timeout: 40 });
  assert.deepEqual(r, { wiped: true, failed: ['clearBackendCache'] });
  assert.deepEqual(log, ['forget', 'extra']);
});

test('forgetDevice times clearBackendCache out after about 3 s by default', async () => {
  const log = [];
  const t = Date.now();
  const r = await forgetDevice({ clearBackendCache: never, extra: async () => { log.push('extra'); } });
  const took = Date.now() - t;
  assert.ok(took >= 2500 && took < 4500, 'took ' + took);
  assert.deepEqual(r.failed, ['clearBackendCache']); assert.deepEqual(log, ['extra']);
});

// ---- the outbox registry ----

test('registry: register is idempotent and kept in storage (another page reads the same list)', async () => {
  const storage = memoryStorage();
  const a = createOutboxRegistry({ storage, open: () => null });
  a.register({ name: 'app-a-outbox' }); a.register({ name: 'app-a-outbox' }); a.register({ name: 'app-b-outbox', realm: 'demo' });
  assert.deepEqual(createOutboxRegistry({ storage, open: () => null }).list(), [{ name: 'app-a-outbox', realm: 'default' }, { name: 'app-b-outbox', realm: 'demo' }]);
  a.unregister({ name: 'app-b-outbox', realm: 'demo' });
  assert.deepEqual(a.list(), [{ name: 'app-a-outbox', realm: 'default' }]);
});

test('sign-out (flush) refuses while another registered app has unsent saves for this user', async () => {
  const { open, registry } = origin();
  const mine = open('app-a-outbox', 'default'), theirs = open('app-b-outbox', 'default');
  registry.register(mine); registry.register(theirs);
  await theirs.put(unsentEntry(U));
  await theirs.put(unsentEntry('other@example.com', 'o:1'));
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U, registry });
  await q.activate(U);
  assert.equal(await q.flush(30), false, 'app B still has a save to send');
  theirs.records.get(U + ':x1').state = 'synced';
  assert.equal(await q.flush(30), true, 'another user\'s entries don\'t count');
});

test('without a registry, flush behaves as before (another app\'s outbox is not looked at)', async () => {
  const { open, registry } = origin();
  const mine = open('app-a-outbox', 'default'), theirs = open('app-b-outbox', 'default');
  registry.register(mine); registry.register(theirs);
  await theirs.put(unsentEntry(U));
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U });
  await q.activate(U);
  assert.equal(await q.flush(30), true);
});

test('registry: an outbox that can\'t be read, or doesn\'t answer, keeps the sign-out gate shut', async () => {
  const storage = memoryStorage();
  const broken = { name: 'b', realm: 'default', list: async () => { throw new Error('unreadable'); } };
  const stuck = { name: 's', realm: 'default', list: never };
  const mine = memoryOutbox('a');
  const openBroken = name => name === 'b' ? broken : mine;
  const r1 = createOutboxRegistry({ storage, open: openBroken });
  r1.register(mine); r1.register(broken);
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U, registry: r1 });
  await q.activate(U);
  assert.equal(await q.flush(30), false);
  const r2 = createOutboxRegistry({ storage: memoryStorage(), open: name => name === 's' ? stuck : mine, timeout: 40 });
  r2.register(stuck);
  assert.equal(await r2.unsent(U), true);
});

test('the queue\'s own outbox is checked as before, not twice (a save it just sent may still read pending there)', async () => {
  const { open, registry } = origin();
  const mine = open('app-a-outbox', 'default');
  registry.register(mine);
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U, registry });
  await q.activate(U);
  assert.equal(await registry.unsent(U, { except: mine }), false);
  await mine.put(unsentEntry(U));
  assert.equal(await registry.unsent(U), true);
  assert.equal(await registry.unsent(U, { except: mine }), false);
});

test('forgetDevice (queue.forget) forgets this user in every registered outbox, and not other users', async () => {
  const { open, registry } = origin();
  const mine = open('app-a-outbox', 'default'), theirs = open('app-b-outbox', 'default');
  registry.register(mine); registry.register(theirs);
  await mine.put({ ...unsentEntry(U, U + ':m'), state: 'synced' });
  await theirs.put({ ...unsentEntry(U), state: 'synced' });
  await theirs.put(unsentEntry('other@example.com', 'o:1'));
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U, registry });
  await q.activate(U);
  const r = await forgetDevice({ queue: q, proceed: async () => q.flush(30) });
  assert.deepEqual(r, { wiped: true, failed: [] });
  assert.equal(mine.records.size, 0);
  assert.deepEqual([...theirs.records.keys()], ['o:1']);
});

test('forgetDevice refuses while another registered app has unsent saves, and deletes nothing', async () => {
  const { open, registry } = origin();
  const mine = open('app-a-outbox', 'default'), theirs = open('app-b-outbox', 'default');
  registry.register(mine); registry.register(theirs);
  await theirs.put(unsentEntry(U));
  const q = createWriteQueue({ store: mine, backend: async () => ({}), getOwner: () => U, registry });
  await q.activate(U);
  const r = await forgetDevice({ queue: q, proceed: async () => q.flush(30) });
  assert.equal(r.wiped, false);
  assert.equal(theirs.records.size, 1);
  await settle();
});
