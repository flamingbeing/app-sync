// Run with: node --test test/modules.test.mjs
// The sync module's own (the createApp tests run on the modules too: test/factory.mjs; auth.test, runner.test): sign-out keeps the account's data, a switch wipes it, the reload owed after a wipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { auth } from '../auth.js';
import { sync } from '../sync.js';
import { fakeServer } from './fake-server.mjs';
const { settle, until, fakeUser, fakeAdapter, fakeNav, memOutbox, memStorage } = await import('./app.test.mjs');

let n = 0;
// an auth SDK whose next popup signs in `next` (another account: a switch)
function switchSdk() {
  const calls = [];
  const auth = { currentUser: null, cbs: new Set(), set(u) { this.currentUser = u; for (const cb of [...this.cbs]) cb(u); } };
  const t = { calls, auth, next: fakeUser() };
  t.A = {
    GoogleAuthProvider: class { setCustomParameters() {} },
    async signInWithPopup(a) { calls.push('popup'); a.set(t.next); },
    async signInWithRedirect() { calls.push('redirect'); },
    async getRedirectResult() { return null; },
    onAuthStateChanged(a, cb) { a.cbs.add(cb); cb(a.currentUser); return () => a.cbs.delete(cb); },
    async signOut(a) { calls.push('signOut'); a.set(null); },
  };
  return t;
}
async function modulesApp({ storage = memStorage(), sdk = switchSdk(), srv = fakeServer(), nav = fakeNav(), name = 'modtest' + (++n) + '-' + Date.now(), outbox = null, adapter = fakeAdapter(srv), F = {}, db = {}, more = {} } = {}) {
  const reloads = [];
  const app = await createApp({
    config: { name, storage, sdk: async () => ({ A: sdk.A, F, auth: sdk.auth, db }) },
    modules: [auth({ nav, win: null }), sync({ colls: ['items'], path: (s, c) => ['spaces', s, c], kinds: { item: 'items' },
      scope: u => 'sp-' + u.uid, adapter, nav, win: null, outbox: outbox || memOutbox(name + '-outbox'), watchEvery: 0,
      reload: () => reloads.push('reload'), ...more })],
  }).ready;
  return { app, sdk, srv, adapter, nav, storage, reloads, name };
}

test('sync module: sign-out keeps the device copy, the outbox and the watch; the same account sends its unsent save after', async () => {
  const t = await modulesApp({ nav: fakeNav({ online: false }) });
  const { app } = t;
  await app.auth.signIn();
  let list = [];
  app.sync.watch('sp-u1', 'items', l => { list = l; });
  await app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake unsent' });
  assert.ok(await until(() => list.some(d => d.id === 'r1')));
  assert.deepEqual(await app.auth.signOut(), { ok: true, reason: '' });
  await settle(10);
  let st = null; app.status$(x => { st = x; })();
  assert.equal(st.unsent, 1, 'still unsent, still counted (a switch waits for it)');
  assert.equal(app.sync.queue.entries().length, 1, 'the outbox kept it');
  assert.equal(t.adapter.cleared, 0, 'nothing wiped');
  assert.equal(t.srv.get('items', 'r1'), undefined, 'nothing sent while signed out');
  t.nav.onLine = true;
  assert.deepEqual(await app.auth.signIn(), { ok: true, reason: '' });
  assert.ok(await until(() => t.srv.get('items', 'r1')?.text === 'Fake unsent'), 'sent once the same account is back');
  assert.ok(list.some(d => d.id === 'r1'), 'the list still has it');
  assert.deepEqual(t.reloads, [], 'no reload: nothing was wiped');
  await app.stop();
});

test('sync module: another account is a switch: the last one\'s device copy and outbox are wiped, the reload is owed to its sign-in', async () => {
  const t = await modulesApp();
  const { app } = t;
  await app.auth.signIn();
  await app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake first' });
  assert.equal(await app.sync.flush(2000), true);
  await app.auth.signOut();
  t.sdk.next = fakeUser({ uid: 'u2', email: 'other.fake@example.test' });
  const r = await app.auth.signIn();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: true, reason: '' });
  assert.equal(t.adapter.cleared, 1, 'the SDK cache cleared');
  assert.deepEqual(t.reloads, ['reload'], 'the SDK can\'t be used again: the page starts again at the new sign-in');
  assert.equal(app.sync.queue.entries().length, 0);
  const st = await app.sync.parts.stores.openStore('sp-u1');
  assert.equal((await st.load('items')).docs.length, 0, 'the last account\'s device copy is gone');
  assert.equal(t.storage.getItem(t.name + ':sync/scope'), null, 'no scope last opened');
  await app.stop();
});

test('sync module: signed out after a reload, the stored unsent saves still refuse a switch; forget() wipes and reloads', async () => {
  const name = 'modtest-reload-' + Date.now(), storage = memStorage(), records = new Map(), srv = fakeServer();
  const outbox = () => memOutbox(name + '-outbox', 'default', records);
  const a = await modulesApp({ name, storage, srv, nav: fakeNav({ online: false }), outbox: outbox() });
  await a.app.auth.signIn();
  await a.app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake unsent' });
  await a.app.auth.signOut();
  await a.app.stop();
  const b = await modulesApp({ name, storage, srv, outbox: outbox() });   // (the page again, signed out)
  await settle(10);
  b.sdk.next = fakeUser({ uid: 'u2', email: 'other.fake@example.test' });
  const r = await b.app.auth.signIn();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'unsent' }, 'u1\'s stored save refuses the switch');
  assert.equal(b.adapter.cleared, 0);
  const f = await b.app.auth.forget({ force: true });
  assert.equal(f.ok, true);
  assert.equal(records.size, 0, 'the outbox forgot u1');
  assert.ok(await until(() => b.reloads.length === 1), 'the cache was cleared: the page starts again');
  await b.app.stop();
});

test('sync module: another tab\'s unsent save in the shared outbox refuses the switch (the wipe would delete it) (review)', async () => {
  const name = 'modtest-tabs-' + Date.now(), records = new Map(), srv = fakeServer();
  const outbox = () => memOutbox(name + '-outbox', 'default', records);
  const b = await modulesApp({ name, srv, nav: fakeNav({ online: false }), outbox: outbox() });
  await b.app.auth.signIn();
  const a = await modulesApp({ name, srv, nav: fakeNav({ online: false }), outbox: outbox() });   // (another tab)
  await a.app.auth.signIn();
  await a.app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake from the other tab' });
  assert.equal(records.size, 1);
  b.sdk.next = fakeUser({ uid: 'u2', email: 'other.fake@example.test' });
  const r = await b.app.auth.signIn();
  assert.equal(r.ok, false, 'refused');
  assert.equal(records.size, 1, 'the other tab\'s save is still there');
  await a.app.stop(); await b.app.stop();
});

test('sync module: a save counts as unsent in the app\'s status from the moment it is made (review)', async () => {
  const t = await modulesApp({ nav: fakeNav({ online: false }) });
  await t.app.auth.signIn();
  let st = null; const off = t.app.status$(x => { st = x; });
  const p = t.app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake' });
  assert.equal(st.unsent, 1, 'before it is stored');
  await p; off();
  await t.app.stop();
});

test('sync module: saveMany (1.1.0) saves each record as save does, through the outbox, one result per record', async () => {
  const t = await modulesApp();
  const { app } = t;
  await app.auth.signIn();
  t.srv.set('items', { id: 'r1', text: 'Fake old', updatedAt: 1 });
  let list = [];
  app.sync.watch('sp-u1', 'items', l => { list = l; });
  assert.ok(await until(() => list.length === 1));
  const results = await app.sync.saveMany('item', 'sp-u1', [{ id: 'r1', text: 'Fake new' }, { id: 'r2', text: 'Fake added' }]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled']);
  assert.ok(await app.sync.flush(2000));
  assert.equal(t.srv.get('items', 'r1').text, 'Fake new', 'made on the copy this device shows: no conflict');
  assert.equal(t.srv.get('items', 'r2').text, 'Fake added');
  assert.equal(t.adapter.commits.length, 2, 'one job each, sent by the queue');
  const other = await app.sync.saveMany('item', 'sp-other', [{ id: 'r3', text: 'Fake' }]);
  assert.equal(other[0].status, 'rejected', 'a scope not open is refused, as save refuses it');
  await app.stop();
});

test('sync module: watch(scope, coll, cb, { query, limit }) (1.1.0) narrows what the callback gets, never the device copy', async () => {
  const t = await modulesApp();
  const { app } = t;
  await app.auth.signIn();
  for (const [id, tag] of [['r1', 'a'], ['r2', 'b'], ['r3', 'a'], ['r4', 'a']]) t.srv.set('items', { id, tag, updatedAt: 1 });
  let view = [], viewMeta = null, all = [];
  app.sync.watch('sp-u1', 'items', (l, m) => { view = l; viewMeta = m; }, { query: { tag: 'a' }, limit: 2 });
  app.sync.watch('sp-u1', 'items', l => { all = l; });
  assert.ok(await until(() => all.length === 4 && view.length === 2));
  assert.ok(view.every(d => d.tag === 'a'));
  assert.deepEqual(viewMeta.changed.sort(), view.map(d => d.id).sort(), 'changed names only what is in view');
  const leaving = view[0].id;
  t.srv.set('items', { id: leaving, tag: 'b', updatedAt: 2 });
  assert.ok(await until(() => !view.some(d => d.id === leaving)));
  assert.equal(view.length, 2, 'the next one matching takes its place');
  assert.ok(viewMeta.removed.includes(leaving), 'one leaving the view is removed from it');
  assert.equal(all.length, 4, 'the other watch still has every record');
  await app.stop();
});

test('sync module: facts().inStepAt (1.2.0) is the last time this device was in step: heard, nothing waiting', async () => {
  const t = await modulesApp();
  const { app } = t;
  assert.equal(app.sync.facts().inStepAt, 0, 'never in step before the server answered');
  await app.auth.signIn();
  let list = [];
  app.sync.watch('sp-u1', 'items', l => { list = l; });
  t.srv.set('items', { id: 'r1', text: 'Fake', updatedAt: 1 });
  assert.ok(await until(() => list.length === 1 && app.sync.facts().confirmed));
  const before = app.sync.facts().inStepAt;
  assert.ok(before > 0 && before <= Date.now(), 'in step now');
  t.nav.onLine = false;
  await app.sync.save('item', 'sp-u1', { id: 'r2', text: 'Fake offline' });
  const kept = app.sync.facts().inStepAt;
  assert.ok(kept >= before);
  await settle(20);
  assert.equal(app.sync.facts().inStepAt, kept, 'a save waiting: not in step, the time stays');
  t.nav.onLine = true;
  assert.ok(await app.sync.flush(2000));
  assert.ok(app.sync.facts().inStepAt > kept, 'in step again once the save is sent');
  await app.stop();
});

test('sync module: reopen (1.2.0) swaps the SDK instance after a wipe cleared its cache, without a reload', async () => {
  const net = [], F = { async disableNetwork(db) { net.push(db.name); }, async enableNetwork() {} };
  const opened = [];
  let shared = null;
  const reopen = async ({ memory, sdk }) => { opened.push(memory); shared = sdk; return { name: 'reopened' }; };
  const t = await modulesApp({ F, db: { name: 'first' }, more: { reopen } });
  const { app } = t;
  await app.auth.signIn();
  await app.auth.signOut();
  t.sdk.next = fakeUser({ uid: 'u2', email: 'other.fake@example.test' });
  assert.equal((await app.auth.signIn()).ok, true);
  assert.equal(t.adapter.cleared, 1);
  assert.deepEqual(opened, [false], 'the cache was cleared: a persistent one again');
  assert.deepEqual(t.reloads, [], 'no reload');
  assert.equal(await app.sync.reconnect(), true);
  assert.deepEqual(net, ['reopened'], 'the sync module uses the new instance');
  assert.equal(shared.db.name, 'reopened', 'and so does every module on the shared SDK (the auth module\'s claims watch)');
  await app.sync.save('item', 'sp-u2', { id: 'r1', text: 'Fake after' });
  assert.ok(await app.sync.flush(2000), 'and sends on it');
  await app.stop();
});

test('sync module: reopen falls back to a memory-only cache when the old cache could not be cleared or reopened', async () => {
  const srv = fakeServer(), adapter = { ...fakeAdapter(srv), async clearCache() { throw Object.assign(new Error('another tab'), { code: 'deadline-exceeded' }); } };
  const opened = [];
  const t = await modulesApp({ srv, adapter, more: { reopen: async ({ memory }) => { opened.push(memory); return {}; } } });
  await t.app.auth.signIn();
  await t.app.auth.forget();
  assert.ok(await until(() => opened.length === 1));
  assert.deepEqual(opened, [true], 'not cleared (another tab holds it): memory only, never the old account\'s cache');
  assert.deepEqual(t.reloads, []);
  await t.app.stop();
  const tries = [];
  const u = await modulesApp({ more: { reopen: async ({ memory }) => { tries.push(memory); if (!memory) throw new Error('fake: cache in use'); return {}; } } });
  await u.app.auth.signIn();
  await u.app.auth.forget();
  assert.ok(await until(() => tries.length === 2));
  assert.deepEqual(tries, [false, true], 'a persistent cache that will not open: memory only');
  assert.deepEqual(u.reloads, []);
  const w = await modulesApp({ more: { reopen: async () => { throw new Error('fake: no instance'); } } });
  await w.app.auth.signIn();
  await w.app.auth.forget();
  assert.ok(await until(() => w.reloads.length === 1), 'no new instance at all: the page reloads, as without reopen');
  await w.app.stop();
});

test('sync module: watch(scope, coll, cb, { listen }) (1.2.0) runs on the app\'s own listener, keeping the device copy, the status and the watchdog', async () => {
  const srv = fakeServer(), base = fakeAdapter(srv), heard = [];
  const adapter = { ...base, listen: (s, c, plan, onSnap, onError) => { if (c === 'items') heard.push('engine:' + c); return srv.listen(s, c, plan, onSnap, onError); } };
  const t = await modulesApp({ srv, adapter });
  const { app } = t;
  await app.auth.signIn();
  srv.set('items', { id: 'r1', text: 'Fake', updatedAt: 1 });
  const mine = (s, c, plan, onSnap, onError) => { heard.push('app:' + c); return srv.listen(s, c, plan, onSnap, onError); };
  let list = [];
  app.sync.watch('sp-u1', 'items', l => { list = l; }, { listen: mine });
  assert.ok(await until(() => list.length === 1));
  assert.deepEqual(heard, ['app:items'], 'the app\'s listener, not the adapter\'s');
  assert.equal(app.sync.facts().confirmed, true, 'what it hears feeds facts and the status');
  let other = [];
  app.sync.watch('sp-u1', 'items', l => { other = l; });
  assert.ok(await until(() => other.length === 1), 'a plain watch of the same collection shares it');
  assert.throws(() => app.sync.watch('sp-u1', 'items', () => {}, { listen: (...a) => srv.listen(...a) }), /already listened to/);
  const st = await app.sync.parts.stores.openStore('sp-u1');
  assert.equal((await st.load('items')).docs.length, 1, 'kept in the device copy');
  await app.auth.signOut();
  await app.sync.parts.hub.stopAll();
  heard.length = 0;
  await app.auth.signIn();
  assert.ok(await until(() => heard.length > 0));
  assert.deepEqual(heard, ['app:items'], 'listening again (sign-in, the watchdog) uses the app\'s listener again');
  await app.stop();
});

test('sync module: kinds[kind] = { coll, path } (1.2.0) saves that kind to its own path, through the same queue', async () => {
  const srv = fakeServer(), base = fakeAdapter(srv), sent = [];
  const adapter = { ...base, async commit(scope, coll, record, b, extra) { sent.push({ scope, coll, id: record.id, path: extra?.path }); return base.commit(scope, coll, record, b); } };
  const nav = fakeNav({ online: false });
  const t = await modulesApp({ srv, adapter, nav, more: { kinds: { item: 'items', answer: { coll: 'answers', path: (s, c, r) => ['links', r.token, c] } } } });
  const { app } = t;
  await app.auth.signIn();
  await app.sync.save('answer', 'sp-u1', { id: 'a1', token: 'fake-token', text: 'Fake answer' });
  assert.equal(app.sync.queue.pending(), 1, 'waits in the outbox like any save');
  nav.onLine = true;
  assert.ok(await app.sync.flush(2000));
  assert.deepEqual(sent, [{ scope: 'sp-u1', coll: 'answers', id: 'a1', path: ['links', 'fake-token', 'answers'] }]);
  await app.sync.save('item', 'sp-u1', { id: 'r1', text: 'Fake' });
  assert.ok(await app.sync.flush(2000));
  assert.equal(sent[1].path, undefined, 'a plain kind keeps the scope\'s path');
  assert.throws(() => sync({ colls: ['items'], path: () => [], kinds: { bad: { coll: 'x' } } }), /path/);
  await app.stop();
});

// ---- 1.3.0: public read (SHAPES.md 7): sync({ public }) collections read in public:* scopes with no sign-in ----

const PUBLIC = { colls: ['items', 'news'], public: ['news'] };

test('public read: a public:* watch runs with no sign-in, and on through sign-in and sign-out; it is listened again at sign-in', async () => {
  const t = await modulesApp({ more: PUBLIC });
  const { app, srv } = t;
  srv.set('news', { id: 'n1', text: 'Fake news one', updatedAt: 1 });
  let news = [];
  app.sync.watch('public:all', 'news', l => { news = l; });
  assert.ok(await until(() => news.some(d => d.id === 'n1')), 'read with no account');
  const before = srv.listens;
  await app.auth.signIn();
  assert.ok(await until(() => srv.listens > before), 're-scoped: listened again under the account');
  let items = [];
  app.sync.watch('sp-u1', 'items', l => { items = l; });
  await app.auth.signOut();
  await settle(10);
  srv.set('news', { id: 'n2', text: 'Fake news two', updatedAt: 2 });
  srv.set('items', { id: 'i1', text: 'Fake item', updatedAt: 2 });
  assert.ok(await until(() => news.some(d => d.id === 'n2')), 'still heard, signed out');
  await settle(10);
  assert.ok(!items.some(d => d.id === 'i1'), 'the account\'s watch is paused, as in 1.0');
  await app.stop();
});

test('public read: a switch wipes the public copy with the rest (nothing is lost) and the public watch starts again', async () => {
  const t = await modulesApp({ more: { ...PUBLIC, reopen: async () => ({}) } });
  const { app, srv } = t;
  srv.set('news', { id: 'n1', text: 'Fake news one', updatedAt: 1 });
  let news = [];
  app.sync.watch('public:all', 'news', l => { news = l; });
  await app.auth.signIn();
  await app.auth.signOut();
  t.sdk.next = fakeUser({ uid: 'u2', email: 'other.fake@example.test' });
  assert.equal((await app.auth.signIn()).ok, true);
  assert.deepEqual(t.reloads, [], 'reopen made a new instance: no reload');
  news = [];
  srv.set('news', { id: 'n2', text: 'Fake news two', updatedAt: 2 });
  assert.ok(await until(() => news.some(d => d.id === 'n1') && news.some(d => d.id === 'n2')), 'the public watch carries on after the switch');
  await app.stop();
});

test('public read: read only and kept apart: no saves to public:*, no account scope public:*, only public collections there', async () => {
  assert.throws(() => sync({ colls: ['items'], path: (s, c) => [s, c], public: ['news'] }), /public: news is not in colls/);
  const t = await modulesApp({ more: PUBLIC });
  const { app } = t;
  await app.auth.signIn();
  await assert.rejects(app.sync.save('news', 'public:all', { id: 'n1' }), /public:all is read only/);
  assert.deepEqual(await Promise.allSettled([app.sync.saveMany('news', 'public:all', [{ id: 'n1' }])]).then(r => r[0].value[0].status), 'rejected');
  await assert.rejects(app.sync.open('public:all'), /public:all is read only/);
  assert.throws(() => app.sync.watch('public:all', 'items', () => {}), /items is not a public collection/);
  assert.equal(app.sync.queue.entries().length, 0);
  await app.stop();
});

test('public read: a public:* scope listens to its collections only, no bin or tombstone feeds (those read account data)', async () => {
  const srv = fakeServer(), base = fakeAdapter(srv), heard = [];
  const adapter = { ...base, listen: (s, c, ...rest) => { heard.push(s + ' ' + c); return base.listen(s, c, ...rest); } };
  const { app } = await modulesApp({ srv, adapter, more: { ...PUBLIC, hub: { feeds: { moved: { item: 'items' } } } } });
  app.sync.watch('public:all', 'news', () => {});
  await app.auth.signIn();
  app.sync.watch('sp-u1', 'items', () => {});
  assert.ok(await until(() => heard.includes('sp-u1 items')));
  await settle(20);
  assert.deepEqual([...new Set(heard.filter(h => h.startsWith('public:')))], ['public:all news'], 'no bin or feeds in the public scope (listened again at sign-in)');
  assert.ok(heard.includes('sp-u1 bin') && heard.includes('sp-u1 moved'), 'the account scope keeps its bin and feeds');
  await app.stop();
});

test('public read: a relisten while signed out (the public watch still listening) starts only what was running', async () => {
  const srv = fakeServer(), base = fakeAdapter(srv), heard = [];
  let t = Date.now();
  const adapter = { ...base, listen: (s, c, ...rest) => { heard.push(c); return base.listen(s, c, ...rest); } };
  const { app } = await modulesApp({ srv, adapter, more: { ...PUBLIC, now: () => t } });
  app.sync.watch('public:all', 'news', () => {});
  await app.auth.signIn();
  app.sync.watch('sp-u1', 'items', () => {});
  assert.ok(await until(() => heard.includes('items')));
  await app.auth.signOut();
  await settle(10);
  heard.length = 0;
  t += 60000;
  assert.equal(app.sync.nudge('wake'), true, 'nothing heard for a minute: listened again');
  assert.ok(await until(() => heard.includes('news')), 'the public watch listened again');
  await settle(20);
  assert.deepEqual(heard, ['news'], 'the account\'s watch stays paused, signed out');
  await app.stop();
});
