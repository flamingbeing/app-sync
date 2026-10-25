// Run with: node --test test/app.test.mjs
// createApp (app.js), the one call that wires the safe path: sign-in, the storage guard, claims refresh, the device
// copy, the outbox and queue, the watchdog, the status and the sign-out wipe. Here on a fake auth SDK and a fake
// adapter over the fake server (the real adapter: test/firestore.emulator.mjs). Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { ESCALATE_MS } from '../src/watchdog.js';
import { checkWrite, recordSignature } from '../src/conflict.js';
import { fakeServer } from './fake-server.mjs';
import { createFirestoreBackend } from '../src/firestore.js';
import { createOutboxRegistry } from '../src/registry.js';
import { memOutbox as sharedOutbox, sharedSdk } from './fake-sdk.mjs';

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const until = async (ok, ms = 2000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await settle(5); } return true; };
let n = 0;
const uniq = () => 'apptest' + (++n) + '-' + Date.now();

// a made-up account
function fakeUser({ uid = 'u1', email = 'Fake.Person@Example.test', claims = {} } = {}) {
  const u = { uid, email, displayName: 'Fake Person', photoURL: '', emailVerified: true, claims, refreshed: 0, tokens: 0 };
  u.getIdTokenResult = async () => ({ claims: u.claims });
  u.getIdToken = async force => { u.tokens++; if (force) u.refreshed++; return 'fake-token-' + u.uid; };
  return u;
}
// the auth part of the SDK: popup or redirect sign-in, state listeners, sign-out
function fakeAuthSdk({ popupError = null, user = fakeUser() } = {}) {
  const calls = [];
  const auth = { currentUser: null, cbs: new Set(), set(u) { this.currentUser = u; for (const cb of [...this.cbs]) cb(u); } };
  const A = {
    GoogleAuthProvider: class { setCustomParameters(p) { this.params = p; } },
    async signInWithPopup(a) { calls.push('popup'); if (popupError) throw Object.assign(new Error('fake'), { code: popupError }); a.set(user); },
    async signInWithRedirect() { calls.push('redirect'); },
    async getRedirectResult() { calls.push('redirect-result'); return null; },
    onAuthStateChanged(a, cb) { a.cbs.add(cb); cb(a.currentUser); return () => a.cbs.delete(cb); },
    async signOut(a) { calls.push('signOut'); a.set(null); },
  };
  return { A, auth, calls, user };
}
// the adapter's contract (firestore.js) over the fake server: listen, fetchOne, commit with the conflict check, clearCache
function fakeAdapter(srv, { refuse = null } = {}) {
  const commits = [];
  return {
    commits, cleared: 0,
    listen: srv.listen, fetchOne: srv.fetchOne,
    async commit(scope, coll, record, base) {
      if (refuse) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: refuse });
      const held = srv.get(coll, record.id), current = held ? (({ updatedAt, serverAt, _saves, ...rest }) => rest)(held) : null;   // (the content, as the real adapter compares)
      checkWrite(current, record._deleted ? null : record, base);
      const at = Date.now();
      commits.push({ scope, coll, id: record.id });
      if (record._deleted) srv.del(coll, record.id); else srv.set(coll, { ...record, updatedAt: at, serverAt: at, _saves: ['k'] });
      return { at };
    },
    async clearCache() { this.cleared++; },
  };
}
// a browser's navigator: online, and the storage guard's answers
const fakeNav = ({ online = true, persisted = true } = {}) => {
  const nav = { onLine: online, asked: 0, storage: { persisted: async () => { nav.asked++; return persisted; }, persist: async () => persisted } };
  return nav;
};
// an outbox in memory, shaped like createOutbox's (the real one needs IndexedDB or localStorage)
function memOutbox(name, realm = 'default', records = new Map()) {
  return {
    name, realm, records,
    async put(x) { records.set(x.key, structuredClone(x)); },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); },
    async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; },
    async remove(k) { records.delete(k); },
    async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); },
  };
}
function memStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; }

// an app as a cloud.js would make it: only config
function makeApp(over = {}) {
  const srv = over.srv || fakeServer();
  const sdk = over.sdkParts || fakeAuthSdk();
  const adapter = over.adapter || fakeAdapter(srv);
  const nav = over.nav || fakeNav();
  const name = over.name || uniq();
  const app = createApp({
    name, colls: ['items'], path: (scope, coll) => ['spaces', scope, coll],
    sdk: async () => ({ A: sdk.A, F: {}, auth: sdk.auth, db: {} }),
    kinds: { item: 'items' }, adapter, nav, storage: memStorage(), outbox: memOutbox(name + '-outbox'), watchEvery: 0,
    ...over.options,
  });
  return { app, srv, sdk, adapter, nav, name };
}

test('createApp says which required option is missing', () => {
  assert.throws(() => createApp({ colls: ['items'], path: () => [], sdk: async () => ({}) }), /name/);
  assert.throws(() => createApp({ name: 'x', path: () => [], sdk: async () => ({}) }), /colls/);
  assert.throws(() => createApp({ name: 'x', colls: ['items'], sdk: async () => ({}) }), /path/);
  assert.throws(() => createApp({ name: 'x', colls: ['items'], path: () => [] }), /sdk/);
});

test('sign-in: popup first; a blocked popup falls back to redirect; an installed app goes straight to redirect', async () => {
  const a = makeApp();
  await a.app.signIn();
  assert.deepEqual(a.sdk.calls.filter(c => c !== 'redirect-result'), ['popup']);
  const b = makeApp({ sdkParts: fakeAuthSdk({ popupError: 'auth/popup-blocked' }) });
  await b.app.signIn();
  assert.deepEqual(b.sdk.calls.filter(c => c !== 'redirect-result'), ['popup', 'redirect']);
  const c = makeApp({ options: { redirectFirst: () => true } });
  await c.app.signIn();
  assert.deepEqual(c.sdk.calls.filter(c => c !== 'redirect-result'), ['redirect']);
  // any other popup error is the caller's (cancelled by the person, network)
  const d = makeApp({ sdkParts: fakeAuthSdk({ popupError: 'auth/popup-closed-by-user' }) });
  await assert.rejects(d.app.signIn(), e => e.code === 'auth/popup-closed-by-user');
});

test('sign-in with popupOnly: never a redirect, even blocked or installed (a page served away from the auth domain)', async () => {
  const a = makeApp({ sdkParts: fakeAuthSdk({ popupError: 'auth/popup-blocked' }), options: { popupOnly: true, redirectFirst: () => true } });
  await assert.rejects(a.app.signIn(), e => e.code === 'auth/popup-blocked');
  assert.deepEqual(a.sdk.calls.filter(c => c !== 'redirect-result'), ['popup']);
  const b = makeApp({ options: { popupOnly: true } });
  await b.app.signIn();
  assert.deepEqual(b.sdk.calls.filter(c => c !== 'redirect-result'), ['popup']);
  assert.equal(b.app.user()?.uid, 'u1');
});

test('user: the account as the app needs it (email lower-cased), heard through onUser; a redirect sign-in is finished on load', async () => {
  const { app, sdk } = makeApp();
  const seen = [];
  const off = await app.onUser(u => seen.push(u));
  assert.ok(sdk.calls.includes('redirect-result'), 'getRedirectResult on load');
  await app.signIn();
  assert.deepEqual(seen.at(-1), { uid: 'u1', email: 'fake.person@example.test', name: 'Fake Person', photo: '', verified: true });
  assert.deepEqual(app.user(), seen.at(-1));
  off();
});

test('the storage guard is asked at sign-in, and its answer feeds the status (at-risk offline)', async () => {
  const nav = fakeNav({ online: false, persisted: false });
  const { app } = makeApp({ nav });
  await app.onUser(() => {});
  assert.equal(nav.asked, 0, 'not before sign-in');
  await app.signIn();
  assert.ok(await until(() => nav.asked > 0), 'asked at sign-in');
  await app.open('s1');
  await app.save('item', 's1', { id: 'r1', text: 'Fake' });
  const states = [];
  app.status$(st => states.push(st.state));
  assert.ok(await until(() => states.at(-1) === 'at-risk'), 'unsent, offline, storage not kept: ' + states.join());
});

test('claims: asked once when the role doc\'s v is ahead of the token, then the token is refreshed', async () => {
  const user = fakeUser({ claims: { v: 1, g: { _: 'viewer' } } });
  const posts = [];
  const fetch = async (url, init) => { posts.push({ url, auth: init.headers.Authorization }); return { ok: true }; };
  let entry = { role: 'admin', v: 2 };
  const { app } = makeApp({ sdkParts: fakeAuthSdk({ user }), options: { fetch, claims: { url: '/api/claims', entry: async () => entry } } });
  await app.onUser(() => {});
  await app.signIn();
  assert.ok(await until(() => user.refreshed === 1), 'token refreshed after the Worker answered');
  assert.deepEqual(posts, [{ url: '/api/claims', auth: 'Bearer fake-token-u1' }]);
  // the same v again (another check on this page): not asked twice
  await app.refreshClaims();
  assert.equal(posts.length, 1);
  // token up to date: nothing asked
  user.claims = { v: 2, g: { _: 'admin' } }; entry = { role: 'admin', v: 2 };
  await app.refreshClaims();
  assert.equal(posts.length, 1);
  // a newer role: asked again
  entry = { role: 'viewer', v: 3 };
  await app.refreshClaims();
  assert.equal(posts.length, 2);
});

test('claims: a Worker that fails changes nothing and never throws into the app', async () => {
  const user = fakeUser();
  const fetch = async () => { throw new Error('offline'); };
  const { app } = makeApp({ sdkParts: fakeAuthSdk({ user }), options: { fetch, claims: { url: '/api/claims', entry: async () => ({ v: 1 }) } } });
  await app.onUser(() => {});
  await app.signIn();
  await assert.doesNotReject(app.refreshClaims());
  assert.equal(user.refreshed, 0);
});

test('watch: the device copy and the server, with this device\'s unsent saves laid over, engine fields left out', async () => {
  const nav = fakeNav();
  const { app, srv } = makeApp({ nav });
  srv.set('items', { id: 'a', text: 'Fake server', updatedAt: Date.now(), serverAt: 1, _saves: ['x'] });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let list = [];
  const off = app.watch('s1', 'items', l => { list = l; });
  assert.ok(await until(() => list.length === 1));
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'text', 'updatedAt'], 'no _saves, no serverAt');
  nav.onLine = false;
  await app.save('item', 's1', { id: 'b', text: 'Fake unsent' });
  assert.ok(await until(() => list.some(d => d.id === 'b')), 'the unsent save shows at once');
  off();
});

test('save: a record\'s saves go out one at a time in the order made, and the status says saving, then synced once the server is heard', async () => {
  const { app, srv, adapter } = makeApp();
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const states = [];
  app.status$(st => states.push(st.state));
  const off = app.watch('s1', 'items', () => {});
  const v = i => ({ id: 'r', text: 'Fake ' + i });
  await Promise.all([1, 2, 3].map(i => app.save('item', 's1', v(i), i > 1 ? v(i - 1) : null)));   // each made on the one before
  assert.equal(await app.flush(2000), true);
  assert.equal(srv.get('items', 'r').text, 'Fake 3', 'the last one made wins');
  assert.equal(adapter.commits.length, 3);
  assert.ok(await until(() => states.at(-1) === 'synced'), states.join());
  assert.ok(states.includes('saving'), 'saving while the saves were on their way: ' + states.join());
  off();
});

test('status: unknown, not synced, until the server has answered once since the page opened', async () => {
  const srv = fakeServer();
  let answer = false;
  const listen = (scope, c, o, cb) => srv.listen(scope, c, o, s => { if (answer) cb(s); else cb({ ...s, fromCache: true }); });
  const adapter = { ...fakeAdapter(srv), listen };
  const { app } = makeApp({ srv, adapter });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const states = [];
  app.status$(st => states.push(st.state));
  const off = app.watch('s1', 'items', () => {});
  await settle(30);
  assert.equal(states.at(-1), 'unknown');
  answer = true; srv.set('items', { id: 'z', text: 'Fake', updatedAt: Date.now() });
  assert.ok(await until(() => states.at(-1) === 'synced'), states.join());
  off();
});

test('a save the server refuses: onRefused hears it with its code; "archive" sets it aside, kept until Retry or Discard (0.8.2: the gate stays shut)', async () => {
  const srv = fakeServer();
  const refused = [];
  const { app } = makeApp({ srv, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }), options: {
    onRefused: (err, entry) => { refused.push({ code: err.code, kind: entry.kind, id: entry.record.id }); return 'archive'; },
  } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await app.save('item', 's1', { id: 'r1', text: 'Fake' });
  assert.ok(await until(() => refused.length === 1));
  assert.deepEqual(refused[0], { code: 'permission-denied', kind: 'item', id: 'r1' });
  assert.equal(await app.flush(500), false, 'set aside, kept by the engine: the gate stays shut until Retry or Discard (0.8.2)');
  const r = await app.signOut({ wait: 200 });
  assert.equal(r.ok, false); assert.equal(r.reason, 'refused');
  await app.queue.discard(app.queue.refused()[0].key);
  assert.equal(await app.flush(500), true, 'discarded: nothing unsent');
});

test('a refused save with no onRefused stays failed and keeps the sign-out shut (never dropped silently)', async () => {
  const srv = fakeServer();
  const { app } = makeApp({ srv, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }) });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await assert.rejects(app.save('item', 's1', { id: 'r1', text: 'Fake' }), /kept/, 'the caller hears of it');
  await settle(50);
  assert.equal(await app.flush(200), false);
  const r = await app.signOut();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'refused', 'refused, not unsent (0.8.1)');
});

test('sign-out refuses while a save is unsent and deletes nothing; once sent it wipes the device and signs out', async () => {
  const nav = fakeNav({ online: false });
  const extra = [];
  const { app, sdk, adapter, srv } = makeApp({ nav, options: { forget: { extra: async () => extra.push('extra') } } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let list = [];
  app.watch('s1', 'items', l => { list = l; });
  await app.save('item', 's1', { id: 'r1', text: 'Fake unsent' });
  const r1 = await app.signOut({ wait: 50 });
  assert.deepEqual({ ok: r1.ok, reason: r1.reason }, { ok: false, reason: 'unsent' });
  assert.ok(!sdk.calls.includes('signOut'), 'still signed in');
  assert.equal(adapter.cleared, 0);
  assert.ok(await until(() => list.some(d => d.id === 'r1')), 'the list still shows it (watching goes on)');
  nav.onLine = true; app.parts.queue.kick();
  assert.equal(await app.flush(2000), true);
  assert.equal(srv.get('items', 'r1').text, 'Fake unsent');
  const r2 = await app.signOut();
  assert.equal(r2.ok, true);
  assert.equal(r2.reload, true, 'the SDK cache was cleared: the page starts again');
  assert.equal(adapter.cleared, 1);
  assert.deepEqual(extra, ['extra']);
  assert.ok(sdk.calls.includes('signOut'));
  assert.equal(app.user(), null);
  assert.equal(app.parts.queue.entries().length, 0, 'the outbox forgot this account');
  const st = await app.parts.stores.openStore('s1');
  assert.equal((await st.load('items')).docs.length, 0, 'the device copy is gone');
});

test('sign-out stops when someone else signed in meanwhile (another tab): nothing deleted, listeners back', async () => {
  const sdkParts = fakeAuthSdk();
  const { app, srv, adapter } = makeApp({ sdkParts });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let list = [];
  app.watch('s1', 'items', l => { list = l; });
  const flush = app.parts.queue.flush;
  app.parts.queue.flush = async ms => { sdkParts.auth.currentUser = fakeUser({ uid: 'u2', email: 'other@example.test' }); return flush(ms); };
  const r = await app.signOut();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'changed' });
  assert.equal(adapter.cleared, 0);
  srv.set('items', { id: 'n', text: 'Fake new', updatedAt: Date.now() });
  assert.ok(await until(() => list.some(d => d.id === 'n')), 'watching again after the stop');
});

test('the emulator keeps its SDK cache (clearCache is skipped) and the page need not reload', async () => {
  const sdkParts = fakeAuthSdk();
  const srv = fakeServer(), adapter = fakeAdapter(srv);
  const { app } = makeApp({ srv, adapter, sdkParts, options: { sdk: async () => ({ A: sdkParts.A, F: {}, auth: sdkParts.auth, db: {}, emulator: true }) } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const r = await app.signOut();
  assert.equal(r.ok, true);
  assert.equal(r.reload, false);
  assert.equal(adapter.cleared, 0);
});

test('the outbox is named in the origin-wide list, so another app on this origin waits for its saves at sign-out', async () => {
  const storage = memStorage();
  const { app, name } = makeApp({ options: { storage } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const list = JSON.parse(storage.getItem('app-sync:outboxes') || '[]');
  assert.ok(list.some(x => x.name === name + '-outbox'), JSON.stringify(list));
});

test('escape hatch: commit replaces the adapter\'s write (an app\'s own transactions), the rest stays wired', async () => {
  const mine = [];
  const { app, srv, adapter } = makeApp({ options: { commit: async (scope, kind, record) => { mine.push([scope, kind, record.id]); return { at: Date.now() }; } } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await app.save('roster', 's1', { id: 'd1', body: 'Fake' });
  assert.equal(await app.flush(1000), true);
  assert.deepEqual(mine, [['s1', 'roster', 'd1']]);
  assert.equal(adapter.commits.length, 0);
  assert.equal(srv.get('items', 'd1'), undefined);
});

test('the parts are exported for anything the facade does not cover', async () => {
  const { app } = makeApp();
  for (const k of ['hub', 'queue', 'stores', 'adapter', 'watchdog']) assert.ok(app.parts[k], k);
  assert.equal(app.hub, app.parts.hub);
  assert.equal(app.queue, app.parts.queue);
});

test('watchdog: a listener stuck on the device copy while online is replaced, and the list comes back from the server', async () => {
  const srv = fakeServer();
  let stuck = true, now = Date.now();
  const listen = (scope, c, o, cb) => srv.listen(scope, c, o, s => cb(stuck ? { ...s, fromCache: true } : s));
  const adapter = { ...fakeAdapter(srv), listen };
  const { app } = makeApp({ srv, adapter, options: { now: () => now } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let list = [];
  app.watch('s1', 'items', l => { list = l; });
  await settle(20);
  now += 60000;
  assert.equal(app.nudge(), true, 'stuck on the device copy for a minute while online: listen again');
  stuck = false; srv.set('items', { id: 'w', text: 'Fake', updatedAt: Date.now() });
  assert.ok(await until(() => list.some(d => d.id === 'w')));
  assert.ok(app.relistens() >= 1);
});

// 0.6.1, found by the model test (test/model.test.mjs): the delete's bin entry came while the delete was still being
// sent, so the engine kept the record (unsent saves), and a delta listener never hears an old record go
test('a record deleted on this device leaves its list once the delete is done, though its bin entry came while it was sent', async () => {
  const S = 'fake-space', srv = fakeServer(), shared = sharedSdk({ srv });
  shared.meddle(`spaces/${S}/tasks/t1`, { id: 't1', text: 'Fake task', updatedAt: 1 });
  const backend = createFirestoreBackend({ sdk: shared.device().sdk, path: (s, c) => ['spaces', s, c],
    onCommit: ({ before, after, at }) => before && !after ? [{ path: ['spaces', S, 'bin', 'task:' + before.id], data: { id: 'task:' + before.id, kind: 'task', data: before, deletedAt: at } }] : [] });
  const user = fakeUser(), auth = { currentUser: user };
  const A = { onAuthStateChanged: (_a, cb) => { cb(user); return () => {}; } };
  const app = createApp({ name: uniq(), colls: ['tasks'], kinds: { task: 'tasks' }, path: (s, c) => ['spaces', s, c], sdk: async () => ({ A, F: {}, auth, db: {} }),
    adapter: { listen: srv.listen, fetchOne: srv.fetchOne, commit: (...a) => backend.commit(...a), clearCache: async () => {} },
    outbox: sharedOutbox(), storage: null, win: null, watchEvery: 0, nav: fakeNav(), queue: { delay: ms => settle(ms === 180 ? 5 : 10) }, hub: { grace: 0 } });
  await app.open(S);
  let view = [];
  app.watch(S, 'tasks', l => { view = l; });
  await settle(30);
  await app.hub.stopAll();   // opened again: the listener now reads only what changed since (not the old record)
  app.watch(S, 'tasks', l => { view = l; });
  await settle(30);
  assert.deepEqual(view.map(x => x.id), ['t1']);
  await app.save('task', S, { id: 't1', text: 'Fake task', _deleted: true }, { id: 't1', text: 'Fake task' });
  assert.equal(await app.flush(2000), true);
  assert.ok(await until(() => view.length === 0), 'the deleted record left the list');
  assert.equal(shared.docs.has(`spaces/${S}/tasks/t1`), false);
  await app.hub.stopAll();
});

// ---- 0.7.3: C2's gaps (an app's own unacknowledged writes, the status facts, one flush wait) ----

test('quiet: the watchdog never restarts the connection while the app says its own writes are not acknowledged (0.7.3)', async () => {
  const run = async quiet => {
    const srv = fakeServer();
    let now = Date.now();
    const listen = (scope, c, o, cb) => srv.listen(scope, c, o, s => cb({ ...s, fromCache: true }));
    const { app } = makeApp({ srv, adapter: { ...fakeAdapter(srv), listen }, options: { now: () => now, ...(quiet ? { quiet } : {}) } });
    await app.onUser(() => {}); await app.signIn(); await app.open('s1');
    app.watch('s1', 'items', () => {});
    await settle(20);
    now += 60000;
    assert.equal(app.nudge(), true, 'stuck on the device copy: listen again');
    await settle(20);
    now += ESCALATE_MS;
    return app.nudge();   // still stuck: restart the connection, only when quiet
  };
  assert.equal(await run(null), true, 'quiet (nothing unsent): the connection is restarted');
  assert.equal(await run(() => false), false, 'the app\'s own writes not acknowledged: no restart under them');
  assert.equal(await run(() => true), true);
});

test('facts: persisted, confirmed and when the server was last heard, reset at sign-out (0.7.3)', async () => {
  const nav = fakeNav({ persisted: false });
  let now = 1000;
  const { app, srv } = makeApp({ nav, options: { now: () => now } });
  await app.onUser(() => {});
  assert.deepEqual(app.facts(), { persisted: true, confirmed: false, heardAt: 0 });
  await app.signIn(); await app.open('s1');
  app.watch('s1', 'items', () => {});
  assert.ok(await until(() => app.facts().confirmed));
  assert.equal(app.facts().heardAt, 1000);
  assert.ok(await until(() => app.facts().persisted === false), 'the storage guard\'s answer');
  now = 5000; srv.set('items', { id: 'h1', text: 'Fake', updatedAt: Date.now() });
  assert.ok(await until(() => app.facts().heardAt === 5000), 'moves on each server answer');
  await app.signOut();
  assert.deepEqual([app.facts().confirmed, app.facts().heardAt], [false, 0]);
});

test('flush(ms) waits ms in all, not ms for the saves being stored and ms again for their sends (0.7.3)', async () => {
  const srv = fakeServer();
  const adapter = { ...fakeAdapter(srv), commit: () => new Promise(r => setTimeout(() => r({ at: 1 }), 1500)) };   // a slow answer
  const box = memOutbox(uniq() + '-outbox'), put = box.put.bind(box);
  let slow = false;
  box.put = async x => { if (slow) await settle(400); return put(x); };   // a slow outbox write (a busy phone)
  const { app } = makeApp({ srv, adapter, options: { outbox: box } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  slow = true;
  void app.save('item', 's1', { id: 'f1', text: 'Fake' }).catch(() => {});
  const t = Date.now();
  assert.equal(await app.flush(300), false);
  const took = Date.now() - t;
  assert.ok(took < 450, 'one wait: ' + took + ' ms');
  slow = false;
  assert.equal(await app.flush(4000), true);
});

// ---- 0.8.1: writes made outside the queue (G2, G3, G18) and the sign-in/sign-out hooks (G5, G6) ----

test('track: a write made outside the queue counts as unsent until it settles: status, idle, flush and the sign-out gate (0.8.1)', async () => {
  const extra = [];
  const { app, sdk, adapter } = makeApp({ options: { forget: { extra: async () => extra.push('extra') } } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let st = null;
  app.status$(s => { st = s; });
  assert.equal(app.unsentOutside(), 0);
  assert.equal(app.idle(), true);
  let done;
  const write = new Promise(r => { done = r; });
  const back = app.track(write, { kind: 'item', id: 'r1' });
  assert.equal(app.unsentOutside(), 1, 'a number at once, not a Promise');
  assert.equal(app.unsentOutside('item', 'r1'), 1);
  assert.equal(app.unsentOutside('item', 'other'), 0);
  assert.equal(app.idle(), false);
  assert.deepEqual([st.state, st.count], ['saving', 1]);
  assert.equal(await app.flush(30), false, 'the sign-out check stays shut');
  assert.equal(await app.outsideSettled(30), false);
  const r1 = await app.signOut({ wait: 30 });
  assert.deepEqual({ ok: r1.ok, reason: r1.reason }, { ok: false, reason: 'unsent' });
  assert.equal(adapter.cleared, 0); assert.deepEqual(extra, []); assert.ok(!sdk.calls.includes('signOut'));
  done('ok');
  assert.equal(await back, 'ok', 'track hands back the write\'s own answer');
  assert.equal(app.unsentOutside(), 0);
  assert.equal(app.idle(), true);
  assert.equal(await app.outsideSettled(30), true);
  assert.notEqual(st.state, 'saving');
  const r2 = await app.signOut();
  assert.equal(r2.ok, true);
});

test('track: a write that fails stops counting (the app has its answer); outsideSettled waits for it (0.8.1)', async () => {
  const { app } = makeApp();
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const bad = app.track(new Promise((_, no) => setTimeout(() => no(new Error('fake refused')), 20)));
  assert.equal(app.unsentOutside(), 1);
  const settled = app.outsideSettled(2000);
  await assert.rejects(bad, /fake refused/);
  assert.equal(await settled, true);
  assert.equal(app.unsentOutside(), 0);
});

test('outside: the app\'s own sync count (writes it knows of outside track) joins unsentOutside; quiet stays a deprecated alias (0.8.1)', async () => {
  let n = 2;
  const { app } = makeApp({ options: { outside: () => n } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  assert.equal(app.unsentOutside(), 2);
  assert.equal(await app.flush(30), false);
  n = 0;
  assert.equal(app.unsentOutside(), 0);
  assert.equal(await app.flush(200), true);
  const q = makeApp({ options: { quiet: () => false } });
  assert.equal(q.app.unsentOutside(), 1, 'quiet() false: one write not acknowledged');
});

test('track: the watchdog never restarts the connection under a tracked write (0.8.1)', async () => {
  const srv = fakeServer();
  let now = Date.now();
  const listen = (scope, c, o, cb) => srv.listen(scope, c, o, s => cb({ ...s, fromCache: true }));
  const { app } = makeApp({ srv, adapter: { ...fakeAdapter(srv), listen }, options: { now: () => now } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  app.watch('s1', 'items', () => {});
  void app.track(new Promise(() => {}));
  await settle(20);
  now += 60000;
  assert.equal(app.nudge(), true, 'listen again');
  await settle(20);
  now += ESCALATE_MS;
  assert.equal(app.nudge(), false, 'no restart under the tracked write');
});

test('heard: a read or listener the app runs itself confirms the status and feeds the watchdog (0.8.1)', async () => {
  let now = 1000;
  const { app } = makeApp({ options: { now: () => now } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  app.heard({ fromCache: true });
  assert.equal(app.facts().confirmed, false, 'the device copy is not the server');
  now = 3000;
  app.heard();
  assert.deepEqual([app.facts().confirmed, app.facts().heardAt], [true, 3000]);
  let st = null;
  app.status$(s => { st = s; });
  assert.equal(st.state, 'synced');
});

test('idle: false while a save is being stored or is in the queue (0.8.1)', async () => {
  const nav = fakeNav({ online: false });
  const { app } = makeApp({ nav });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const p = app.save('item', 's1', { id: 'i1', text: 'Fake' });
  assert.equal(app.idle(), false, 'being stored');
  await p;
  assert.equal(app.idle(), false, 'in the queue (offline)');
  nav.onLine = true; app.parts.queue.kick();
  assert.equal(await app.flush(2000), true);
  assert.equal(app.idle(), true);
});

test('signIn({ hint, popupOnly, redirectFirst }) per call: hint reaches login_hint (0.8.1)', async () => {
  const a = makeApp();
  let provider = null;
  const Popup = a.sdk.A.signInWithPopup;
  a.sdk.A.signInWithPopup = async (auth, p) => { provider = p; return Popup(auth, p); };
  await a.app.signIn({ hint: 'fake.person@example.test' });
  assert.deepEqual(provider.params, { prompt: 'select_account', login_hint: 'fake.person@example.test' });
  const b = makeApp({ sdkParts: fakeAuthSdk({ popupError: 'auth/popup-blocked' }) });
  await assert.rejects(b.app.signIn({ popupOnly: true }), e => e.code === 'auth/popup-blocked');
  assert.deepEqual(b.sdk.calls.filter(c => c !== 'redirect-result'), ['popup']);
  const c = makeApp();
  await c.app.signIn({ redirectFirst: true });
  assert.deepEqual(c.sdk.calls.filter(c => c !== 'redirect-result'), ['redirect']);
  const d = makeApp({ options: { redirectFirst: () => true } });
  await d.app.signIn({ redirectFirst: false });
  assert.deepEqual(d.sdk.calls.filter(c => c !== 'redirect-result'), ['popup']);
});

test('signOut reason \'refused\': a save the server refused waits for the user (0.8.1)', async () => {
  const srv = fakeServer();
  const { app } = makeApp({ srv, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }) });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await app.save('item', 's1', { id: 'r1', text: 'Fake' }).catch(() => {});
  assert.ok(await until(() => app.parts.queue.entries().some(x => x.state === 'failed')));
  const r = await app.signOut({ wait: 50 });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'refused' });
});

test('signOut({ force }): unsent saves and tracked writes are forgotten, the device is wiped (0.8.1)', async () => {
  const nav = fakeNav({ online: false });
  const { app, sdk } = makeApp({ nav });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await app.save('item', 's1', { id: 'r1', text: 'Fake unsent' });
  void app.track(new Promise(() => {}));
  const r = await app.signOut({ wait: 30, force: true });
  assert.equal(r.ok, true);
  assert.ok(sdk.calls.includes('signOut'));
  assert.equal(app.parts.queue.entries().length, 0);
  assert.equal(app.unsentOutside(), 0, 'forgotten with the device');
});

test('signOut({ force }) still stops when someone else signed in meanwhile (0.8.1)', async () => {
  const sdkParts = fakeAuthSdk();
  const { app, adapter } = makeApp({ sdkParts });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const flush = app.parts.queue.flush;
  app.parts.queue.flush = async ms => { sdkParts.auth.currentUser = fakeUser({ uid: 'u2', email: 'other@example.test' }); return flush(ms); };
  const r = await app.signOut({ force: true });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'changed' });
  assert.equal(adapter.cleared, 0);
});

test('signOut({ before }): runs after the listeners stop and before the wipe; a throw is named in failed (0.8.1)', async () => {
  const order = [];
  const { app } = makeApp({ options: { forget: { extra: async () => order.push('extra') } } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const stopAll = app.parts.hub.stopAll, wipe = app.parts.stores.wipeStores;
  app.parts.hub.stopAll = async () => { order.push('stopAll'); return stopAll(); };
  app.parts.stores.wipeStores = async k => { order.push('wipe'); return wipe(k); };
  const r = await app.signOut({ before: async () => { order.push('before'); throw new Error('fake'); } });
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['stopAll', 'before', 'wipe', 'extra']);
  assert.deepEqual(r.failed, ['before']);
  const b = makeApp();
  await b.app.onUser(() => {}); await b.app.signIn(); await b.app.open('s1');
  let ran = 0;
  void b.app.track(new Promise(() => {}));
  const r2 = await b.app.signOut({ wait: 30, before: async () => { ran++; } });
  assert.equal(r2.ok, false);
  assert.equal(ran, 0, 'never when the gate refuses');
});

test('one gate over every registered outbox: another app\'s unsent save on this origin keeps this app\'s lists (the drafts case) (0.8.1)', async () => {
  const storage = memStorage(), boxes = new Map();
  const box = name => { if (!boxes.has(name)) boxes.set(name, memOutbox(name)); return boxes.get(name); };
  const registry = createOutboxRegistry({ storage, open: name => box(name) });
  const nameA = uniq(), nameB = uniq();
  const sdkParts = fakeAuthSdk();
  const extra = [];
  const a = makeApp({ sdkParts, name: nameA, options: { storage, outbox: box(nameA + '-outbox'), queue: { registry }, forget: { extra: async () => extra.push('drafts deleted') } } });
  const b = makeApp({ sdkParts, name: nameB, nav: fakeNav({ online: false }), options: { storage, outbox: box(nameB + '-outbox'), queue: { registry } } });
  await a.app.onUser(() => {}); await b.app.onUser(() => {});
  await a.app.signIn(); await a.app.open('s1'); await b.app.open('s1');
  await b.app.save('item', 's1', { id: 'b1', text: 'Fake unsent in the other app' });
  const r = await a.app.signOut({ wait: 50 });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'unsent' });
  assert.deepEqual(extra, [], 'the app\'s own lists are kept');
});

test('flush: a save made while outside writes settle keeps the gate shut (review, 0.8.1)', async () => {
  const nav = fakeNav({ online: false });
  const { app } = makeApp({ nav });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  void app.track(new Promise(r => setTimeout(r, 40)));
  setTimeout(() => { void app.save('item', 's1', { id: 'late', text: 'Fake' }); }, 10);
  assert.equal(await app.flush(300), false);
  const r = await app.signOut({ wait: 300 });
  assert.equal(r.ok, false);
});

test('signOut({ before }): someone else signed in during before stops the wipe; signed out (none) goes on (review, 0.8.1)', async () => {
  const sdkParts = fakeAuthSdk();
  const { app, adapter } = makeApp({ sdkParts });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const r = await app.signOut({ force: true, before: async () => { sdkParts.auth.currentUser = fakeUser({ uid: 'u2', email: 'other@example.test' }); } });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'changed' });
  assert.equal(adapter.cleared, 0);
  const b = makeApp();
  await b.app.onUser(() => {}); await b.app.signIn(); await b.app.open('s1');
  const r2 = await b.app.signOut({ before: async () => { await b.sdk.A.signOut(b.sdk.auth); } });
  assert.equal(r2.ok, true, 'the app\'s own Auth sign-out in before');
});

test('a tracked write that settles applies deletes held for its record (review, 0.8.1)', async () => {
  const { app } = makeApp();
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  let settled = 0;
  const s = app.hub.settle;
  app.hub.settle = sc => { settled++; return s(sc); };
  await app.track(Promise.resolve(), { kind: 'item', id: 'r1' });
  await settle(5);
  assert.ok(settled > 0);
});

// 0.8.2: refused saves after a reload, the watch change info, the device copy read
test('a refused save found after a reload: onRefused hears its code from the job; app.queue.refused() keeps it set aside (0.8.2)', async () => {
  const srv = fakeServer(), name = uniq(), records = new Map();
  const one = makeApp({ srv, name, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }), options: { outbox: memOutbox(name + '-outbox', 'default', records) } });
  await one.app.onUser(() => {}); await one.app.signIn(); await one.app.open('s1');
  await assert.rejects(one.app.save('item', 's1', { id: 'r1', text: 'Fake' }), /kept/);
  const heard = [];
  const two = makeApp({ srv, name, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }), options: { outbox: memOutbox(name + '-outbox', 'default', records),
    onRefused: (err, entry) => { heard.push([err.code, entry.record.id]); return 'archive'; } } });
  await two.app.onUser(() => {}); await two.app.signIn(); await two.app.open('s1');
  assert.ok(await until(() => heard.length === 1));
  assert.deepEqual(heard[0], ['permission-denied', 'r1'], 'the code came from the stored job, not this page\'s memory');
  assert.ok(await until(() => two.app.queue.refused().length === 1 && two.app.queue.refused()[0].state === 'archived'));
  assert.equal(two.app.queue.refused()[0].code, 'permission-denied');
  assert.equal(await two.app.flush(300), false, 'set aside: the gate stays shut until discarded');
});

test('watch meta says what changed and what was removed; copyOf and lastSeen read the last delivered copy (0.8.2)', async () => {
  const { app, srv } = makeApp();
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  srv.set('items', { id: 'a', text: 'Fake A', updatedAt: 5, serverAt: 5, _saves: ['k'] });
  srv.set('items', { id: 'b', text: 'Fake B', updatedAt: 6, serverAt: 6, _saves: ['k'] });
  const calls = [];
  const off = app.watch('s1', 'items', (list, meta) => calls.push({ ids: list.map(d => d.id).sort(), changed: [...meta.changed].sort(), removed: [...meta.removed].sort() }));
  assert.ok(await until(() => calls.some(c => c.ids.length === 2)));
  const first = calls.find(c => c.ids.length === 2);
  assert.ok(first.changed.includes('a') && first.changed.includes('b'), 'first delivery: everything is new');
  assert.equal(app.copyOf('item', 'a').text, 'Fake A');
  assert.equal(app.copyOf('item', 'zz'), null);
  assert.deepEqual(app.lastSeen('item', 'a'), { stamp: 5, signature: recordSignature({ id: 'a', text: 'Fake A' }) });
  calls.length = 0;
  srv.set('items', { id: 'a', text: 'Fake A2', updatedAt: 7, serverAt: 7, _saves: ['k'] });
  assert.ok(await until(() => calls.some(c => c.changed.includes('a'))));
  const c2 = calls.find(c => c.changed.includes('a'));
  assert.deepEqual(c2.changed, ['a'], 'only a changed'); assert.deepEqual(c2.removed, []);
  assert.equal(app.copyOf('item', 'a').text, 'Fake A2');
  calls.length = 0;
  await app.save('item', 's1', { id: 'b', _deleted: true }, { id: 'b', text: 'Fake B' });
  assert.ok(await until(() => calls.some(c => c.removed.includes('b'))));
  assert.deepEqual(calls.find(c => c.removed.includes('b')).changed, []);
  assert.equal(app.copyOf('item', 'b'), null);
  // a copy the device sent itself: lastSent (queue) and lastSeen agree once the listener hears it back
  await app.save('item', 's1', { id: 'c', text: 'Fake C' });
  assert.ok(await until(() => app.lastSeen('item', 'c') !== null));
  assert.equal(app.lastSeen('item', 'c').signature, app.queue.lastSent('item', 'c').signature);
  off();
});

test('a refused save set aside in another registered outbox keeps this app\'s sign-out shut (review, 0.8.2)', async () => {
  const storage = memStorage(), srv = fakeServer(), boxes = new Map();
  const box = name => { if (!boxes.has(name)) boxes.set(name, memOutbox(name)); return boxes.get(name); };
  const registry = createOutboxRegistry({ storage, open: name => box(name) });
  const nameA = uniq(), nameB = uniq(), sdkParts = fakeAuthSdk();
  const one = makeApp({ sdkParts, srv, name: nameA, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }), options: { storage, outbox: box(nameA + '-outbox'), queue: { registry }, onRefused: () => 'archive' } });
  const two = makeApp({ sdkParts, srv, name: nameB, options: { storage, outbox: box(nameB + '-outbox'), queue: { registry } } });
  await one.app.onUser(() => {}); await two.app.onUser(() => {});
  await one.app.signIn(); await one.app.open('s1'); await two.app.open('s1');
  await one.app.save('item', 's1', { id: 'r1', text: 'Fake' }).catch(() => {});   // (set aside at once: no throw)
  assert.ok(await until(() => one.app.queue.refused()[0]?.state === 'archived'));
  assert.equal(await two.app.flush(300), false);
});

// ---- 0.8.3: watchDoc, reconnect, wake, the claims watch ----

// one document's listener, as the adapter's listenDoc hands it: the test sends its snapshots
function docFeed() {
  const feed = { opened: [], live: 0 };
  feed.listenDoc = (segments, onSnap, onError) => {
    const l = { segments, onSnap, onError, on: true };
    feed.opened.push(l); feed.live++;
    return () => { if (l.on) { l.on = false; feed.live--; } };
  };
  const last = () => feed.opened.filter(l => l.on).at(-1);
  feed.send = (doc, { fromCache = false, hasPendingWrites = false } = {}) => last()?.onSnap({ doc, fromCache, hasPendingWrites });
  feed.fail = e => last()?.onError(e);
  return feed;
}

test('watchDoc: "gone" only when the server says so or the listener fails, never from the device copy (0.8.3)', async () => {
  const srv = fakeServer(), feed = docFeed();
  const { app } = makeApp({ srv, adapter: { ...fakeAdapter(srv), listenDoc: feed.listenDoc } });
  const seen = [], errors = [];
  const off = app.watchDoc(['households', 'h1'], (d, m) => seen.push([d, m.fromCache]), e => errors.push(e.code));
  await settle();
  assert.deepEqual(feed.opened[0].segments, ['households', 'h1']);
  feed.send(null, { fromCache: true });
  assert.deepEqual(seen, [], 'nothing on the device: not gone');
  assert.equal(app.facts().confirmed, false);
  feed.send({ id: 'h1', name: 'Fake home' });
  feed.send({ id: 'h1', name: 'Fake home' });
  assert.deepEqual(seen, [[{ id: 'h1', name: 'Fake home' }, false]], 'handed once while the same');
  assert.equal(app.facts().confirmed, true, 'the server answered: it feeds the facts');
  feed.send(null);
  feed.send(null);
  assert.deepEqual(seen.slice(1), [[null, false]], 'gone once, when the server said so');
  feed.send({ id: 'h1', name: 'Fake home 2' });
  assert.equal(seen.length, 3, 'back again: handed again');
  feed.fail(Object.assign(new Error('denied'), { code: 'permission-denied' }));
  assert.deepEqual(seen.at(-1)[0], null, 'a listener that fails: gone');
  assert.deepEqual(errors, ['permission-denied']);
  off();
  assert.equal(feed.live, 0);
  // the path also as a string
  app.watchDoc('households/h2', () => {});
  await settle();
  assert.deepEqual(feed.opened.at(-1).segments, ['households', 'h2']);
});

test('watchDoc: the watchdog restarts a doc watch stuck on the device copy; sign-out stops it (0.8.3)', async () => {
  const srv = fakeServer(), feed = docFeed();
  let now = Date.now();
  const { app } = makeApp({ srv, adapter: { ...fakeAdapter(srv), listenDoc: feed.listenDoc }, options: { now: () => now } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  const seen = [];
  app.watchDoc(['households', 'h1'], d => seen.push(d));
  await settle();
  feed.send({ id: 'h1', name: 'Fake home' }, { fromCache: true });
  now += 60000;
  assert.equal(app.nudge(), true, 'a doc watch alone is watched: stuck on the device copy, listen again');
  await settle(20);
  assert.equal(feed.opened.length, 2, 'listening again');
  assert.equal(feed.live, 1, 'the old listener stopped');
  feed.send({ id: 'h1', name: 'Fake home' });
  assert.equal(seen.length, 1, 'the same copy is not handed again after the restart');
  const r = await app.signOut();
  assert.equal(r.ok, true);
  assert.equal(feed.live, 0, 'sign-out stops it');
});

test('reconnect: restarts the connection and resolves after it; never under an unsent outside write (0.8.3)', async () => {
  const calls = [];
  const F = { disableNetwork: async () => { calls.push('off'); }, enableNetwork: async () => { calls.push('on'); } };
  const sdk = fakeAuthSdk();
  const { app, nav } = makeApp({ sdkParts: sdk, options: { sdk: async () => ({ A: sdk.A, F, auth: sdk.auth, db: {} }) } });
  assert.equal(await app.reconnect({ why: 'Sync now' }), true);
  assert.deepEqual(calls, ['off', 'on'], 'resolved after the network was off and on again');
  let done; app.track(new Promise(r => { done = r; }));
  assert.equal(await app.reconnect(), false, 'an outside write may be sent twice by a restart: not now');
  assert.equal(calls.length, 2);
  done(); await settle();
  nav.onLine = false;
  assert.equal(await app.reconnect(), false, 'offline: nothing to restart');
  nav.onLine = true;
  const both = await Promise.all([app.reconnect(), app.reconnect()]);
  assert.deepEqual(both, [true, true]);
  assert.equal(calls.length, 4, 'one restart at a time: the second call waits for the first');
  const { app: bare } = makeApp();
  assert.equal(await bare.reconnect(), false, 'an SDK without the network switch: false');
});

// a browser window: its listeners, a page that can be hidden
function fakeWin() {
  const on = {}, doc = { visibilityState: 'visible', addEventListener: (t, f) => (on[t] ||= []).push(f), removeEventListener() {} };
  return { on, document: doc, addEventListener: (t, f) => (on[t] ||= []).push(f), removeEventListener() {}, fire: t => (on[t] || []).forEach(f => f()) };
}

test('wake: true nudges the watchdog when the page comes back (online, pageshow, visible); off by default (0.8.3)', async () => {
  const run = async wake => {
    const srv = fakeServer(), win = fakeWin();
    let now = Date.now();
    const { app } = makeApp({ srv, options: { now: () => now, win, ...(wake ? { wake } : {}) } });
    await app.onUser(() => {}); await app.signIn(); await app.open('s1');
    app.watch('s1', 'items', () => {});
    await settle(20);
    now += 20000;   // nothing heard from the server for a while
    win.fire('pageshow');
    win.document.visibilityState = 'hidden'; now += 40000; win.fire('visibilitychange');
    const hidden = app.relistens();
    win.document.visibilityState = 'visible'; win.fire('visibilitychange');
    return [hidden, app.relistens()];
  };
  assert.deepEqual(await run(false), [0, 0], 'off by default: the app wires its own');
  const [hidden, visible] = await run(true);
  assert.equal(hidden, 1, 'pageshow after a quiet spell: listen again; a hidden page is not a wake');
  assert.equal(visible, 2, 'visible again after the throttle: listen again');
});

test('claims.watch: the role doc is listened to, the claims refreshed when it moves, onClaims told the status (0.8.3)', async () => {
  const user = fakeUser({ claims: { v: 1, g: { _: 'viewer' } } });
  const srv = fakeServer(), feed = docFeed(), posts = [], told = [];
  let status = 200;
  const fetch = async (url, o) => { posts.push(url); if (status === 200) user.claims = { v: 2, g: { _: 'admin' } }; return { ok: status === 200, status }; };
  const { app } = makeApp({ srv, sdkParts: fakeAuthSdk({ user }), adapter: { ...fakeAdapter(srv), listenDoc: feed.listenDoc },
    options: { fetch, claims: { url: '/api/claims', watch: true, doc: u => ['members', u.uid], onClaims: x => told.push(x) } } });
  await app.onUser(() => {}); await app.signIn();
  await settle(10);
  assert.deepEqual(feed.opened.map(l => l.segments), [['members', 'u1']], 'the signed-in account\'s role doc');
  assert.deepEqual(posts, [], 'nothing asked before the role doc is heard');
  feed.send(null, { fromCache: true });
  await settle(10);
  assert.deepEqual(posts, [], 'not on the device: not known yet');
  feed.send({ id: 'u1', role: 'viewer', v: 1 });
  await settle(10);
  assert.deepEqual(posts, [], 'the token is up to date');
  assert.deepEqual(told.map(x => [x.asked, x.status]), [[false, 0]]);
  feed.send({ id: 'u1', role: 'admin', v: 2 });
  assert.ok(await until(() => told.length === 2));
  assert.deepEqual(posts, ['/api/claims'], 'v moved: new claims asked');
  assert.equal(user.refreshed, 1, 'and the token refreshed');
  assert.deepEqual(told.map(x => [x.asked, x.status]).at(-1), [true, 200]);
  status = 503;
  feed.send({ id: 'u1', role: 'member', v: 3 });
  assert.ok(await until(() => told.length === 3));
  assert.deepEqual(told.at(-1).status, 503, 'the HTTP status reaches the app (e.g. 503: not set up)');
  const r = await app.signOut();
  assert.equal(r.ok, true);
  assert.equal(feed.live, 0, 'sign-out stops the role doc listener');
});
