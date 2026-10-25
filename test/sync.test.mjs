// Run with: node test/sync.test.mjs  (fake data only)
// The sync engine (sync.js) against a fake server that counts the documents it sends, and the local store (store.js,
// memory in node). The same engine runs on Firestore in the app and on the demo backend in the browser tests; the
// emulator test (test/firestore.emulator.mjs) runs the Firestore adapter.
import assert from 'node:assert/strict';
import { plan, applyChanges, replaceAll, applyTombs, pruneGone, binTombs, eachSettled, createCollectionSync, createSyncHub, SKEW, FULL_EVERY, GONE_KEEP } from '../src/sync.js';
import { createStores } from '../src/store.js';
const { openStore, wipeStores, storeName } = createStores({ prefix: 'test-store:', colls: ['items', 'docs', 'notes'] });
const KINDS = { item: 'items', doc: 'docs', note: 'notes' };

const settle = () => new Promise(r => setTimeout(r, 5));
const DAY = 864e5, T0 = Date.parse('2026-10-13T08:00:00Z');

// ---- pure helpers ----
{
  assert.deepEqual(plan(null, T0), { full: true, since: null });
  assert.deepEqual(plan({ syncAt: T0 - 1000 }, T0), { full: true, since: null }, 'never fully read');
  assert.deepEqual(plan({ syncAt: T0 - 1000, fullAt: T0 - DAY }, T0), { full: false, since: T0 - 1000 - SKEW });
  assert.equal(plan({ syncAt: T0, fullAt: T0 - FULL_EVERY - 1 }, T0).full, true, 'weekly full read');
  assert.equal(plan({ syncAt: T0 + DAY, fullAt: T0 + DAY }, T0).full, true, 'clock went back a day');
  assert.equal(plan({ syncAt: T0 + 60e3, fullAt: T0 - DAY }, T0).since, T0 - SKEW, 'never past now');
  // a reader whose clock was 2 h ahead at its last sync (real 08:00, syncAt 10:00), opened at 12:00 with the clock put
  // right: anchored to the newest stamp it holds (others' edits up to 08:00), not 09:50 (bug: 08:00–09:50 never came)
  assert.equal(plan({ syncAt: T0 + 2 * 3600e3, fullAt: T0 - DAY }, T0 + 4 * 3600e3, T0 - 60e3).since, T0 - 60e3);
  assert.equal(plan({ syncAt: T0, fullAt: T0 - DAY }, T0 + 60e3, T0 + DAY).since, T0 - SKEW, 'a future stamp never moves it later');

  const docs = new Map([['a', { id: 'a', updatedAt: 1 }], ['b', { id: 'b', updatedAt: 1 }], ['c', { id: 'c', updatedAt: 1 }]]);
  const r = applyChanges(docs, [
    { type: 'modified', id: 'a', doc: { id: 'a', updatedAt: 5 } },
    { type: 'added', id: 'b', doc: { id: 'b', updatedAt: 1 } },         // unchanged: not written again
    { type: 'added', id: 'd', doc: { id: 'd', updatedAt: 3 } },         // older than its known deletion: stale
    { type: 'removed', id: 'c', doc: null },                            // not known to be deleted: check it
    { type: 'removed', id: 'zz', doc: null },                           // never had it
  ], { d: 4 });
  assert.deepEqual(r.put.map(d => d.id), ['a']); assert.deepEqual(r.del, []); assert.deepEqual(r.verify, ['c']);
  assert.equal(docs.get('a').updatedAt, 5); assert.ok(!docs.has('d'));
  const r2 = applyChanges(docs, [{ type: 'removed', id: 'c' }, { type: 'added', id: 'd', doc: { id: 'd', updatedAt: 9 } }], { c: 2, d: 4 });
  assert.deepEqual(r2.del, ['c']); assert.deepEqual(r2.put.map(d => d.id), ['d'], 'restored after the deletion');
  const r3 = applyChanges(new Map([['p', { id: 'p' }], ['q', { id: 'q' }]]), [{ type: 'removed', id: 'p' }, { type: 'removed', id: 'q' }], {}, id => id === 'p');
  assert.deepEqual([r3.del, r3.verify], [['p'], ['q']], 'a removal the server confirmed goes at once; others are checked');

  const m = new Map([['a', { id: 'a', v: 1 }], ['b', { id: 'b', v: 1 }]]);
  const rr = replaceAll(m, [{ id: 'a', v: 1 }, { id: 'c', v: 1 }]);
  assert.deepEqual(rr, { put: [{ id: 'c', v: 1 }], del: ['b'] }); assert.deepEqual([...m.keys()], ['a', 'c']);

  const g = {}, td = new Map([['x', { id: 'x', updatedAt: 10 }], ['y', { id: 'y', updatedAt: 30 }]]);
  assert.deepEqual(applyTombs(td, g, [{ id: 'x', deletedAt: 20 }, { id: 'y', deletedAt: 20 }, { id: 'q', deletedAt: 5 }, { id: 'bad' }]), ['x']);
  assert.ok(td.has('y'), 'restored (changed after it was binned) stays');
  assert.deepEqual(g, { x: 20, y: 20, q: 5 });
  assert.deepEqual(pruneGone({ old: T0 - GONE_KEEP - 1, new: T0 - 1 }, T0), { new: T0 - 1 });
  assert.deepEqual(binTombs([{ kind: 'item', data: { id: 'c1' }, deletedAt: 7 }, { kind: 'note', data: { id: 'n1' }, deletedAt: 8 }, { kind: 'summary', data: { id: 's' } }, { kind: 'doc', data: {} }], KINDS),
    { items: [{ id: 'c1', deletedAt: 7 }], notes: [{ id: 'n1', deletedAt: 8 }] });
  // the binned version's updatedAt decides, not when it was binned; even one stamped after deletedAt by a clock
  // running ahead: the copies of that version must go (bug: they stayed on every other device)
  assert.deepEqual(binTombs([{ kind: 'item', data: { id: 'v', updatedAt: 3 }, deletedAt: 9 }, { kind: 'item', data: { id: 'w', updatedAt: 12 }, deletedAt: 9 }], KINDS).items,
    [{ id: 'v', deletedAt: 3 }, { id: 'w', deletedAt: 12 }]);
  const fast = new Map([['x', { id: 'x', updatedAt: 1000 + 20 * 60e3 }]]);
  assert.deepEqual(applyTombs(fast, {}, binTombs([{ kind: 'item', deletedAt: 1000, data: { id: 'x', updatedAt: 1000 + 20 * 60e3 } }], KINDS).items), ['x']);
  // binned on a phone with an old copy (version 3), but the delete was refused: the record changed elsewhere at 5
  const refused = new Map([['x', { id: 'x', updatedAt: 5 }]]), g2 = {};
  assert.deepEqual(applyTombs(refused, g2, binTombs([{ kind: 'item', data: { id: 'x', updatedAt: 3 }, deletedAt: 9 }], KINDS).items), [], KINDS);
  assert.ok(refused.has('x'), 'a bin entry whose delete was refused removes nothing');
  assert.equal(applyChanges(refused, [{ type: 'modified', id: 'x', doc: { id: 'x', updatedAt: 6 } }], g2).put.length, 1, 'later edits still arrive');

  // stamping again one at a time: a deleted record doesn't stop the others
  const tried = [];
  const ok = await eachSettled(['a', 'b', 'gone', 'c'], async id => { tried.push(id); if (id === 'gone') throw new Error('NOT_FOUND'); }, 2);
  assert.deepEqual([tried, ok], [['a', 'b', 'gone', 'c'], ['a', 'b', 'c']]);
}

// ---- a fake server: collections of docs, live queries, and a count of documents sent ----
function fakeServer() {
  const colls = { items: new Map(), docs: new Map(), notes: new Map(), bin: new Map() };
  const watchers = new Set();
  const srv = {
    colls, reads: 0, listens: 0, fetches: 0, clock: T0,
    set(coll, doc) { colls[coll].set(doc.id, { ...doc }); for (const w of [...watchers]) if (w.coll === coll) w.run(); },
    del(coll, id) { colls[coll].delete(id); for (const w of [...watchers]) if (w.coll === coll) w.run(); },
    // Firestore bills each document a listener sends (at least one per query), as when it starts cold
    listen(email, coll, { since = null, field = 'updatedAt' } = {}, onSnap) {
      srv.listens++;
      const w = { coll, prev: null };
      w.run = () => {
        const docs = [...colls[coll].values()].filter(d => since === null || (Number(d[field]) || 0) > since).map(d => ({ ...d }));
        const next = new Map(docs.map(d => [d.id, JSON.stringify(d)])), changes = [];
        for (const d of docs) { const was = w.prev && w.prev.get(d.id); if (was !== next.get(d.id)) changes.push({ type: was ? 'modified' : 'added', id: d.id, doc: d }); }
        for (const id of (w.prev || new Map()).keys()) if (!next.has(id)) changes.push({ type: 'removed', id, doc: null });
        const first = w.prev === null;
        srv.reads += first ? Math.max(1, docs.length) : changes.filter(c => c.type !== 'removed').length;
        w.prev = next;
        if (first || changes.length) onSnap({ changes, fromCache: false, hasPendingWrites: false, ...(first && since === null ? { full: true, docs } : {}) });
      };
      watchers.add(w); w.run();
      return () => watchers.delete(w);
    },
    fetchOne(email, coll, id) { srv.fetches++; srv.reads++; const d = colls[coll].get(id); return d ? { ...d } : null; },
  };
  return srv;
}
const E = 'fake@example.com';

// ---- one collection: first open reads all, reopening reads ~nothing, one change reads one ----
{
  const srv = fakeServer();
  for (let i = 0; i < 50; i++) srv.set('items', { id: 'c' + i, details: 'Fake item ' + i, updatedAt: T0 - 2 * DAY });
  srv.set('items', { id: 'old', details: 'Fake item without updatedAt' });   // only a full read finds it
  let now = T0;
  const store = await openStore(E);
  const open = () => createCollectionSync({ email: E, coll: 'items', store, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now });

  let got = [];
  let s = open(); s.subscribe((l, m) => got.push([l.length, m.fromCache]));
  await settle();
  assert.deepEqual(got, [[51, false]], 'a device that never synced waits for the server');
  assert.equal(srv.reads, 51);
  await s.stop();

  now += 3600e3; srv.reads = 0; got = [];
  s = open(); s.subscribe((l, m) => got.push([l.length, m.fromCache]));
  await settle();
  assert.deepEqual(got, [[51, true], [51, false]], 'the stored list at once, then confirmed');
  assert.equal(srv.reads, 1, 'nothing changed: one read (an empty result)');
  await s.stop();

  now += 3600e3; srv.reads = 0; got = [];
  srv.set('items', { id: 'c7', details: 'Fake item 7 edited', updatedAt: now - 60e3 });
  srv.set('items', { id: 'new', details: 'Fake new item', updatedAt: now - 30e3 });
  let last = null;
  s = open(); s.subscribe(l => { last = l; });
  await settle();
  assert.equal(srv.reads, 2, 'two changed: two reads');
  assert.equal(last.length, 52); assert.equal(last.find(c => c.id === 'c7').details, 'Fake item 7 edited');
  last[0].details = 'mutated';   // callers get copies

  // live while open: a change, a deletion the server confirms in view (no extra read), a deletion via the bin
  srv.reads = 0;
  srv.set('items', { id: 'c1', details: 'Fake item 1 edited', updatedAt: now });
  srv.del('items', 'new');        // in view (changed recently): the server's removal, applied at once
  await settle();
  assert.ok(!last.some(c => c.id === 'new')); assert.equal(last.find(c => c.id === 'c1').details, 'Fake item 1 edited');
  assert.equal(srv.fetches, 0); assert.equal(srv.reads, 1);
  await s.tombs([{ id: 'c2', deletedAt: now }, { id: 'c1', deletedAt: now - 1 }]);
  assert.ok(!last.some(c => c.id === 'c2')); assert.ok(last.some(c => c.id === 'c1'), 'c1 changed after it was binned: kept');
  // deleted here for good: gone at once, and a stale copy from the server (still pending there) is ignored
  await s.drop(['c3']);
  assert.ok(!last.some(c => c.id === 'c3'));
  srv.set('items', { id: 'c3', details: 'stale', updatedAt: T0 - 2 * DAY });
  await settle(); assert.ok(!last.some(c => c.id === 'c3'));
  await s.stop();

  // a week on: a full read heals what the deltas can't see (the server still has c3; c2 truly gone)
  now += 8 * DAY; srv.reads = 0;
  srv.del('items', 'c2');
  srv.set('items', { id: 'c3', details: 'Fake item 3', updatedAt: now - 9 * DAY });
  s = open(); s.subscribe(l => { last = l; });
  await settle();
  assert.equal(srv.reads, 50, 'weekly full read (c2 gone)');
  assert.ok(last.some(c => c.id === 'c3') && !last.some(c => c.id === 'c2') && last.some(c => c.id === 'old'));
  await s.stop();
  await wipeStores();
  assert.deepEqual(await (await openStore(E)).load('items'), { docs: [], meta: {} }, 'wiped');
}

// ---- unverifiable removal (offline): dropped now, a full read next time ----
{
  const srv = fakeServer();
  srv.set('notes', { id: 'n1', body: 'Fake note', updatedAt: T0 });
  const store = await openStore(E);
  const offline = () => { throw new Error('offline'); };
  let last = null;
  // the removal arrives from the cache only (as after this device's own write), so it is checked: offline, it can't be
  const fromCache = (email, coll, opts, onSnap) => srv.listen(email, coll, opts, x => onSnap(x.full ? x : { ...x, fromCache: true }));
  const s = createCollectionSync({ email: E, coll: 'notes', store, listen: fromCache, fetchOne: offline, now: () => T0 });
  s.subscribe(l => { last = l; });
  await settle();
  srv.del('notes', 'n1');
  await settle();
  assert.deepEqual(last, []);
  await s.stop();
  assert.equal((await store.load('notes')).meta.fullAt, 0, 'next start reads everything');
  await wipeStores();
}

// ---- (0.9.4) a listener the server refused (permission-denied) listens again at the next replan ----
{
  const store = await openStore(E);
  const calls = [];
  const listen = (email, coll, opts, onSnap, onError) => {
    calls.push(coll);
    if (calls.length === 1) onError({ code: 'permission-denied' });
    else onSnap({ full: true, docs: [{ id: 'p1', updatedAt: T0 }], changes: [], fromCache: false });
    return () => {};
  };
  const errors = [];
  const s = createCollectionSync({ email: E, coll: 'items', store, listen, now: () => T0, onError: e => errors.push(e.code) });
  let last = null;
  s.subscribe(l => { last = l; });
  await settle();
  assert.deepEqual(errors, ['permission-denied']);
  assert.equal(calls.length, 1);
  assert.equal(s.replan(), true, 'a refused listener restarts at the next replan (claims or rules may have changed)');
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(last.map(d => d.id), ['p1']);
  assert.equal(s.replan(), false, 'a healthy listener is left alone');
  s.stop();
}

// ---- a removal after this device's own pending write (a refused write) is checked with one read ----
{
  let snap = null, fetched = 0;
  const store = await openStore(E);
  const listen = (email, coll, opts, onSnap) => { snap = onSnap; onSnap({ full: true, docs: [{ id: 'p1', updatedAt: T0 }], changes: [], fromCache: false }); return () => {}; };
  const fetchOne = (email, coll, id) => { fetched++; return id === 'p2' ? null : { id, updatedAt: T0 }; };
  let last = null;
  const s = createCollectionSync({ email: E, coll: 'items', store, listen, fetchOne, now: () => T0 });
  s.subscribe(l => { last = l; });
  await settle();
  snap({ changes: [{ type: 'added', id: 'p2', pending: true, doc: { id: 'p2', updatedAt: T0 + 1 } }], fromCache: false, hasPendingWrites: true });
  snap({ changes: [{ type: 'removed', id: 'p2' }, { type: 'removed', id: 'p1' }], fromCache: false, hasPendingWrites: false });
  await settle();
  assert.equal(fetched, 1, 'only the record with a pending write is checked');
  assert.deepEqual(last, []);
  snap({ changes: [{ type: 'added', id: 'p3', doc: { id: 'p3', updatedAt: T0 } }], fromCache: false });
  snap({ changes: [{ type: 'removed', id: 'p3' }], fromCache: true });
  await settle();
  assert.equal(fetched, 2, 'a removal seen only in the cache is checked');
  assert.deepEqual(last.map(d => d.id), ['p3'], 'it still exists');
  await s.stop(); await wipeStores();
}

// ---- the store deleted under a running engine (another tab): the next start reads everything ----
{
  const srv = fakeServer();
  for (let i = 0; i < 50; i++) srv.set('items', { id: 'w' + i, updatedAt: T0 - DAY });
  let now = T0;
  const hub = createSyncHub({ openStore, binKinds: KINDS, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now, grace: 0 });
  let last = null;
  const off = hub.watch(E, 'items', l => { last = l; }); await settle(); await hub.flush();
  await wipeStores();               // as another tab would
  now += 60e3;
  srv.set('items', { id: 'w50', updatedAt: now });
  await settle(); await hub.flush(); await settle(); await hub.flush();
  assert.equal(last.length, 51);
  const stored = await (await openStore(E)).load('items');
  assert.equal(stored.docs.length, 51, 'the whole list written back');
  assert.equal(stored.meta.fullAt, 0, 'and a full read next time');
  off(); await hub.stopAll();
  now += 3600e3; srv.reads = 0;
  const hub2 = createSyncHub({ openStore, binKinds: KINDS, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now, grace: 0 });
  const got = [];
  const off2 = hub2.watch(E, 'items', (l, m) => got.push([l.length, m.fromCache])); await settle();
  assert.deepEqual(got.at(-1), [51, false]);
  assert.ok(srv.reads >= 51, 'a full read');
  off2(); await hub2.stopAll(); await wipeStores();
}

// ---- a wipe can keep the account signed in now (an account switch; another tab may be using it) ----
{
  const a = await openStore('fake-a@example.com'), b = await openStore('fake-b@example.com');
  await a.write('items', { put: [{ id: 'a1' }] }); await b.write('items', { put: [{ id: 'b1' }] });
  await wipeStores(['FAKE-B@example.com']);
  assert.equal(a.closed, true); assert.equal(b.closed, false);
  assert.deepEqual((await b.load('items')).docs, [{ id: 'b1' }]);
  await wipeStores();
  assert.equal(b.closed, true);
}

// ---- the hub: shared engines, the bin feed, drops for collections not running ----
{
  const srv = fakeServer();
  let now = T0;
  srv.set('items', { id: 'k1', details: 'Fake', updatedAt: T0 - DAY });
  srv.set('notes', { id: 'n1', body: 'Fake note', updatedAt: T0 - DAY });
  srv.set('notes', { id: 'n2', body: 'Fake note 2', updatedAt: T0 - DAY });
  const hub = createSyncHub({ openStore, binKinds: KINDS, listen: srv.listen, fetchOne: srv.fetchOne, now: () => now, grace: 0 });
  const a = [], b = [];
  const offA = hub.watch(E, 'items', l => a.push(l.length)), offB = hub.watch(E, 'items', l => b.push(l.length));
  await settle();
  assert.equal(srv.listens, 2, 'one listener for items (shared) and one for the bin');
  assert.deepEqual([a, b], [[1], [1]]);
  // notes loaded once, then not running: a bin entry and a delete on this device still reach the stored copy
  const offN = hub.watch(E, 'notes', () => {}); await settle(); offN(); await settle();
  srv.set('bin', { id: 'n_n1_x', kind: 'note', data: { id: 'n1' }, deletedAt: now });
  await settle(); await hub.flush();
  await hub.drop(E, 'notes', ['n2']);
  assert.deepEqual((await (await openStore(E)).load('notes')).docs, []);
  // later, with the feed and notes engine stopped, the notes come back from the store without them
  offA(); offB(); await settle();
  now += 3600e3; srv.reads = 0;
  let notes = null;
  const offN2 = hub.watch(E, 'notes', l => { notes = l; }); await settle();
  assert.deepEqual(notes, []); assert.equal(srv.reads, 2, 'notes and bin: one read each');
  offN2();
  await hub.stopAll(); await wipeStores();
}

// ---- stopping and starting again within the grace keeps the same listener ----
{
  const srv = fakeServer();
  srv.set('items', { id: 'g1', updatedAt: T0 });
  const hub = createSyncHub({ openStore, binKinds: KINDS, listen: srv.listen, fetchOne: srv.fetchOne, now: () => T0, grace: 40 });
  let off = hub.watch(E, 'items', () => {}); await settle();
  const listens = srv.listens;
  off(); off = hub.watch(E, 'items', () => {}); await new Promise(r => setTimeout(r, 60));
  assert.equal(srv.listens, listens, 'no new listener');
  off(); await new Promise(r => setTimeout(r, 60));
  let got = null; off = hub.watch(E, 'items', l => { got = l; }); await settle();
  assert.equal(srv.listens, listens + 2, 'after the grace: a new one (items and the bin feed)');
  assert.deepEqual(got.map(d => d.id), ['g1']);
  off(); await hub.stopAll(); await wipeStores();
}

// ---- store: names per scope and realm; memory fallback in node ----
{
  assert.equal(storeName(' Fake@Example.com '), 'test-store:fake@example.com');
  const st = await openStore(E);
  assert.equal(st.kind, 'memory');
  await st.write('items', { put: [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], meta: { syncAt: 1 } });
  await st.write('items', { del: ['a'], put: [{ id: 'c', v: 2 }] });
  assert.deepEqual(await st.load('items'), { docs: [{ id: 'b', v: 1 }, { id: 'c', v: 2 }], meta: { syncAt: 1 } });
  await st.write('bin', { meta: { syncAt: 5 } });
  assert.deepEqual((await st.load('bin')).meta, { syncAt: 5 });
  await wipeStores();
  assert.equal(st.closed, true);
  await st.write('items', { put: [{ id: 'z' }] });   // an old handle never brings a wiped store back
  assert.deepEqual((await (await openStore(E)).load('items')).docs, []);
}

// ---- a local write that fails (storage full) never leaves meta claiming documents the device doesn't hold ----
{
  const srv = fakeServer();
  for (let i = 0; i < 5; i++) srv.set('items', { id: 'q' + i, updatedAt: T0 - DAY });
  const mem = await openStore(E);
  let full = true;   // writes of 3 or more documents fail, as QuotaExceededError on a phone low on storage
  const store = { load: c => mem.load(c), write: async (c, op) => { if (full && (op.put || []).length >= 3) throw new Error('QuotaExceededError'); return mem.write(c, op); } };
  let now = T0, last = null, snap = null;
  const listen = (email, coll, opts, onSnap) => { snap = onSnap; return srv.listen(email, coll, opts, onSnap); };
  const warn = console.warn; console.warn = () => {};
  let s = createCollectionSync({ email: E, coll: 'items', store, listen, now: () => now });
  s.subscribe(l => { last = l; });
  await settle(); await s.flush();
  assert.equal(last.length, 5, 'shown from memory');
  now += 60e3;
  snap({ changes: [], fromCache: false, hasPendingWrites: false });   // a metadata-only server snapshot: its write is small
  await s.flush();
  let stored = await mem.load('items');
  assert.ok(!(stored.docs.length < 5 && stored.meta.syncAt && stored.meta.fullAt), 'meta never claims a sync the documents lack');
  await s.stop();
  // the next start reads everything (not just changes since), so the missing records come back
  now += 3600e3; srv.reads = 0; full = false;
  s = createCollectionSync({ email: E, coll: 'items', store, listen, now: () => now });
  s.subscribe(l => { last = l; });
  await settle(); await s.flush();
  assert.equal(last.length, 5); assert.equal(srv.reads, 5, 'a full read');
  stored = await mem.load('items');
  assert.equal(stored.docs.length, 5, 'healed');
  // a write failing later (once): the next write puts the whole list back
  let fails = 1;
  const failing = { load: c => mem.load(c), write: async (c, op) => { if (fails && op.put && op.put.some(d => d.id === 'q20')) { fails--; throw new Error('UnknownError'); } return mem.write(c, op); } };
  await s.stop();
  s = createCollectionSync({ email: E, coll: 'items', store: failing, listen, now: () => now });
  s.subscribe(l => { last = l; }); await settle(); await s.flush();
  srv.set('items', { id: 'q20', updatedAt: now + 1 }); await settle(); await s.flush();
  srv.set('items', { id: 'q21', updatedAt: now + 2 }); await settle(); await s.flush();
  stored = await mem.load('items');
  assert.ok(stored.docs.some(d => d.id === 'q20') && stored.docs.some(d => d.id === 'q21'), 'the failed put is written with the next one');
  assert.equal(stored.meta.fullAt, 0, 'and the next start reads everything');
  await s.stop(); console.warn = warn; await wipeStores();
}

// ---- deleted here: the tombstone is the deleted version, so a restore (stamped after it) shows ----
{
  let snap = null;
  const store = await openStore(E);
  const listen = (email, coll, opts, onSnap) => { snap = onSnap; onSnap({ full: true, docs: [], changes: [], fromCache: false }); return () => {}; };
  let last = null;
  const s = createCollectionSync({ email: E, coll: 'items', store, listen, now: () => T0 });
  s.subscribe(l => { last = l; }); await settle();
  // edited on a device whose clock is 20 min fast, then moved to the bin here and restored a minute later
  const v = { id: 'x', details: 'Fake', updatedAt: T0 + 20 * 60e3 };
  snap({ changes: [{ type: 'added', id: 'x', doc: v }], fromCache: false });
  await s.drop(['x']);
  assert.deepEqual(last, []);
  snap({ changes: [{ type: 'added', id: 'x', doc: v }], fromCache: false });
  assert.deepEqual(last, [], 'the deleted version arriving again stays deleted');
  const restored = { ...v, updatedAt: v.updatedAt + 60e3 };   // the restore's write: stamped after the version it brings back
  assert.ok(restored.updatedAt > v.updatedAt);
  snap({ changes: [{ type: 'modified', id: 'x', doc: restored }], fromCache: false });
  assert.deepEqual(last.map(d => d.id), ['x'], 'the restored record shows');
  await s.stop(); await wipeStores();
}

// ---- store: an open that never settles falls back to memory ----
{
  const had = globalThis.indexedDB, warn = console.warn;
  globalThis.indexedDB = { open: () => ({}) };   // never calls back
  console.warn = () => {};
  try {
    const st = await openStore('fake-hang@example.com', 30);
    assert.equal(st.kind, 'memory');
  } finally { if (had === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = had; console.warn = warn; }
  await wipeStores();
}

// ---- store: a demo tab's sign-out never closes the real account's store in another tab ----
{
  const had = globalThis.indexedDB;
  // a minimal IndexedDB: opens at once, with every object store
  globalThis.indexedDB = { open: () => { const r = {}; setTimeout(() => { r.result = { objectStoreNames: { contains: () => true }, close() {}, version: 1 }; r.onsuccess(); }, 0); return r; } };
  try {
    const real = await openStore('fake-real@example.com');
    assert.equal(real.kind, 'idb');
    const other = new BroadcastChannel('test-store:');
    other.postMessage({ wipe: true, realm: 'demo:', keep: [] });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(real.closed, false, 'the demo’s wipe leaves it open');
    other.postMessage({ wipe: true, realm: '', keep: [] });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(real.closed, true, 'a real sign-out closes it');
    other.close();
  } finally { if (had === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = had; }
}

console.log('sync tests passed');
