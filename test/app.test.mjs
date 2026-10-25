// Run with: node --test test/app.test.mjs
// createApp (app.js), the one call that wires the safe path: sign-in, the storage guard, claims refresh, the device
// copy, the outbox and queue, the watchdog, the status and the sign-out wipe. Here on a fake auth SDK and a fake
// adapter over the fake server (the real adapter: test/firestore.emulator.mjs). Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { checkWrite } from '../src/conflict.js';
import { fakeServer } from './fake-server.mjs';
import { createFirestoreBackend } from '../src/firestore.js';
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

test('a save the server refuses: onRefused hears it with its code; "archive" sets it aside so sign-out is not blocked for good', async () => {
  const srv = fakeServer();
  const refused = [];
  const { app } = makeApp({ srv, adapter: fakeAdapter(srv, { refuse: 'permission-denied' }), options: {
    onRefused: (err, entry) => { refused.push({ code: err.code, kind: entry.kind, id: entry.record.id }); return 'archive'; },
  } });
  await app.onUser(() => {}); await app.signIn(); await app.open('s1');
  await app.save('item', 's1', { id: 'r1', text: 'Fake' });
  assert.ok(await until(() => refused.length === 1));
  assert.deepEqual(refused[0], { code: 'permission-denied', kind: 'item', id: 'r1' });
  assert.equal(await app.flush(500), true, 'set aside: nothing unsent');
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
  assert.equal(r.reason, 'unsent');
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
