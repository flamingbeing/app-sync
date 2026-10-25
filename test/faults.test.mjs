// Run with: node --test test/faults.test.mjs
// Fault injection across the pieces together: the network dropping and coming back mid-queue, two devices writing one
// record (stamps and lost races), sign-out with saves not sent, data left by an older client, Firestore's transient
// errors, a record leaving the query with unsent saves, and the update module's reload with a draft open. The adapter
// runs on a small fake of the Firestore SDK whose transactions can lose a race (optimistic, as the real one); its
// writes are mirrored into the fake server the sync engine listens to. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreBackend } from '../src/firestore.js';
import { createWriteQueue } from '../src/writes.js';
import { createCollectionSync, createSyncHub, leaveEntry } from '../src/sync.js';
import { createStores } from '../src/store.js';
import { forgetDevice } from '../src/forget.js';
import { fakeServer } from './fake-server.mjs';
import { memOutbox, sharedSdk } from './fake-sdk.mjs';

const H = 3600e3;
const S = 'fake-space';
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const clone = x => structuredClone(x);
const until = async (ok, ms = 2000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await settle(5); } return true; };
const err = (code, message = code) => Object.assign(new Error(message), { code });

// ---- fixtures (the outbox and the shared SDK: fake-sdk.mjs) ----

const pathOf = (coll, id) => `spaces/${S}/${coll}/${id}`;
const backendOn = (dev, opts = {}) => createFirestoreBackend({ sdk: dev.sdk, path: (scope, coll) => ['spaces', scope, coll], ...opts });
// the queue's waits made short: its 180 ms and its retry backoff (2 s, 4 s … a minute); a flush's own time stays
const BACKOFF = new Set([2000, 4000, 8000, 16000, 32000, 60000]);
const quick = ms => settle(ms === 180 ? 5 : BACKOFF.has(ms) ? 10 : ms);
const queueOn = (backend, { store = memOutbox(), owner = () => 'a', online = () => true, ...rest } = {}) => createWriteQueue({
  store, getOwner: owner, online, delay: quick,
  backend: (_owner, kind, record, base, extra) => backend.commit(S, kind + 's', record, base, extra), ...rest });

// ---- the network drops and comes back ----

test('flapping network: saves made on and off line, some cut off mid-send or with the answer lost, all land once and in order', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  let online = true;
  const sent = [];
  const q = createWriteQueue({ store: memOutbox(), getOwner: () => 'a', online: () => online, delay: quick,
    backend: async (_o, kind, record, base, extra) => {
      if (!online) throw err('unavailable', 'offline');   // the SDK answers offline at once
      sent.push(record.n);
      return b.commit(S, kind + 's', record, base, extra);
    } });
  let shown = null;
  for (let n = 1; n <= 8; n++) {
    if (n === 3) shared.faults.push('unavailable');          // dropped as it was sent
    if (n === 5) shared.lostAck.push('deadline-exceeded');   // landed, the answer was lost
    if (n === 6) shared.faults.push('aborted');              // a race lost before it ran
    const rec = { id: 'r1', text: 'Fake v' + n, n };
    await q.save('item', 'a', rec, shown).catch(() => {});
    shown = rec;
    online = n % 2 === 0;   // off, on, off, on …
    if (online) q.kick();
    await settle(15);
  }
  online = true;
  assert.equal(await q.flush(2000), true, 'everything sent');
  const server = shared.docs.get(pathOf('items', 'r1'));
  assert.equal(server.text, 'Fake v8');
  assert.ok(q.entries().every(x => x.state === 'synced' || x.state === 'archived'), 'nothing needs the user');
  assert.deepEqual([...sent].sort((x, y) => x - y), sent, 'never an older version after a newer one');
  // each version written at most once (a resend of the same content after a lost answer writes nothing)
  const written = shared.commits.map(c => c.writes[0].data.n);
  assert.equal(new Set(written).size, written.length);
  const stamps = shared.commits.map(c => c.writes[0].data.updatedAt);
  assert.ok(stamps.every((t, i) => i === 0 || t > stamps[i - 1]), 'stamps only move forward');
});

test('offline the whole time: saves wait on the device, the sign-out check stays shut, and back online they land', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  let online = false;
  const store = memOutbox();
  const q = queueOn(b, { store, online: () => online });
  // offline, a Firestore transaction fails at once with unavailable
  shared.faults.push('unavailable', 'unavailable', 'unavailable');
  let base = null;
  for (let n = 1; n <= 3; n++) { const r = { id: 'r1', text: 'Fake ' + n }; await q.save('item', 'a', r, base); base = r; }
  assert.equal(q.pending(), 3);
  assert.equal(await q.flush(50), false);
  online = true; shared.faults.length = 0;
  assert.equal(await q.flush(2000), true);
  assert.equal(shared.docs.get(pathOf('items', 'r1')).text, 'Fake 3');
});

// ---- two devices, one record ----

test('two devices with clocks an hour apart take turns on one record: every stamp is after the last, and a delta reader sees each', async () => {
  const srv = fakeServer(), shared = sharedSdk({ srv });
  const fast = backendOn(shared.device({ clock: H, name: 'fast' })), slow = backendOn(shared.device({ clock: -H, name: 'slow' }));
  const { openStore } = createStores({ prefix: 'faults-turns:', colls: ['items'] });
  const store = await openStore(S);
  let cur = await fast.commit(S, 'items', { id: 'r1', text: 'Fake 0' }, null);
  // a reader that has synced the first version
  const seen = [];
  const e = createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, fetchOne: srv.fetchOne });
  e.subscribe(l => { const d = l.find(x => x.id === 'r1'); if (d && seen.at(-1) !== d.text) seen.push(d.text); });
  await e.ready; await settle(10);
  const stamps = [cur.updatedAt];
  for (let n = 1; n <= 6; n++) {
    const b = n % 2 ? slow : fast;
    cur = await b.commit(S, 'items', { id: 'r1', text: 'Fake ' + n }, cur);
    stamps.push(cur.updatedAt);
  }
  await settle(10); await e.flush();
  assert.ok(stamps.every((t, i) => i === 0 || t > stamps[i - 1]), 'never back: ' + stamps.join(', '));
  assert.deepEqual(seen, ['Fake 0', 'Fake 1', 'Fake 2', 'Fake 3', 'Fake 4', 'Fake 5', 'Fake 6']);
  // a reader that opens now, with a delta read from its last sync, still gets the last version
  await e.stop();
  const again = createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, fetchOne: srv.fetchOne });
  let list = [];
  again.subscribe(l => { list = l; });
  await again.ready; await settle(10);
  assert.equal(list.find(x => x.id === 'r1').text, 'Fake 6');
  await again.stop();
});

test('two devices save one record at once: the race loser retries (merge: both changes kept; checked: a conflict, both versions kept)', async () => {
  // merge collection: last-write-wins by field, so both changes land
  const shared = sharedSdk();
  const A = backendOn(shared.device({ name: 'A' }), { merge: { notes: true } }), B = backendOn(shared.device({ name: 'B', clock: -H }), { merge: { notes: true } });
  const base = await A.commit(S, 'notes', { id: 'n1', a: 0, b: 0 }, null);
  // B's first try reads, then A commits before B does: B's transaction runs again on A's version
  const qa = queueOn(A), qb = queueOn(B);
  shared.faults.push('aborted');   // one of them also loses a race outright (the SDK gave up)
  await Promise.all([
    qa.save('note', 'a', { ...base, a: 1 }, base).catch(() => {}),
    qb.save('note', 'a', { ...base, b: 2 }, base).catch(() => {}),
  ]);
  assert.equal(await qa.flush(2000), true);
  assert.equal(await qb.flush(2000), true);
  const doc = shared.docs.get(pathOf('notes', 'n1'));
  assert.equal(doc.a, 1); assert.equal(doc.b, 2);
  assert.ok(doc.updatedAt > base.updatedAt);
  assert.equal(qa.attention() || qb.attention(), false, 'nobody asked to choose');

  // checked collection: the later of two edits made on the same version is a conflict, never an overwrite
  const s2 = sharedSdk();
  const C = backendOn(s2.device({ name: 'C' })), D = backendOn(s2.device({ name: 'D' }));
  const v1 = await C.commit(S, 'items', { id: 'r1', text: 'Fake' }, null);
  const qc = queueOn(C), qd = queueOn(D);
  await qc.save('item', 'a', { ...v1, text: 'Fake from C' }, v1);
  await qd.save('item', 'a', { ...v1, text: 'Fake from D' }, v1).catch(() => {});
  await qc.flush(500); await qd.flush(500);
  assert.equal(s2.docs.get(pathOf('items', 'r1')).text, 'Fake from C');
  const [job] = qd.entries();
  assert.equal(job.state, 'conflict');
  assert.equal(job.record.text, 'Fake from D', 'D\'s version kept on D');
  assert.equal(job.remote.text, 'Fake from C');
});

test('a transaction that keeps losing the race (the SDK gives up: aborted) stays pending and lands once the other device stops', async () => {
  const shared = sharedSdk({ attempts: 2 });
  const b = backendOn(shared.device());
  const v1 = await b.commit(S, 'notes', { id: 'n1', a: 0 }, null);
  let busy = 3;   // another device writes the same record during each of B's first tries
  const dev = shared.device({ name: 'B' });
  const realRun = dev.F.runTransaction;
  dev.F.runTransaction = (db, fn) => realRun(db, async tx => {
    const out = await fn(tx);
    if (busy > 0) { busy--; shared.meddle(pathOf('notes', 'n1'), { ...shared.docs.get(pathOf('notes', 'n1')), other: busy }); }
    return out;
  });
  const q = queueOn(backendOn(dev, { merge: { notes: true } }));
  await q.save('note', 'a', { ...v1, a: 1 }, v1);
  assert.equal(q.status('note', 'n1') === 'failed', false);
  assert.equal(await q.flush(2000), true);
  const doc = shared.docs.get(pathOf('notes', 'n1'));
  assert.equal(doc.a, 1);
  assert.equal(doc.other, 0, 'the other device\'s change is kept too');
});

// ---- Firestore's transient errors ----

test('unavailable, deadline-exceeded and aborted in a row: the save waits and retries, never needs the user; other codes still fail', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  const q = queueOn(b);
  shared.faults.push('aborted', 'unavailable', 'deadline-exceeded', 'aborted', 'unavailable');
  const states = new Set();
  q.onChange(() => states.add(q.status('item', 'r1')));
  await q.save('item', 'a', { id: 'r1', text: 'Fake' });
  assert.equal(await q.flush(50), false, 'retrying: the sign-out check stays shut');
  assert.ok(await until(() => q.pending() === 0), 'retried on its own, no online event');
  assert.equal(await q.flush(50), true);
  assert.equal(shared.docs.get(pathOf('items', 'r1')).text, 'Fake');
  assert.ok(!states.has('failed') && !states.has('conflict'), [...states].join(','));
  assert.equal(shared.commits.length, 1, 'written once');
  // permission-denied (rules said no) is not transient: kept for the user
  shared.faults.push('permission-denied');
  await assert.rejects(q.save('item', 'a', { id: 'r2', text: 'Fake' }), /kept in Recover/);
  assert.equal(q.status('item', 'r2'), 'failed');
});

// ---- sign-out with saves not sent ----

function device({ online = () => false } = {}) {
  const shared = sharedSdk(), b = backendOn(shared.device());
  const outbox = memOutbox();
  const q = queueOn(b, { store: outbox, online });
  return { shared, outbox, q };
}

test('sign-out mid-queue: forgetDevice refuses while saves are unsent (proceed = flush) and deletes nothing; they still land', async () => {
  let online = false;
  const { shared, outbox, q } = device({ online: () => online });
  const srv = fakeServer();
  const { openStore, wipeStores } = createStores({ prefix: 'faults-signout:', colls: ['items'] });
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, grace: 0 });
  srv.set('items', { id: 'x', text: 'Fake held', updatedAt: Date.now() });
  let list = [];
  const off = hub.watch(S, 'items', l => { list = l; });
  await settle(20);
  await q.save('item', 'a', { id: 'r1', text: 'Fake unsent' });
  const steps = [];
  const r = await forgetDevice({ hub, stores: { wipeStores: async k => { steps.push('wipe'); return wipeStores(k); } }, queue: q,
    proceed: async () => q.flush(50), clearBackendCache: async () => steps.push('cache'), extra: async () => steps.push('extra') });
  assert.deepEqual(r, { wiped: false, failed: [] });
  assert.deepEqual(steps, [], 'nothing deleted');
  assert.equal(outbox.records.size, 1, 'the unsent save is still on the device');
  const st = await openStore(S);
  assert.deepEqual((await st.load('items')).docs.map(d => d.id), ['x'], 'the device\'s list is still there');
  // the hub was stopped by forgetDevice: the app watches again (listeners don't come back by themselves)
  off();
  const off2 = hub.watch(S, 'items', l => { list = l; });
  srv.set('items', { id: 'y', text: 'Fake new', updatedAt: Date.now() + 1 });
  assert.ok(await until(() => list.some(d => d.id === 'y')), 'watching again works');
  online = true;
  assert.equal(await q.flush(2000), true);
  assert.equal(shared.docs.get(pathOf('items', 'r1')).text, 'Fake unsent');
  // now it goes ahead and the outbox is empty
  const r2 = await forgetDevice({ hub, stores: { wipeStores }, queue: q, proceed: async () => q.flush(50) });
  assert.deepEqual(r2, { wiped: true, failed: [] });
  assert.equal(outbox.records.size, 0);
  off2();
});

test('sign-out while a save is in the air: the check waits for its answer, and a late answer never brings the account back', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  const outbox = memOutbox();
  let owner = 'a', release;
  const gate = new Promise(r => { release = r; });
  const q = createWriteQueue({ store: outbox, getOwner: () => owner, delay: quick,
    backend: async (_o, kind, record, base, extra) => { await gate; return b.commit(S, kind + 's', record, base, extra); } });
  await q.save('item', 'a', { id: 'r1', text: 'Fake in the air' });
  assert.equal(await q.flush(30), false, 'not answered yet: shut');
  const r = await forgetDevice({ queue: q, proceed: async () => q.flush(30) });
  assert.equal(r.wiped, false);
  release();
  assert.equal(await q.flush(500), true);
  assert.equal((await forgetDevice({ queue: q, proceed: async () => q.flush(30) })).wiped, true);
  owner = 'b'; await q.activate('b');
  assert.equal(q.entries().length, 0);
  assert.equal(outbox.records.size, 0);
});

// ---- data from an older client ----

test('old client: outbox entries saved by 0.3.0 (no ops, never accepted) load and send with 0.4.0', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  const outbox = memOutbox();
  const at = Date.now() - 60e3;
  // as 0.3.0 stored them: key, owner, kind, record, base, state, accepted, at
  outbox.records.set('a:old1', { key: 'a:old1', owner: 'a', kind: 'item', record: { id: 'r1', text: 'Fake one' }, base: null, state: 'pending', accepted: false, at });
  outbox.records.set('a:old2', { key: 'a:old2', owner: 'a', kind: 'item', record: { id: 'r1', text: 'Fake two' }, base: { id: 'r1', text: 'Fake one' }, state: 'pending', accepted: true, at: at + 1 });
  const q = queueOn(b, { store: outbox });
  await q.activate('a');
  assert.equal(await q.flush(2000), true);
  assert.equal(shared.docs.get(pathOf('items', 'r1')).text, 'Fake two');
});

test('old client: a stamp written by an older client whose clock was behind (or an ISO stamp) is still moved forward', async () => {
  const shared = sharedSdk(), b = backendOn(shared.device());
  const ahead = Date.now() + H;
  // a 0.4.0 device wrote, then a 0.3.0 device with a slow clock stamped its own time (going back)
  await backendOn(shared.device({ clock: H })).commit(S, 'items', { id: 'r1', text: 'Fake new' }, null);
  const first = shared.docs.get(pathOf('items', 'r1'));
  shared.meddle(pathOf('items', 'r1'), { ...first, text: 'Fake old client', updatedAt: Date.now() - H });
  const out = await b.commit(S, 'items', { id: 'r1', text: 'Fake again' }, { id: 'r1', text: 'Fake old client' });
  assert.ok(out.updatedAt >= Date.now() - 1000, 'from now, not from the old client\'s stamp');
  // an older app that stamped ISO strings: the number stamp still comes after it
  shared.meddle(pathOf('items', 'r2'), { id: 'r2', text: 'Fake iso', updatedAt: new Date(ahead).toISOString() });
  const o2 = await b.commit(S, 'items', { id: 'r2', text: 'Fake ms' }, { id: 'r2', text: 'Fake iso' });
  assert.equal(o2.updatedAt, ahead + 1);
});

test('old client: a 0.3.0 leave entry (deletedAt equal to the record\'s stamp) and an entry without data.updatedAt still remove the record', async () => {
  const srv = fakeServer();
  const { openStore } = createStores({ prefix: 'faults-oldleave:', colls: ['items'], metaOnly: ['bin', 'leaves'] });
  const t = Date.now() - 1000;
  srv.set('items', { id: 'a', text: 'Fake a', updatedAt: t });
  srv.set('items', { id: 'b', text: 'Fake b', updatedAt: t });
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, grace: 0, feeds: { leaves: { item: 'items' } } });
  let list = [];
  const off = hub.watch(S, 'items', l => { list = l; });
  await settle(20);
  // the records stay in the collection (locked) but leave this device's view: only the entries say so
  srv.set('leaves', { id: 'item:a', kind: 'item', data: { id: 'a', updatedAt: t }, deletedAt: t });
  srv.set('leaves', { id: 'item:b', kind: 'item', data: { id: 'b' }, deletedAt: t + 1 });
  assert.ok(await until(() => list.length === 0), JSON.stringify(list));
  off(); await hub.stopAll();
});

// ---- a record that leaves the query with unsent saves ----

test('a record removed by a tombstone (bin or leave feed) while it has unsent saves stays, and onLeave reports it', async () => {
  const srv = fakeServer(), left = [];
  const { openStore } = createStores({ prefix: 'faults-leave-tomb:', colls: ['items'], metaOnly: ['bin', 'leaves'] });
  const t = Date.now() - 1000;
  for (const id of ['a', 'b', 'c', 'd']) srv.set('items', { id, text: 'Fake ' + id, updatedAt: t });
  const unsent = new Set(['a', 'c']);
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, grace: 0, binKinds: { item: 'items' }, feeds: { leaves: { item: 'items' } },
    unsent: (_s, _c, id) => unsent.has(id), onLeave: (_s, _c, id) => left.push(id) });
  let list = [];
  const off = hub.watch(S, 'items', l => { list = l; });
  await settle(20);
  // a and b binned elsewhere, c and d locked elsewhere (still in the query here, so only the entries say so)
  srv.set('bin', { id: 'item:a', kind: 'item', data: { id: 'a', updatedAt: t }, deletedAt: t + 5 });
  srv.set('bin', { id: 'item:b', kind: 'item', data: { id: 'b', updatedAt: t }, deletedAt: t + 5 });
  srv.set('leaves', leaveEntry('item', { id: 'c', updatedAt: t }, t + 5));
  srv.set('leaves', leaveEntry('item', { id: 'd', updatedAt: t }, t + 5));
  await until(() => !list.some(d => d.id === 'b' || d.id === 'd'));
  await settle(20); await hub.flush();
  assert.deepEqual(list.map(d => d.id).sort(), ['a', 'c'], 'unsent saves: kept; the others go');
  assert.deepEqual(left.sort(), ['a', 'c']);
  // once the saves are sent (or set aside), the next tombstone for it removes it as usual
  unsent.clear();
  srv.set('bin', { id: 'item:a', kind: 'item', data: { id: 'a', updatedAt: t }, deletedAt: t + 9 });
  assert.ok(await until(() => !list.some(d => d.id === 'a')));
  off(); await hub.stopAll();
});

test('the same for a collection nobody is watching right now (tombstones written straight into its stored copy)', async () => {
  const srv = fakeServer(), left = [];
  const { openStore } = createStores({ prefix: 'faults-leave-stored:', colls: ['items', 'things'] });
  const t = Date.now() - 1000;
  srv.set('items', { id: 'a', text: 'Fake a', updatedAt: t });
  srv.set('items', { id: 'b', text: 'Fake b', updatedAt: t });
  const hub = createSyncHub({ openStore, listen: srv.listen, fetchOne: srv.fetchOne, grace: 0, binKinds: { item: 'items' },
    unsent: (_s, _c, id) => id === 'a', onLeave: (_s, coll, id) => left.push(coll + ':' + id) });
  const offThings = hub.watch(S, 'things', () => {});   // keeps the bin feed running
  const offItems = hub.watch(S, 'items', () => {});
  await settle(20); offItems(); await settle(20); await hub.flush();
  srv.set('bin', { id: 'item:a', kind: 'item', data: { id: 'a', updatedAt: t }, deletedAt: t + 5 });
  srv.set('bin', { id: 'item:b', kind: 'item', data: { id: 'b', updatedAt: t }, deletedAt: t + 5 });
  await settle(30); await hub.flush();
  const stored = await (await openStore(S)).load('items');
  assert.deepEqual(stored.docs.map(d => d.id), ['a']);
  assert.deepEqual(left, ['items:a']);
  offThings(); await hub.stopAll();
});

test('a record with unsent saves left out of a full read stays until its saves are done, then goes at the next full read', async () => {
  const srv = fakeServer(), left = [];
  const { openStore } = createStores({ prefix: 'faults-leave-full:', colls: ['items'] });
  const store = await openStore(S);
  srv.set('items', { id: 'a', text: 'Fake a', updatedAt: Date.now() });
  let unsent = true;
  const mk = () => createCollectionSync({ scope: S, coll: 'items', store, listen: srv.listen, fetchOne: srv.fetchOne, unsent: () => unsent, onLeave: id => left.push(id) });
  let e = mk(), list = [];
  e.subscribe(l => { list = l; });
  await e.ready; await settle(10); await e.stop();
  srv.del('items', 'a');
  // the next open is a full read (forced here) without it
  await store.write('items', { meta: { ...(await store.load('items')).meta, fullAt: 0 } });
  e = mk(); e.subscribe(l => { list = l; });
  await e.ready; await settle(10); await e.flush();
  assert.deepEqual(list.map(d => d.id), ['a']);
  assert.deepEqual(left, ['a']);
  await e.stop();
  unsent = false;
  await store.write('items', { meta: { ...(await store.load('items')).meta, fullAt: 0 } });
  e = mk(); e.subscribe(l => { list = l; });
  await e.ready; await settle(10); await e.flush();
  assert.deepEqual(list, []);
  await e.stop();
});

test('end to end: a record locked elsewhere while this device has an unsent edit keeps showing, and the edit meets a conflict kept for the user', async () => {
  const srv = fakeServer(), shared = sharedSdk({ srv }), left = [];
  const b = backendOn(shared.device());
  let online = false;
  const q = queueOn(b, { online: () => online });
  const { openStore } = createStores({ prefix: 'faults-leave-e2e:', colls: ['items'] });
  const v1 = await b.commit(S, 'items', { id: 'r1', text: 'Fake' }, null);
  const hub = createSyncHub({ openStore, listen: (scope, coll, opts, onSnap, onError) => {
    // the query shows only unlocked records (as an app's where filter would)
    const inner = s => onSnap({ ...s, changes: s.changes.map(c => c.doc && c.doc.locked ? { type: 'removed', id: c.id, doc: null } : c), ...(s.docs ? { docs: s.docs.filter(d => !d.locked) } : {}) });
    return srv.listen(scope, coll, opts, inner, onError);
  }, fetchOne: srv.fetchOne, grace: 0, unsent: (_s, coll, id) => q.unsent(coll.slice(0, -1), id), onLeave: (_s, _c, id) => left.push(id) });
  let raw = [];
  const off = hub.watch(S, 'items', l => { raw = l; });
  await settle(20);
  await q.save('item', 'a', { ...v1, text: 'Fake edit' }, v1);
  await backendOn(shared.device({ name: 'other' })).commit(S, 'items', { ...v1, locked: true }, v1);
  await settle(20); await hub.flush();
  assert.deepEqual(left, ['r1']);
  assert.ok(raw.some(d => d.id === 'r1'), 'the server copy is kept on the device');
  assert.equal(q.overlay('item', 'a', raw).find(d => d.id === 'r1')?.text, 'Fake edit', 'still shows, with the edit');
  online = true; q.kick(); await q.flush(500);
  const [job] = q.entries();
  assert.equal(job.state, 'conflict', 'the edit meets the lock: kept for the user, not lost');
  assert.equal(job.record.text, 'Fake edit');
  assert.equal(shared.docs.get(pathOf('items', 'r1')).locked, true, 'the lock is not overwritten');
  off(); await hub.stopAll();
});

// ---- the reload guard with a draft open (update module) ----

// register.js in a fake page world (as update/test/register.test.mjs)
let worlds = 0;
const tick = () => new Promise(r => setTimeout(r, 0));
const target = () => {
  const l = {};
  return { l, addEventListener: (t, f) => { (l[t] ||= []).push(f); }, fire: async (t, e = {}) => { for (const f of l[t] || []) await f(e); await tick(); } };
};
async function page() {
  const sw = target(), win = target(), doc = target(), regT = target();
  const posted = [];
  const reg = { ...regT, waiting: null, installing: null, update: async () => { p.checks++; }, unregister: async () => { p.gone = true; } };
  const p = { reloads: 0, checks: 0, posted, reg, sw, win, events: [] };
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  sw.controller = {};
  sw.getRegistration = async () => ({ active: {} });
  sw.register = async () => reg;
  const ss = new Map();
  set('navigator', { serviceWorker: sw });
  set('window', win);
  set('document', { ...doc, visibilityState: 'visible' });
  p.doc = globalThis.document;
  set('location', { href: 'https://app.test/app/', reload: () => { p.reloads++; p.events.push('reload'); } });
  set('sessionStorage', { getItem: k => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) });
  set('setInterval', () => 0);
  set('fetch', async () => ({ ok: true }));
  set('caches', { keys: async () => [], delete: async () => true });
  p.mod = await import(`../update/register.js?faults=${worlds++}`);
  p.waitingWorker = () => { const w = { postMessage: m => posted.push(m) }; reg.waiting = w; return w; };
  return p;
}

test('reload guard: with a draft open nothing reloads through take-overs, tab switches, pagehide and coming online; closing it reloads once, after beforeReload', async () => {
  const p = await page();
  let draft = true;
  await p.mod.register({ app: 'demo', canReload: () => !draft, beforeReload: async () => { p.events.push('saved draft state'); } });
  await p.sw.fire('controllerchange');
  await p.sw.fire('controllerchange');   // a second take-over while the first is still owed
  for (let i = 0; i < 3; i++) { await p.doc.fire('visibilitychange'); await p.win.fire('pagehide'); await p.win.fire('online'); }
  await p.mod.retryUpdate();
  assert.equal(p.reloads, 0, 'never under the user\'s fingers');
  await assert.rejects(p.mod.forceLatest(), /still sending/);
  assert.equal(p.gone, undefined, 'forceLatest touched nothing');
  draft = false;
  await Promise.all([p.mod.retryUpdate(), p.win.fire('pagehide'), p.doc.fire('visibilitychange')]);   // several tries at once
  assert.equal(p.reloads, 1);
  assert.deepEqual(p.events, ['saved draft state', 'reload']);
});

test('reload guard: a worker waiting for its go (waitForGo) gets none while the draft is open, however often it installs', async () => {
  const p = await page();
  let draft = true;
  p.waitingWorker();
  await p.mod.register({ app: 'demo', canReload: async () => !draft });
  assert.deepEqual(p.posted, []);
  // a newer version installs while the draft is still open
  const w = { state: 'installing', ...target() };
  p.reg.installing = w;
  await p.reg.fire('updatefound');
  w.state = 'installed'; p.waitingWorker();
  await w.fire('statechange');
  await p.doc.fire('visibilitychange');
  assert.deepEqual(p.posted, []);
  draft = false;
  await p.mod.retryUpdate();
  assert.deepEqual(p.posted, [{ type: 'update:go' }]);
});

test('reload guard: a canReload that throws while a draft is open counts as no', async () => {
  const p = await page();
  let mode = 'throw';
  await p.mod.register({ app: 'demo', canReload: async () => { if (mode === 'throw') throw new Error('draft state unknown'); return true; } });
  await p.sw.fire('controllerchange');
  await p.win.fire('pagehide');
  assert.equal(p.reloads, 0);
  mode = 'ok';
  await p.mod.retryUpdate();
  assert.equal(p.reloads, 1);
});
