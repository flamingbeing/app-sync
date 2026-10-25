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
async function modulesApp({ storage = memStorage(), sdk = switchSdk(), srv = fakeServer(), nav = fakeNav(), name = 'modtest' + (++n) + '-' + Date.now(), outbox = null } = {}) {
  const adapter = fakeAdapter(srv), reloads = [];
  const app = await createApp({
    config: { name, storage, sdk: async () => ({ A: sdk.A, F: {}, auth: sdk.auth, db: {} }) },
    modules: [auth({ nav, win: null }), sync({ colls: ['items'], path: (s, c) => ['spaces', s, c], kinds: { item: 'items' },
      scope: u => 'sp-' + u.uid, adapter, nav, win: null, outbox: outbox || memOutbox(name + '-outbox'), watchEvery: 0,
      reload: () => reloads.push('reload') })],
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
