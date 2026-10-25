// The Firestore adapter (src/firestore.js) with the engine and the write queue, against the local Firestore emulator
// (demo project: nothing reaches a real Firebase project). Run with: npm run test:emulator (needs Java).
// Made-up data only.
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import * as F from 'firebase/firestore';
import { createFirestoreBackend } from '../src/firestore.js';
import { createSyncHub, leaveEntry } from '../src/sync.js';
import { createWriteQueue, watchSaved } from '../src/writes.js';
import { createStores } from '../src/store.js';

const HOST = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(50); }
  return false;
}
function device(name, stamp, opts = {}) {
  const app = initializeApp({ projectId: 'demo-app-sync', apiKey: 'fake-key' }, name);
  const db = F.getFirestore(app);
  F.connectFirestoreEmulator(db, HOST[0], Number(HOST[1]));
  const reads = {};
  const backend = createFirestoreBackend({
    sdk: async () => ({ db, F }),
    path: (scope, coll) => ['spaces', scope, coll],
    stamp,
    onRead: (coll, kind, n) => { (reads[coll] ||= { billed: 0, served: 0 })[kind] += n; },
    ...opts,
  });
  return { app, db, backend, reads };
}

const S = 'space-' + Date.now().toString(36);
const A = device('a'), B = device('b');
// a writer whose records were last changed an hour ago (outside the engine's 10 min overlap)
const OLD = device('old', doc => ({ ...doc, updatedAt: Date.now() - 3600e3 }));

// ---- commit: writes, then refuses a write made on a stale base, keeping both versions ----
const first = await A.backend.commit(S, 'items', { id: 'i1', text: 'Fake one' }, null);
assert.equal(first.text, 'Fake one'); assert.ok(first.updatedAt > 0);
const again = await A.backend.commit(S, 'items', { id: 'i1', text: 'Fake one' }, null);
assert.equal(again.text, 'Fake one', 'the same content sent again (a lost acknowledgement) is not a conflict');
await B.backend.commit(S, 'items', { id: 'i1', text: 'Fake edit on B' }, first);
await assert.rejects(A.backend.commit(S, 'items', { id: 'i1', text: 'Fake edit on A' }, first), e => e.code === 'write-conflict' && e.remote.text === 'Fake edit on B');
assert.equal((await A.backend.fetchOne(S, 'items', 'i1')).text, 'Fake edit on B', 'nothing overwritten');
assert.equal(await A.backend.fetchOne(S, 'items', 'nope'), null);

// ---- the engine on Firestore: a full read first, then only changes; a bin entry removes the record elsewhere ----
for (let i = 2; i <= 6; i++) await OLD.backend.commit(S, 'items', { id: 'i' + i, text: 'Fake ' + i }, null);
const stores = createStores({ prefix: 'emu-a:', colls: ['items'] });
const hub = createSyncHub({ openStore: stores.openStore, listen: A.backend.listen, fetchOne: A.backend.fetchOne, binKinds: { item: 'items' }, grace: 0 });
let list = [];
let off = hub.watch(S, 'items', l => { list = l; });
assert.ok(await until(() => list.length === 6), 'full read: ' + list.length);
off(); await settle(50); await hub.stopAll();
const billedFull = A.reads.items.billed;
assert.ok(billedFull >= 6);

// reopen: a delta listener, nothing changed: one billed read
off = hub.watch(S, 'items', l => { list = l; });
assert.ok(await until(() => A.reads.items.billed > billedFull));
await settle();
assert.equal(A.reads.items.billed - billedFull, 1, 'reopening costs one read (only i1 is inside the overlap)');
// a change made on B arrives live, and a delete through the bin removes it here
await B.backend.commit(S, 'items', { id: 'i3', text: 'Fake 3 edited' }, (await B.backend.fetchOne(S, 'items', 'i3')));
assert.ok(await until(() => list.find(d => d.id === 'i3')?.text === 'Fake 3 edited'), 'live change');
const binned = await B.backend.fetchOne(S, 'items', 'i4');
await F.setDoc(F.doc(B.db, 'spaces', S, 'bin', 'x4'), { id: 'x4', kind: 'item', data: binned, deletedAt: Date.now() });
await B.backend.commit(S, 'items', { id: 'i4', _deleted: true }, binned);
assert.ok(await until(() => !list.some(d => d.id === 'i4')), 'the binned record goes');
off(); await settle(50); await hub.stopAll();

// ---- the write queue with the adapter: a conflict is kept with the other version ----
const records = new Map();
const outbox = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget() {} };
const q = createWriteQueue({ store: outbox, getOwner: () => S, backend: (scope, _kind, record, base) => A.backend.commit(scope, 'items', record, base) });
const base5 = await A.backend.fetchOne(S, 'items', 'i5');
await B.backend.commit(S, 'items', { id: 'i5', text: 'Fake 5 from B' }, base5);
await assert.rejects(q.save('item', S, { ...base5, text: 'Fake 5 from A' }, base5), /kept in Recover/);
assert.equal(q.status('item', 'i5'), 'conflict');
assert.equal(q.entries()[0].remote.text, 'Fake 5 from B');
const shown = await A.backend.fetchOne(S, 'items', 'i5');
await q.save('item', S, { ...shown, text: 'Fake 5 merged' }, shown);
assert.ok(await until(() => q.status('item', 'i5') === 'synced'));
assert.equal((await B.backend.fetchOne(S, 'items', 'i5')).text, 'Fake 5 merged');
assert.equal(await q.flush(), true);

// ---- 0.2.0: ISO stamps, query filters, merge (last-write-wins by field) commits ----
const iapp = initializeApp({ projectId: 'demo-app-sync', apiKey: 'fake-key' }, 'iso');
const idb = F.getFirestore(iapp);
F.connectFirestoreEmulator(idb, HOST[0], Number(HOST[1]));
const ireads = {};
// a made-up app: ISO stamps, one site's records only, counts merged by ops ({ inc: { field: n } }), saves applied once
const applyOps = (cur, rec, base, ops) => {
  const out = { ...(cur || {}), ...rec };
  if (ops) { for (const k of Object.keys(out)) if (cur && k in cur && k !== 'id') out[k] = cur[k]; for (const o of ops) for (const [k, n] of Object.entries(o.inc || {})) out[k] = (Number(out[k]) || 0) + n; }
  return out;
};
const I = createFirestoreBackend({ sdk: async () => ({ db: idb, F }), path: (scope, coll) => ['spaces', scope, coll], time: 'iso',
  where: (_scope, coll) => coll === 'rows' ? [['site', '==', 'X']] : [], merge: { rows: true, stock: applyOps }, mark: '_saves',
  onRead: (coll, kind, n) => { (ireads[coll] ||= { billed: 0, served: 0 })[kind] += n; } });
assert.match(I.stamp(), /^\d{4}-\d\d-\d\dT/, 'stamp() is the backend\'s stamp (ISO here)');
const r1 = await I.commit(S, 'rows', { id: 'r1', site: 'X', f: { a: 1 } }, null);
assert.equal(typeof r1.updatedAt, 'string');
await I.commit(S, 'rows', { id: 'r2', site: 'Y', f: { a: 1 } }, null);
// two devices change different fields of one record: both kept (no conflict)
await I.commit(S, 'rows', { ...r1, f: { a: 1, b: 2 } }, r1);
await I.commit(S, 'rows', { ...r1, f: { a: 10 } }, r1);
assert.deepEqual((await I.fetchOne(S, 'rows', 'r1')).f, { a: 10, b: 2 });
// the engine on ISO stamps and a filtered query: only site X, and a reopen reads only what changed
const istores = createStores({ prefix: 'emu-iso:', colls: ['rows'] });
const ihub = createSyncHub({ openStore: istores.openStore, listen: I.listen, fetchOne: I.fetchOne, bin: null, grace: 0 });
let rows = [];
off = ihub.watch(S, 'rows', l => { rows = l; });
assert.ok(await until(() => rows.length === 1), 'the filter applies: ' + rows.length);
off(); await settle(50); await ihub.stopAll();
const ibilled = ireads.rows.billed;
off = ihub.watch(S, 'rows', l => { rows = l; });
assert.ok(await until(() => ireads.rows.billed > ibilled));
await I.commit(S, 'rows', { id: 'r3', site: 'X', f: {} }, null);
assert.ok(await until(() => rows.length === 2), 'a new record arrives on the delta listener with ISO stamps');
off(); await settle(50); await ihub.stopAll();
// increments from two devices both count; a save sent twice (lost acknowledgement) counts once
const s0 = await I.commit(S, 'stock', { id: 's1', qty: 3 }, null, { key: 'k0' });
await I.commit(S, 'stock', { id: 's1', qty: 2 }, s0, { key: 'k1', ops: [{ inc: { qty: -1 } }] });
await I.commit(S, 'stock', { id: 's1', qty: 2 }, s0, { key: 'k2', ops: [{ inc: { qty: -1 } }] });
await I.commit(S, 'stock', { id: 's1', qty: 2 }, s0, { key: 'k2', ops: [{ inc: { qty: -1 } }] });
assert.equal((await I.fetchOne(S, 'stock', 's1')).qty, 1);
// a record deleted elsewhere is not brought back by a merge: the save fails (kept by the queue)
await I.commit(S, 'stock', { id: 's1', _deleted: true }, null);
await assert.rejects(I.commit(S, 'stock', { id: 's1', qty: 5 }, s0, { key: 'k3', ops: [{ inc: { qty: 2 } }] }), e => e.code === 'not-found');
await F.terminate(idb);

// ---- 0.3.0: server stamps (stampMode: 'server') ----
// The server stamps serverAt; updatedAt stays the writer's clock. A writer offline for days whose clock is 3 days
// behind, and readers whose clocks are 2 h fast or slow: the delta read still meets the write.
let wclock = Date.now() - 3 * 864e5;
const srvDevice = (name, stamp) => {
  const app = initializeApp({ projectId: 'demo-app-sync', apiKey: 'fake-key' }, name);
  const db = F.getFirestore(app);
  F.connectFirestoreEmulator(db, HOST[0], Number(HOST[1]));
  const reads = {};
  const backend = createFirestoreBackend({ sdk: async () => ({ db, F }), path: (scope, coll) => ['spaces', scope, coll], stamp, stampMode: 'server',
    merge: { shared: true }, onRead: (coll, kind, n) => { (reads[coll] ||= { billed: 0, served: 0 })[kind] += n; } });
  return { db, backend, reads };
};
const W = srvDevice('srv-writer', doc => ({ ...doc, updatedAt: wclock })), R = srvDevice('srv-reader');
const SS = S + '-srv';
const c1 = await W.backend.commit(SS, 'notes', { id: 'n1', text: 'Fake note' }, null);
assert.equal(c1.serverAt, undefined, 'the returned copy has no unresolved stamp');
const got1 = await R.backend.fetchOne(SS, 'notes', 'n1');
assert.equal(typeof got1.serverAt, 'number', 'serverAt reads as ms');
assert.ok(Math.abs(got1.serverAt - Date.now()) < 60e3, 'stamped by the server, not the writer\'s clock');
assert.ok(got1.updatedAt < Date.now() - 2 * 864e5, 'updatedAt untouched');
// saving the copy read (base with serverAt) again is not a conflict, and the stamp moves on
const c2 = await W.backend.commit(SS, 'notes', { ...got1, text: 'Fake note, edited' }, got1);
assert.equal(c2.text, 'Fake note, edited');
const got2 = await R.backend.fetchOne(SS, 'notes', 'n1');
assert.ok(got2.serverAt >= got1.serverAt);
// a merge collection (transaction + merge path) also gets the server stamp
await W.backend.commit(SS, 'shared', { id: 'h1', f: { a: 1 } }, null);
const h1 = await R.backend.fetchOne(SS, 'shared', 'h1');
await W.backend.commit(SS, 'shared', { ...h1, f: { a: 1, b: 2 } }, h1);
const h2 = await R.backend.fetchOne(SS, 'shared', 'h1');
assert.deepEqual(h2.f, { a: 1, b: 2 }); assert.ok(h2.serverAt >= h1.serverAt);

// the reader syncs with its clock 2 h fast
let rclock = Date.now() + 2 * 3600e3;
const sstores = createStores({ prefix: 'emu-srv:', colls: ['notes'] });
const shub = createSyncHub({ openStore: sstores.openStore, listen: R.backend.listen, fetchOne: R.backend.fetchOne, bin: null, grace: 0, now: () => rclock, stampMode: 'server' });
let notes = [];
off = shub.watch(SS, 'notes', l => { notes = l; });
assert.ok(await until(() => notes.length === 1), 'server mode: full read first');
off(); await settle(50); await shub.stopAll();
// the writer saves through its queue while offline; days later (its clock still behind) it comes back and sends
let wOnline = false;
const wbox = new Map();
const wq = createWriteQueue({ store: { async put(x) { wbox.set(x.key, structuredClone(x)); }, async list(o) { return [...wbox.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return wbox.has(k) ? structuredClone(wbox.get(k)) : null; }, async remove(k) { wbox.delete(k); }, async forget() {} },
  getOwner: () => SS, online: () => wOnline, backend: (scope, _kind, record, base) => W.backend.commit(scope, 'notes', record, base) });
wq.save('note', SS, { id: 'n2', text: 'Fake, written offline' }, null).catch(() => {});
await settle(200);
assert.equal(await W.backend.fetchOne(SS, 'notes', 'n2'), null, 'still on the device');
wclock += 1000; wOnline = true; wq.kick();
assert.ok(await until(() => wq.status('note', 'n2') === 'synced'), 'sent on reconnect');
// the reader opens again, now with its clock 2 h slow: a delta read on serverAt sees it
rclock = Date.now() - 2 * 3600e3;
const before = R.reads.notes.billed;
off = shub.watch(SS, 'notes', l => { notes = l; });
assert.ok(await until(() => notes.some(d => d.id === 'n2')), 'the late write arrives on the delta read');
await settle();
assert.ok(R.reads.notes.billed - before <= 2, 'a delta read, not a full one: ' + (R.reads.notes.billed - before));
off(); await settle(50); await shub.stopAll();
const smeta = (await (await sstores.openStore(SS)).load('notes')).meta;
assert.ok(smeta.anchor >= (await R.backend.fetchOne(SS, 'notes', 'n2')).serverAt - 1, 'anchored on the server stamp');

// an app's own write outside the queue, made offline: the local copy's stamp is pending and never moves the anchor
const P = srvDevice('srv-pending');
const pstores = createStores({ prefix: 'emu-srv-p:', colls: ['notes'] });
const phub = createSyncHub({ openStore: pstores.openStore, listen: P.backend.listen, fetchOne: P.backend.fetchOne, bin: null, grace: 0, stampMode: 'server' });
let pnotes = [];
off = phub.watch(SS, 'notes', l => { pnotes = l; });
assert.ok(await until(() => pnotes.length === 2));
await settle(); await phub.flush();
const anchor0 = (await (await pstores.openStore(SS)).load('notes')).meta.anchor;
await F.disableNetwork(P.db);
const stamps = await P.backend.stampFields();
F.setDoc(F.doc(P.db, 'spaces', SS, 'notes', 'n3'), { id: 'n3', text: 'Fake, offline setDoc', ...stamps }).catch(() => {});
await settle(300); await phub.flush();
assert.equal((await (await pstores.openStore(SS)).load('notes')).meta.anchor, anchor0, 'a pending stamp leaves the anchor');
await F.enableNetwork(P.db);
assert.ok(await until(async () => { await phub.flush(); return ((await (await pstores.openStore(SS)).load('notes')).meta.anchor || 0) > anchor0; }), 'the anchor moves once the server stamps it');
assert.equal(typeof pnotes.find(d => d.id === 'n3')?.serverAt, 'number');
// a held record edited offline by the app's own setDoc stays shown on a delta listener while its stamp is pending
off(); await settle(50); await phub.stopAll();
const pdelta = [];
const plisten = (...a) => { pdelta.push(a[2].since); return P.backend.listen(...a); };
const phub2 = createSyncHub({ openStore: pstores.openStore, listen: plisten, fetchOne: P.backend.fetchOne, bin: null, grace: 0, stampMode: 'server' });
off = phub2.watch(SS, 'notes', l => { pnotes = l; });
await settle(500); await phub2.flush();
assert.ok(pdelta[0] > 0, 'reopened on a delta read: ' + pdelta[0]);
await F.disableNetwork(P.db);
const n1 = pnotes.find(d => d.id === 'n1');
F.setDoc(F.doc(P.db, 'spaces', SS, 'notes', 'n1'), { ...n1, text: 'Fake, edited offline', ...(await P.backend.stampFields()) }).catch(() => {});
await settle(500); await phub2.flush();
assert.ok(pnotes.some(d => d.id === 'n1'), 'still shown while offline: ' + pnotes.map(d => d.id));
await F.enableNetwork(P.db);
assert.ok(await until(() => pnotes.find(d => d.id === 'n1')?.text === 'Fake, edited offline' && typeof pnotes.find(d => d.id === 'n1').serverAt === 'number'), 'and arrives with its server stamp');
off(); await settle(50); await phub2.stopAll();
await Promise.all([W, R, P].map(d => F.terminate(d.db)));

// ---- 0.4.0: a stamp moves past a fast writer's; a leave entry in the lock's own transaction; clearCache ----
const FAST = device('fast', doc => ({ ...doc, updatedAt: Date.now() + 3600e3 }));
const fast = await FAST.backend.commit(S, 'items', { id: 'f1', text: 'Fake by a fast clock' }, null);
const later = await A.backend.commit(S, 'items', { id: 'f1', text: 'Fake later edit' }, fast);
assert.equal(later.updatedAt, fast.updatedAt + 1, 'max(now, the server copy + 1)');
assert.equal((await A.backend.fetchOne(S, 'items', 'f1')).updatedAt, fast.updatedAt + 1);
const LOCK = device('lock', undefined, { onCommit: ({ scope, before, after, at, fields }) => after && after.locked && !(before && before.locked)
  ? [{ path: ['spaces', scope, 'leaves', 'item:' + after.id], data: { ...leaveEntry('item', after, at), ...fields } }] : [] });
const l1 = await LOCK.backend.commit(S, 'items', { id: 'l1', text: 'Fake' }, null);
assert.equal((await F.getDocFromServer(F.doc(LOCK.db, 'spaces', S, 'leaves', 'item:l1'))).exists(), false);
const l2 = await LOCK.backend.commit(S, 'items', { ...l1, locked: true }, l1);
const entry = (await F.getDocFromServer(F.doc(LOCK.db, 'spaces', S, 'leaves', 'item:l1'))).data();
assert.equal(entry.data.updatedAt, l2.updatedAt, 'the leave entry names the locked version');
assert.ok(entry.deletedAt > l2.updatedAt);
await LOCK.backend.clearCache();
await Promise.all([FAST].map(d => F.terminate(d.db)));

// ---- 0.5.1: create (no read in the transaction) and existing (ids the server has) ----
const made = await A.backend.create(S, 'made', { id: 'm1', text: 'Fake new' });
assert.ok(made.updatedAt > 0);
assert.equal((await B.backend.fetchOne(S, 'made', 'm1')).text, 'Fake new');
assert.equal((await A.backend.create(S, 'made', { id: 'm1', text: 'Fake resend' })).text, 'Fake new', 'a resend leaves the first copy');
for (let i = 2; i <= 40; i++) await A.backend.create(S, 'made', { id: 'm' + i, text: 'Fake ' + i });
const ask = Array.from({ length: 70 }, (_, i) => 'm' + (i + 1));
const have = await B.backend.existing(S, 'made', ask);
assert.deepEqual([...have].sort(), Array.from({ length: 40 }, (_, i) => 'm' + (i + 1)).sort(), 'only the 40 there, across three queries');

// ---- 0.5.2: two devices change one shared record at once; the server's copy shows once this device's save is done ----
// The listener hears the server's merged copy while this device's save is still being sent (a slow answer, held here
// until it has);
// laying the queue over the list only on the listener's snapshots kept the save's own copy, without the other
// device's change, until the record changed again.
{
  const M1 = device('m1', undefined, { merge: { shared: true } }), M2 = device('m2', undefined, { merge: { shared: true } });
  const SP = S + '-shared';
  const v0 = await M1.backend.commit(SP, 'shared', { id: 'people', names: {} }, null);
  const mstores = createStores({ prefix: 'emu-m1:', colls: ['shared'] });
  const mhub = createSyncHub({ openStore: mstores.openStore, listen: M1.backend.listen, fetchOne: M1.backend.fetchOne, bin: null, grace: 0 });
  const box = new Map();
  const outboxM = { async put(x) { box.set(x.key, structuredClone(x)); }, async list(o) { return [...box.values()].filter(x => x.owner === o).map(x => structuredClone(x)); }, async get(k) { return box.has(k) ? structuredClone(box.get(k)) : null; }, async remove(k) { box.delete(k); }, async forget() {} };
  let heard = [], shown = [], plain = [];
  const qm = createWriteQueue({ store: outboxM, getOwner: () => SP, backend: async (scope, _kind, record, base, extra) => {
    const r = await M1.backend.commit(scope, 'shared', record, base, extra);
    await settle(300);   // a slow answer: the save is accepted (shown) by now, 180 ms after it was made
    // the other device names itself now, and this device's listener hears the merged copy before this save is done
    await M2.backend.commit(scope, 'shared', { id: 'people', names: { bo: 'Bo' } }, v0);
    assert.ok(await until(() => heard[0]?.names?.bo === 'Bo'), 'the listener hears the other device\'s change');
    return r;
  } });
  await qm.activate(SP);
  const offA = watchSaved({ hub: mhub, queue: qm, scope: SP, coll: 'shared', kind: 'person' }, l => { shown = l; });
  const offB = mhub.watch(SP, 'shared', l => { heard = l; plain = qm.overlay('person', SP, l); });   // the old pattern, for contrast
  assert.ok(await until(() => shown.length === 1));
  await qm.save('person', SP, { id: 'people', names: { ann: 'Ann' } }, v0);
  assert.ok(await qm.settle('person', ['people']));
  assert.equal(qm.status('person', 'people'), 'synced');
  assert.deepEqual((await M1.backend.fetchOne(SP, 'shared', 'people')).names, { ann: 'Ann', bo: 'Bo' }, 'the server has both');
  assert.ok(await until(() => JSON.stringify(shown[0]?.names) === JSON.stringify({ ann: 'Ann', bo: 'Bo' })), 'this device shows both: ' + JSON.stringify(shown[0]?.names));
  assert.deepEqual(plain[0].names, { ann: 'Ann' }, 'the old pattern still shows the save\'s own copy (the bug)');
  offA(); offB(); await settle(50); await mhub.stopAll();
  await Promise.all([M1, M2].map(d => F.terminate(d.db)));
}

await Promise.all([A, B, OLD].map(d => F.terminate(d.db)));
console.log('firestore emulator tests passed');
process.exit(0);
