// Run with: node --test test/held.test.mjs
// Held conflicts by field (0.6.3, opt-in): the 3-way merge (conflict.js mergeHeld), the adapter's held commit
// (firestore.js, on the fake SDK), the popup's data and the answer (createApp conflicts / describe / resolve), the
// status chip, and the report's counts by kind. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHeld, mergeFields, clashingFields, whenText, describeConflict, resolvedRecord, mergeClashes, pathOf as fieldPath, keysOf } from '../src/conflict.js';
import { createFirestoreBackend } from '../src/firestore.js';
import { createApp } from './factory.mjs';
import { buildReport } from '../src/report.js';
import { fakeServer } from './fake-server.mjs';
import { memOutbox, sharedSdk } from './fake-sdk.mjs';

const S = 'fake-space';
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await settle(10); } return true; };
const unavailable = () => Object.assign(new Error('offline'), { code: 'unavailable' });
const BACKOFF = new Set([2000, 4000, 8000, 16000, 32000, 60000]);
const quick = ms => settle(ms === 180 ? 5 : BACKOFF.has(ms) ? 10 : ms);
const pathOf = (coll, id) => `spaces/${S}/${coll}/${id}`;
const thrown = fn => { try { fn(); } catch (e) { return e; } return null; };

// ---- the merge (pure) ----

test('mergeHeld: different fields merge; the same field changed to the same value is no conflict', () => {
  const base = { id: 'r1', title: 'Fake', note: 'a', done: false };
  const current = { ...base, note: 'b' };                       // changed elsewhere
  assert.deepEqual(mergeHeld(current, { ...base, title: 'Fake 2' }, base), { id: 'r1', title: 'Fake 2', note: 'b', done: false });
  assert.deepEqual(mergeHeld({ ...base, done: true }, { ...base, done: true }, base), { ...base, done: true });
  // a field removed here, untouched there, goes; one added there stays
  assert.deepEqual(mergeHeld({ ...base, extra: 1 }, { id: 'r1', title: 'Fake', done: false }, base), { id: 'r1', title: 'Fake', done: false, extra: 1 });
});

test('mergeHeld: the same field changed to different values throws a write-conflict naming it, with the server copy', () => {
  const base = { id: 'r1', title: 'Fake', tags: { a: 1, b: 1 } };
  const current = { ...base, title: 'Theirs', tags: { a: 2, b: 1 } };
  const e = thrown(() => mergeHeld(current, { ...base, title: 'Mine', tags: { a: 1, b: 3 } }, base));
  assert.equal(e.code, 'write-conflict');
  assert.deepEqual(e.fields, ['title']);                        // tags merged key by key: a (theirs) and b (mine)
  assert.deepEqual(e.remote, current);
  assert.deepEqual(clashingFields(current, { ...base, tags: { a: 3, b: 1 } }, base), ['tags.a']);
  assert.deepEqual(clashingFields(current, { ...base, tags: { a: 1, b: 3 } }, base), []);
  // arrays and other values are whole fields
  assert.deepEqual(clashingFields({ id: 'r1', list: [1, 2] }, { id: 'r1', list: [1, 3] }, { id: 'r1', list: [1] }), ['list']);
});

test('mergeHeld: counters add each side\'s change; skipped fields keep the server\'s; pick resolves clashes', () => {
  const base = { id: 'r1', count: 3, title: 'Fake', updatedAt: 1, _edits: { x: 1 } };
  const current = { ...base, count: 5, title: 'Theirs', updatedAt: 9, _edits: { x: 2 } };
  const mine = { ...base, count: 4, title: 'Mine' };
  assert.equal(mergeHeld(current, mine, base, { counters: ['count'], pick: () => 'theirs' }).count, 6);
  assert.equal(mergeHeld(current, mine, base, { counters: ['count'], pick: () => 'mine' }).title, 'Mine');
  const out = mergeHeld(current, { ...mine, updatedAt: 2, _edits: {} }, base, { counters: ['count'], skip: ['_edits'], pick: () => 'theirs' });
  assert.equal(out.title, 'Theirs'); assert.equal(out.updatedAt, 9); assert.deepEqual(out._edits, { x: 2 });
  // without a base every field sent counts as changed
  assert.deepEqual(clashingFields({ id: 'r1', a: 1, b: 2 }, { id: 'r1', a: 1, b: 3 }, null), ['b']);
});

test("whenText: the device's time zone by default (1.5.0; Singapore until 1.4.x)", () => {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(whenText(Date.UTC(2026, 9, 25, 6, 5)), whenText(Date.UTC(2026, 9, 25, 6, 5), here));
  assert.equal(whenText(Date.UTC(2026, 9, 25, 6, 5), 'Asia/Singapore'), 'Sun 25 Oct, 14:05');
  assert.equal(whenText('2026-10-25T06:05:00Z', 'UTC'), 'Sun 25 Oct, 06:05');
  assert.equal(whenText(0), '');
});

test('describeConflict and resolvedRecord: both versions side by side; my other changes kept either way', () => {
  const base = { id: 'r1', title: 'Fake', note: 'a', place: 'x' };
  const remote = { ...base, title: 'Theirs', place: 'y', updatedAt: 5, _edits: { title: { by: 'Fake Other', device: 'Phone B', at: Date.UTC(2026, 9, 25, 6, 0) }, place: { by: 'Fake Other', device: 'Phone B', at: 1 } } };
  const record = { ...base, title: 'Mine', note: 'b' };
  const held = { record, base, remote, at: Date.UTC(2026, 9, 25, 6, 2) };
  const d = describeConflict(held, { edits: '_edits', me: { by: 'Fake Me', device: 'Phone A' }, timeZone: 'Asia/Singapore' });
  assert.deepEqual(d.deleted, { mine: false, theirs: false });
  assert.equal(d.fields.length, 1);
  const [f] = d.fields;
  assert.equal(f.path, 'title');
  assert.deepEqual([f.mine.value, f.mine.when, f.mine.by, f.mine.device], ['Mine', 'Sun 25 Oct, 14:02', 'Fake Me', 'Phone A']);
  assert.deepEqual([f.theirs.value, f.theirs.when, f.theirs.by, f.theirs.device], ['Theirs', 'Sun 25 Oct, 14:00', 'Fake Other', 'Phone B']);
  const theirs = resolvedRecord(held, 'theirs', { skip: ['_edits'] }), mine = resolvedRecord(held, 'mine', { skip: ['_edits'] });
  assert.deepEqual([theirs.title, theirs.note, theirs.place], ['Theirs', 'b', 'y']);
  assert.deepEqual([mine.title, mine.note, mine.place], ['Mine', 'b', 'y']);
  assert.equal(resolvedRecord(held, { title: 'mine' }).title, 'Mine');
  assert.equal(resolvedRecord(held, {}).title, 'Theirs', 'a field not named stays theirs');
  // deleted on one side: a whole-record choice
  const gone = describeConflict({ record, base, remote: null, at: 1 });
  assert.deepEqual([gone.deleted, gone.fields], [{ mine: false, theirs: true }, []]);
  assert.deepEqual(resolvedRecord({ record, base, remote: null }, 'theirs'), { id: 'r1', _deleted: true });
  assert.deepEqual(resolvedRecord({ record, base, remote: null }, 'mine'), record);
});

// ---- the adapter's held commit (fake SDK) ----

const backendOn = (dev, opts = {}) => createFirestoreBackend({ sdk: dev.sdk, path: (s, c) => ['spaces', s, c], ...opts });

test('held commit: different fields merge, same value passes, a clash writes nothing and holds; off by default', async () => {
  const shared = sharedSdk();
  const a = backendOn(shared.device({ name: 'a' }), { held: true }), b = backendOn(shared.device({ name: 'b' }), { held: true });
  const plain = backendOn(shared.device({ name: 'c' }));
  const base = { id: 'r1', title: 'Fake', note: 'a' };
  shared.meddle(pathOf('items', 'r1'), { ...base, updatedAt: 1 });
  await a.commit(S, 'items', { ...base, title: 'Fake A' }, base);
  await b.commit(S, 'items', { ...base, note: 'b' }, base);
  assert.deepEqual((({ updatedAt, ...r }) => r)(shared.docs.get(pathOf('items', 'r1'))), { id: 'r1', title: 'Fake A', note: 'b' });
  await b.commit(S, 'items', { ...base, title: 'Fake A' }, base);   // the same value: no conflict, nothing written
  const before = shared.commits.length;
  const e = await b.commit(S, 'items', { ...base, title: 'Fake B' }, base).catch(x => x);
  assert.equal(e.code, 'write-conflict'); assert.deepEqual(e.fields, ['title']); assert.equal(e.remote.title, 'Fake A');
  assert.equal(shared.commits.length, before, 'nothing written');
  // without held, the whole-record check stays: a change to another field elsewhere is a conflict
  const e2 = await plain.commit(S, 'items', { ...base, note: 'c' }, base).catch(x => x);
  assert.equal(e2.code, 'write-conflict'); assert.equal(e2.fields, undefined);
});

test('held commit: delete vs a change elsewhere and edit vs a delete elsewhere are held, never silent', async () => {
  const shared = sharedSdk(), a = backendOn(shared.device(), { held: true });
  const base = { id: 'r1', title: 'Fake' };
  shared.meddle(pathOf('items', 'r1'), { ...base, title: 'Changed', updatedAt: 2 });
  const e = await a.commit(S, 'items', { ...base, _deleted: true }, base).catch(x => x);
  assert.equal(e.code, 'write-conflict');
  assert.ok(shared.docs.has(pathOf('items', 'r1')));
  shared.meddle(pathOf('items', 'r2'), { id: 'r2', title: 'Fake' });
  shared.docs.delete(pathOf('items', 'r2'));
  const e2 = await a.commit(S, 'items', { id: 'r2', title: 'Mine' }, { id: 'r2', title: 'Fake' }).catch(x => x);
  assert.equal(e2.code, 'write-conflict'); assert.equal(e2.remote, null);
  assert.ok(!shared.docs.has(pathOf('items', 'r2')), 'not brought back without asking');
});

test('held commit: counters count both devices once each (a lost answer resent counts once); edits record who and when', async () => {
  const shared = sharedSdk();
  assert.throws(() => backendOn(shared.device(), { held: { items: { counters: ['count'] } } }), /need mark/);
  const opts = d => ({ held: { items: { counters: ['count'] } }, mark: '_saves', edits: '_edits', editor: () => ({ by: 'Fake Person', device: d }) });
  const a = backendOn(shared.device({ name: 'a' }), opts('Phone A')), b = backendOn(shared.device({ name: 'b' }), opts('Phone B'));
  const base = { id: 'r1', count: 3, title: 'Fake' };
  shared.meddle(pathOf('items', 'r1'), { ...base, updatedAt: 1 });
  await a.commit(S, 'items', { ...base, count: 4 }, base, { key: 'k-a' });
  shared.lostAck.push('deadline-exceeded');
  await b.commit(S, 'items', { ...base, count: 5, title: 'Fake B' }, base, { key: 'k-b' }).catch(() => {});
  await b.commit(S, 'items', { ...base, count: 5, title: 'Fake B' }, base, { key: 'k-b' });   // resent: applied once
  const doc = shared.docs.get(pathOf('items', 'r1'));
  assert.equal(doc.count, 6);
  assert.equal(doc.title, 'Fake B');
  assert.deepEqual([doc._edits.title.by, doc._edits.title.device, typeof doc._edits.title.at], ['Fake Person', 'Phone B', 'number']);
  assert.equal(doc._edits.count.device, 'Phone B');
  assert.equal(doc._edits.id, undefined);
});

// ---- two phones through createApp ----

function phone(name, shared, srv, { held = { notes: true }, edits = '_edits', merge } = {}) {
  const dev = { name, online: true, view: [], subs: new Set(), states: [] };
  const user = { uid: 'u1', email: 'fake@example.test', displayName: 'Fake Person', getIdTokenResult: async () => ({ claims: {} }), getIdToken: async () => 't' };
  const auth = { currentUser: user };
  const A = { onAuthStateChanged: (_a, cb) => { cb(auth.currentUser); return () => {}; }, signOut: async () => {}, GoogleAuthProvider: class {} };
  const backendOptions = { held, edits, mark: '_saves', ...(merge ? { merge } : {}) };
  const backend = createFirestoreBackend({ sdk: shared.device({ name }).sdk, path: (s, c) => ['spaces', s, c], ...backendOptions, editor: () => ({ by: 'Fake Person', device: name }) });
  const listen = (scope, coll, opts, onSnap, onError) => {
    const sub = { args: [scope, coll, opts, onSnap, onError], off: dev.online ? srv.listen(scope, coll, opts, onSnap, onError) : null };
    dev.subs.add(sub);
    return () => { sub.off?.(); dev.subs.delete(sub); };
  };
  const adapter = { listen, clearCache: async () => {},
    fetchOne: async (s, c, id) => { if (!dev.online) throw unavailable(); return srv.fetchOne(s, c, id); },
    commit: async (...a) => { if (!dev.online) throw unavailable(); return backend.commit(...a); } };
  dev.made = createApp({ name: 'held-' + name + '-' + Math.random().toString(36).slice(2), colls: ['notes'], kinds: { note: 'notes' }, path: (s, c) => ['spaces', s, c],
    sdk: async () => ({ A, F: {}, auth, db: {}, emulator: true }), adapter, backend: backendOptions, device: name,
    outbox: memOutbox(), nav: { get onLine() { return dev.online; }, storage: { persisted: async () => true, persist: async () => true } },
    storage: null, win: null, watchEvery: 0, queue: { delay: quick }, hub: { grace: 0 } });
  dev.app = dev.made;
  dev.start = async () => { dev.app = await dev.made; await dev.app.open(S); dev.app.watch(S, 'notes', list => { dev.view = list; }); dev.app.status$(st => dev.states.push(st.state)); await settle(20); };
  dev.offline = () => { dev.online = false; for (const s of dev.subs) { s.off?.(); s.off = null; } };
  dev.onlineAgain = () => { dev.online = true; for (const s of dev.subs) if (!s.off) s.off = srv.listen(...s.args); dev.app.queue.kick(); };
  dev.shown = id => dev.view.find(r => r.id === id) || null;
  dev.state = () => dev.states.at(-1);
  return dev;
}

async function twoPhones(opts) {
  const srv = fakeServer(), shared = sharedSdk({ srv });
  shared.meddle(pathOf('notes', 'n1'), { id: 'n1', title: 'Fake', place: 'Shelf', count: 1, updatedAt: 1 });
  const a = phone('Phone A', shared, srv, opts), b = phone('Phone B', shared, srv, opts);
  await a.start(); await b.start();
  return { srv, shared, a, b };
}
const strip = ({ updatedAt, ...r }) => r;

test('two phones: different fields both land; the same field clash is held on the second phone only, chip says attention', async () => {
  const { shared, a, b } = await twoPhones();
  const base = strip(a.shown('n1'));
  a.offline(); b.offline();
  await a.app.save('note', S, { ...base, title: 'Fake A' }, base).catch(() => {});
  await b.app.save('note', S, { ...base, place: 'Fridge', title: 'Fake B' }, base).catch(() => {});
  a.onlineAgain(); await a.app.flush(2000);
  b.onlineAgain(); await b.app.flush(2000);
  await until(() => b.state() === 'attention');
  // only the phone whose save was held has something to answer; the other has nothing held and is not in attention
  assert.equal(a.app.conflicts().length, 0);
  assert.notEqual(a.state(), 'attention');
  const [c] = b.app.conflicts();
  assert.deepEqual([c.kind, c.id], ['note', 'n1']);
  assert.equal(shared.docs.get(pathOf('notes', 'n1')).title, 'Fake A', 'nothing overwritten while unanswered');
  assert.equal(shared.docs.get(pathOf('notes', 'n1')).place, 'Shelf', 'a held save writes nothing, not even its other fields');
  const d = b.app.describe(c.key);
  assert.deepEqual(d.fields.map(f => [f.path, f.mine.value, f.theirs.value, f.mine.device, f.theirs.device, f.theirs.by]), [['title', 'Fake B', 'Fake A', 'Phone B', 'Phone A', 'Fake Person']]);
  assert.match(d.fields[0].theirs.when, /^\w{3} \d{1,2} \w{3}, \d\d:\d\d$/);
  // the chip stays on attention while unanswered (a wake changes nothing)
  b.app.nudge('wake'); await settle(30);
  assert.equal(b.state(), 'attention');
  // answered: theirs for the title; this phone's other change (place) still lands
  await b.app.resolve(c.key, 'theirs');
  await b.app.flush(2000);
  await until(() => b.state() === 'synced');
  const doc = shared.docs.get(pathOf('notes', 'n1'));
  assert.deepEqual([doc.title, doc.place], ['Fake A', 'Fridge']);
  assert.equal(b.app.conflicts().length, 0);
  assert.equal(b.app.describe(c.key), null);
  await until(() => a.shown('n1')?.place === 'Fridge');
  assert.equal(a.shown('n1')._edits, undefined, 'engine fields stay out of the app\'s lists');
});

test('two phones: answering mine saves this phone\'s value over the other; a same-value edit never asks', async () => {
  const { shared, a, b } = await twoPhones();
  const base = strip(a.shown('n1'));
  a.offline(); b.offline();
  await a.app.save('note', S, { ...base, title: 'Same' }, base).catch(() => {});
  await b.app.save('note', S, { ...base, title: 'Same' }, base).catch(() => {});
  a.onlineAgain(); b.onlineAgain(); await a.app.flush(2000); await b.app.flush(2000);
  assert.equal(b.app.conflicts().length + a.app.conflicts().length, 0, 'same value: no popup');
  await until(() => a.shown('n1')?.title === 'Same' && b.shown('n1')?.title === 'Same');
  const base2 = strip(a.shown('n1'));
  a.offline();
  await a.app.save('note', S, { ...base2, title: 'Fake A' }, base2).catch(() => {});
  await b.app.save('note', S, { ...strip(b.shown('n1')), title: 'Fake B' }, strip(b.shown('n1')));
  a.onlineAgain(); await a.app.flush(2000);
  const [c] = a.app.conflicts();
  assert.ok(c, 'held on the phone that saved second');
  assert.equal(b.app.conflicts().length, 0);
  await a.app.resolve(c.key, 'mine');
  await a.app.flush(2000);
  assert.equal(shared.docs.get(pathOf('notes', 'n1')).title, 'Fake A');
  await until(() => b.shown('n1')?.title === 'Fake A');
  assert.equal(b.shown('n1').title, 'Fake A');
  await assert.rejects(a.app.resolve(c.key, 'mine'), /no longer waiting/);
});

test('fix 0.7.1: a save queued behind one that is then held is part of the answer, never only set aside', async () => {
  const { shared, a, b } = await twoPhones();
  const base = strip(a.shown('n1'));
  a.offline(); b.offline();
  await a.app.save('note', S, { ...base, title: 'Fake A' }, base).catch(() => {});
  a.onlineAgain(); await a.app.flush(2000);
  // phone B, offline: the title (it will clash), then the place on top of its own version (queued before the clash)
  await b.app.save('note', S, { ...base, title: 'Fake B' }, base).catch(() => {});
  await b.app.save('note', S, { ...base, title: 'Fake B', place: 'Box' }, { ...base, title: 'Fake B' }).catch(() => {});
  b.onlineAgain(); await b.app.flush(2000);
  await until(() => b.state() === 'attention');
  const [c] = b.app.conflicts();
  assert.equal(b.app.describe(c.key).mine.value.place, 'Box', 'mine is this phone\'s newest version');
  await b.app.resolve(c.key, 'theirs');
  await b.app.flush(2000);
  const doc = shared.docs.get(pathOf('notes', 'n1'));
  assert.deepEqual([doc.title, doc.place], ['Fake A', 'Box'], 'theirs for the title; the later place change still lands');
});

// ---- held conflicts for merge collections (0.7.1): the app's merge function applies ops ----

// A made-up merge function like an app's: ops are [{ set: { path: value } } | { inc: { path: n } } | { put: true }],
// applied in order to the copy given (current); a put replaces it with the record.
const applyOps = (current, record, _base, ops) => {
  let doc = current ? JSON.parse(JSON.stringify(current)) : { id: record.id };
  for (const o of ops && ops.length ? ops : [{ put: true }]) {
    if (o.put) { doc = JSON.parse(JSON.stringify(record)); continue; }
    for (const [path, v] of Object.entries(o.set || o.inc || {})) {
      const keys = path.split('.'), last = keys.pop();
      let at = doc; for (const k of keys) at = at[k] = at[k] && typeof at[k] === 'object' ? at[k] : {};
      at[last] = o.inc ? (typeof at[last] === 'number' ? at[last] : 0) + v : v;
    }
  }
  return doc;
};

test('mergeClashes: a set over a change elsewhere clashes; increments and one-sided changes never do', () => {
  const base = { id: 'r1', place: 'Shelf', lots: { a: { qty: 3, note: 'x' } } };
  const cur = { id: 'r1', place: 'Fridge', lots: { a: { qty: 5, note: 'y' } } };
  const mine = applyOps(base, base, base, [{ set: { place: 'Box', 'lots.a.note': 'z' } }, { inc: { 'lots.a.qty': 1 } }]);
  const merged = applyOps(cur, base, base, [{ set: { place: 'Box', 'lots.a.note': 'z' } }, { inc: { 'lots.a.qty': 1 } }]);
  assert.equal(merged.lots.a.qty, 6, 'both increments count');
  assert.deepEqual(mergeClashes(cur, mine, merged, base), ['place', 'lots.a.note']);
  // only this device changed it, only elsewhere, or both to the same value: no clash
  assert.deepEqual(mergeClashes({ ...base, place: 'Fridge' }, { ...base, lots: { a: { qty: 3, note: 'z' } } }, { place: 'Fridge', lots: { a: { qty: 3, note: 'z' } } }, base), []);
  assert.deepEqual(mergeClashes({ ...base, place: 'Box' }, { ...base, place: 'Box' }, { ...base, place: 'Box' }, base), []);
  // a removal here over a change there clashes; the merge keeping the server's value (its own rule) does not
  assert.deepEqual(mergeClashes(cur, { id: 'r1', lots: base.lots }, { id: 'r1', lots: cur.lots }, base), ['place']);
  assert.deepEqual(mergeClashes(cur, { ...base, place: 'Box' }, cur, base), []);
  // stamps and skipped fields never clash
  assert.deepEqual(mergeClashes({ ...base, updatedAt: 9, _s: [1] }, { ...base, updatedAt: 2, _s: [2] }, { ...base, updatedAt: 2, _s: [2] }, { ...base, updatedAt: 1 }, { skip: ['_s'] }), []);
});

test('held merge commit: off unless named; ops land on the server copy; a set over a change elsewhere is held, nothing written', async () => {
  const shared = sharedSdk();
  const opts = d => ({ merge: { items: applyOps }, held: { items: true }, mark: '_saves', edits: '_edits', editor: () => ({ by: 'Fake Person', device: d }) });
  const a = backendOn(shared.device({ name: 'a' }), opts('Phone A')), b = backendOn(shared.device({ name: 'b' }), opts('Phone B'));
  const lww = backendOn(shared.device({ name: 'c' }), { merge: { items: applyOps }, held: true, mark: '_saves' });   // held: true leaves merge collections as they were
  const base = { id: 'r1', place: 'Shelf', lots: { a: { qty: 3 } } };
  shared.meddle(pathOf('items', 'r1'), { ...base, updatedAt: 1 });
  await a.commit(S, 'items', base, base, { key: 'k-a', ops: [{ inc: { 'lots.a.qty': 2 } }, { set: { place: 'Fridge' } }] });
  shared.lostAck.push('deadline-exceeded');
  await b.commit(S, 'items', base, base, { key: 'k-b', ops: [{ inc: { 'lots.a.qty': 1 } }] }).catch(() => {});
  await b.commit(S, 'items', base, base, { key: 'k-b', ops: [{ inc: { 'lots.a.qty': 1 } }] });   // resent: counted once
  let doc = shared.docs.get(pathOf('items', 'r1'));
  assert.deepEqual([doc.lots.a.qty, doc.place], [6, 'Fridge'], 'both increments count once, never a clash');
  assert.deepEqual([doc._edits.place.device, doc._edits.lots.device], ['Phone A', 'Phone B']);
  const before = shared.commits.length;
  const e = await b.commit(S, 'items', base, base, { key: 'k-b2', ops: [{ set: { place: 'Box' } }, { inc: { 'lots.a.qty': 1 } }] }).catch(x => x);
  assert.equal(e.code, 'write-conflict'); assert.deepEqual(e.fields, ['place']); assert.equal(e.remote.place, 'Fridge');
  assert.equal(shared.commits.length, before, 'held: nothing written, not even the increment');
  // a merge function that refuses a change gets the server copy as remote
  const refuse = backendOn(shared.device({ name: 'd' }), { merge: { items: () => { throw Object.assign(new Error('no'), { code: 'write-conflict' }); } }, held: { items: true } });
  const e2 = await refuse.commit(S, 'items', base, base, { ops: [] }).catch(x => x);
  assert.equal(e2.remote.place, 'Fridge');
  // a delete over a change elsewhere and an edit of a record deleted elsewhere are held, as with whole records
  assert.equal((await a.commit(S, 'items', { id: 'r1', _deleted: true }, base).catch(x => x)).code, 'write-conflict');
  shared.meddle(pathOf('items', 'r2'), { id: 'r2', place: 'Shelf' }); shared.docs.delete(pathOf('items', 'r2'));
  const e3 = await a.commit(S, 'items', { id: 'r2' }, { id: 'r2', place: 'Shelf' }, { ops: [{ set: { place: 'Box' } }] }).catch(x => x);
  assert.equal(e3.code, 'write-conflict'); assert.equal(e3.remote, null);
  // held: true without naming it: the merge collection stays last-write-wins (unchanged)
  await lww.commit(S, 'items', base, base, { key: 'k-c', ops: [{ set: { place: 'Box' } }] });
  doc = shared.docs.get(pathOf('items', 'r1'));
  assert.equal(doc.place, 'Box');
});

test('two phones, merge collection: increments both land; a set clash is held on the second phone and answered through the merge', async () => {
  const opts = { held: { notes: true }, merge: { notes: applyOps } };
  const { shared, a, b } = await twoPhones(opts);
  const base = strip(a.shown('n1'));
  a.offline(); b.offline();
  await a.app.save('note', S, base, base, { ops: { set: { place: 'Fridge' }, inc: undefined } }).catch(() => {});
  a.onlineAgain(); await a.app.flush(2000);
  await b.app.save('note', S, base, base, { ops: { inc: { count: 2 } } }).catch(() => {});
  await b.app.save('note', S, base, base, { ops: { set: { place: 'Box', title: 'Fake B' } } }).catch(() => {});
  await b.app.save('note', S, base, base, { ops: { inc: { count: 1 } } }).catch(() => {});
  b.onlineAgain(); await b.app.flush(2000);
  await until(() => b.state() === 'attention');
  const doc = shared.docs.get(pathOf('notes', 'n1'));
  assert.deepEqual([doc.place, doc.count], ['Fridge', 3], 'the increment before the clash landed; nothing overwritten');
  const [c] = b.app.conflicts();
  const d = b.app.describe(c.key);
  assert.deepEqual(d.fields.map(f => [f.path, f.mine.value, f.theirs.value, f.theirs.device]), [['place', 'Box', 'Fridge', 'Phone A']]);
  await b.app.resolve(c.key, { place: 'theirs' });
  await b.app.flush(2000);
  await until(() => b.state() === 'synced');
  const end = shared.docs.get(pathOf('notes', 'n1'));
  assert.deepEqual([end.place, end.title, end.count], ['Fridge', 'Fake B', 4], 'theirs kept, my other set and my later increment land once');
  assert.equal(b.app.conflicts().length, 0);
  await until(() => a.shown('n1')?.count === 4);
});

// ---- fix 0.7.4: a map keyed by something with '.' in it (an email) ----

const EMAIL = 'a.b@example.test', P = 'names.a\\.b@example\\.test';

test('fix 0.7.4: a clash under a dotted key is one path, escaped; describe shows its values and resolve writes it there', () => {
  const base = { id: 'r1', names: { [EMAIL]: 'Fake', 'c@x': 'Other' } };
  const remote = { ...base, names: { ...base.names, [EMAIL]: 'Fake A' }, updatedAt: 5 };
  const record = { ...base, names: { ...base.names, [EMAIL]: 'Fake B' } };
  assert.deepEqual(clashingFields(remote, record, base), [P]);
  const d = describeConflict({ record, base, remote, at: 1 });
  assert.deepEqual(d.fields.map(f => [f.path, f.keys, f.mine.value, f.theirs.value]), [[P, ['names', EMAIL], 'Fake B', 'Fake A']]);
  for (const choice of ['theirs', { [P]: 'theirs' }]) {
    const out = resolvedRecord({ record, base, remote }, choice);
    assert.deepEqual(out.names, { [EMAIL]: 'Fake A', 'c@x': 'Other' }, 'no nested junk keys');
  }
  assert.deepEqual(resolvedRecord({ record, base, remote }, { [P]: 'mine' }).names, { [EMAIL]: 'Fake B', 'c@x': 'Other' });
  // a merge collection: the same, through the merge function
  const opts = { merge: mergeFields };
  assert.deepEqual(describeConflict({ record, base, remote, at: 1 }, opts).fields.map(f => [f.path, f.mine.value, f.theirs.value]), [[P, 'Fake B', 'Fake A']]);
  assert.deepEqual(resolvedRecord({ record, base, remote }, 'theirs', opts).names, { [EMAIL]: 'Fake A', 'c@x': 'Other' });
  assert.deepEqual(resolvedRecord({ record, base, remote }, { [P]: 'mine' }, opts).names, { [EMAIL]: 'Fake B', 'c@x': 'Other' });
  assert.deepEqual(mergeClashes(remote, record, record, base), [P]);
});

test('fix 0.7.4: pathOf and keysOf round-trip keys with dots and backslashes; plain paths read as before', () => {
  for (const keys of [['title'], ['names', EMAIL], ['a\\b', 'c.d.', '.'], ['x', '']]) assert.deepEqual(keysOf(fieldPath(keys)), keys);
  assert.equal(fieldPath(['names', EMAIL]), P);
  assert.deepEqual(keysOf('place.shelf'), ['place', 'shelf']);
});

test('fix 0.7.4: two phones, a dotted key held (whole record and merge collection): popup values right, theirs and mine land in place', async () => {
  for (const opts of [undefined, { held: { notes: true }, merge: { notes: true } }]) {
    const { shared, a, b } = await twoPhones(opts);
    const base0 = strip(a.shown('n1'));
    await a.app.save('note', S, { ...base0, names: { [EMAIL]: 'Fake', 'c@x': 'Other' } }, base0);
    await a.app.flush(2000);
    await until(() => b.shown('n1')?.names);
    const base = strip(b.shown('n1'));
    a.offline(); b.offline();
    await a.app.save('note', S, { ...base, names: { ...base.names, [EMAIL]: 'Fake A' } }, base).catch(() => {});
    await b.app.save('note', S, { ...base, names: { ...base.names, [EMAIL]: 'Fake B' }, title: 'Fake B' }, base).catch(() => {});
    a.onlineAgain(); await a.app.flush(2000);
    b.onlineAgain(); await b.app.flush(2000);
    await until(() => b.app.conflicts().length === 1);
    const [c] = b.app.conflicts();
    const d = b.app.describe(c.key);
    assert.deepEqual(d.fields.map(f => [f.path, f.keys, f.mine.value, f.theirs.value, f.theirs.device]), [[P, ['names', EMAIL], 'Fake B', 'Fake A', 'Phone A']], opts ? 'merge' : 'held');
    await b.app.resolve(c.key, 'theirs');
    await b.app.flush(2000);
    await until(() => b.app.conflicts().length === 0);
    const doc = shared.docs.get(pathOf('notes', 'n1'));
    assert.deepEqual([doc.names, doc.title], [{ [EMAIL]: 'Fake A', 'c@x': 'Other' }, 'Fake B']);
    assert.equal(doc.names.a, undefined, 'no nested junk keys');
    assert.equal(doc._edits.names.device, 'Phone A', '_edits keys stay top-level field names');
  }
});

// ---- the report ----

test('report byKind: conflicts counted per kind, only when asked and only when there are some', () => {
  const entries = [{ state: 'conflict', kind: 'note' }, { state: 'conflict', kind: 'note' }, { state: 'conflict', kind: 'bad kind!' }, { state: 'failed', kind: 'note' }];
  const r = buildReport({ app: 'demo', version: 'v1', entries, byKind: true });
  assert.deepEqual(r.held, { note: 2, other: 1 });
  assert.equal(r.conflicts, 3);
  assert.equal(buildReport({ app: 'demo', version: 'v1', entries }).held, undefined, 'off by default');
  assert.equal(buildReport({ app: 'demo', version: 'v1', entries: [], byKind: true }).held, undefined);
});
