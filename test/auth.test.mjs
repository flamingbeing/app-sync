// The auth module (0.9.0, auth.js) on the module runner: sign-in, onUser, user, the claims, and sign-out that keeps
// the device's data (same account: it carries on; another account: switch, wiped after the app's hook; forget()).
// A fake SDK and a fake data module stand in for Firebase and the sync module. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { auth } from '../auth.js';

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const memStorage = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

function fakeUser({ uid = 'u1', email = 'Fake.Person@Example.test', claims = {} } = {}) {
  const u = { uid, email, displayName: 'Fake Person', photoURL: '', emailVerified: true, claims, refreshed: 0 };
  u.getIdTokenResult = async () => ({ claims: u.claims });
  u.getIdToken = async force => { if (force) u.refreshed++; return 'fake-token-' + u.uid; };
  return u;
}
// Auth (popup, redirect, state listeners, sign-out) and the bits of Firestore the claims watch uses
function fakeSdk({ popupError = null, signedIn = null } = {}) {
  const calls = [], docs = new Map(), docCbs = new Map();
  let next = fakeUser();
  const auth = { currentUser: signedIn, cbs: new Set(), set(u) { this.currentUser = u; for (const cb of [...this.cbs]) cb(u); } };
  const A = {
    GoogleAuthProvider: class { setCustomParameters(p) { this.params = p; calls.push('params ' + JSON.stringify(p)); } },
    async signInWithPopup(a) { calls.push('popup'); if (popupError) throw Object.assign(new Error('fake'), { code: popupError }); a.set(next); },
    async signInWithRedirect() { calls.push('redirect'); },
    async getRedirectResult() { return null; },
    onAuthStateChanged(a, cb) { a.cbs.add(cb); cb(a.currentUser); return () => a.cbs.delete(cb); },
    async signOut(a) { calls.push('signOut'); a.set(null); },
  };
  const db = {};
  const snap = (path, fromCache = false) => ({ exists: () => docs.has(path), data: () => structuredClone(docs.get(path)), metadata: { fromCache } });
  const F = {
    doc: (_db, ...segs) => ({ path: segs.join('/') }),
    onSnapshot(ref, cb) { docCbs.set(ref.path, cb); return () => docCbs.delete(ref.path); },
  };
  const setDoc = (path, d) => { if (d) docs.set(path, d); else docs.delete(path); docCbs.get(path)?.(snap(path)); };
  return { A, F, auth, db, calls, docCbs, setDoc, as(u) { next = u; }, sdk: async () => ({ A, F, auth, db }) };
}
// stands in for the sync module: per-account data on the device, unsent saves, reports unsent to the status
function fakeData(device, log) {
  return {
    name: 'data', needs: ['auth'],
    start(ctx) {
      const tell = () => ctx.status.set({ state: device.unsent ? 'saving' : 'synced', count: device.unsent, unsent: device.unsent });
      tell();
      ctx.on('signin', ({ user }) => log.push('signin ' + user.uid));
      ctx.on('signout', ({ user }) => log.push('signout ' + user.uid));
      ctx.on('switch', ({ from, to }) => { log.push('switch ' + from.uid + '>' + to.uid); device.rows = []; device.unsent = 0; tell(); });
      ctx.on('forget', ({ user }) => { log.push('forget ' + (user?.uid || '-')); device.rows = []; device.unsent = 0; tell(); });
      return { save(row) { device.rows.push(row); device.unsent++; tell(); }, sent() { device.unsent = 0; tell(); } };
    },
    stop() {},
  };
}
function setup({ storage = memStorage(), sdk = fakeSdk(), device = { rows: [], unsent: 0 }, log = [], options = {} } = {}) {
  const app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(options), fakeData(device, log)] });
  return { app, storage, sdk, device, log };
}

test('signIn: the popup with the hint, a redirect where the popup cannot open; onUser and user follow', async () => {
  const t = setup();
  await t.app.ready;
  const seen = [];
  t.app.auth.onUser(u => seen.push(u?.uid || null));
  assert.deepEqual(await t.app.auth.signIn({ hint: 'fake@example.test' }), { ok: true, reason: '' });
  assert.deepEqual(t.sdk.calls.slice(0, 2), ['params {"prompt":"select_account","login_hint":"fake@example.test"}', 'popup']);
  assert.equal(t.app.auth.user().email, 'fake.person@example.test');
  assert.deepEqual(seen, [null, 'u1']);
  assert.deepEqual(t.log, ['signin u1']);
  const blocked = setup({ sdk: fakeSdk({ popupError: 'auth/popup-blocked' }) });
  await blocked.app.ready;
  assert.deepEqual(await blocked.app.auth.signIn(), { ok: false, reason: 'redirect' });
  assert.deepEqual(blocked.sdk.calls.slice(1), ['popup', 'redirect']);
  await assert.rejects(blocked.app.auth.signIn({ method: 'password' }), /1\.x/);
});

test('sign-out keeps the device copy and unsent saves; the same account carries on after a reload', async () => {
  const t = setup();
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'r1' });
  assert.deepEqual(await t.app.auth.signOut(), { ok: true, reason: '' });
  assert.equal(t.app.auth.user(), null);
  assert.deepEqual(t.device, { rows: [{ id: 'r1' }], unsent: 1 }, 'nothing wiped, the unsent save still waits');
  await t.app.stop();
  // the page again, same device: the same account signs in, no switch, the data is still there
  const again = setup({ storage: t.storage, sdk: t.sdk, device: t.device, log: t.log });
  await again.app.ready;
  await again.app.auth.signIn();
  assert.deepEqual(t.log, ['signin u1', 'signout u1', 'signin u1']);
  assert.deepEqual(t.device.rows, [{ id: 'r1' }]);
});

test('another account: the app\'s hook, then switch wipes the old data, then signin; refused while the old one has unsent saves', async () => {
  const order = [];
  const t = setup({ options: { beforeSwitch: async ({ from, to }) => { order.push('before ' + from.uid + '>' + to.uid + ' ' + from.email); } } });
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'mine' });
  await t.app.auth.signOut();
  t.sdk.as(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  // the first account's save is not sent yet: the switch would lose it, so it is refused and the new account signed out
  assert.deepEqual(await t.app.auth.signIn(), { ok: false, reason: 'unsent', from: { uid: 'u1', email: 'fake.person@example.test' } });
  assert.equal(t.app.auth.user(), null);
  assert.equal(t.sdk.auth.currentUser, null);
  assert.deepEqual(t.app.auth.blocked(), { from: { uid: 'u1', email: 'fake.person@example.test' }, to: { uid: 'u2', email: 'other@example.test', name: 'Fake Person', photo: '', verified: true }, reason: 'unsent' });
  assert.deepEqual(t.device.rows, [{ id: 'mine' }]);
  assert.deepEqual(order, []);
  // once nothing waits, the other account signs in: hook, switch (wipe), signin
  t.app.data.sent();
  assert.deepEqual(await t.app.auth.signIn(), { ok: true, reason: '' });
  assert.deepEqual(order, ['before u1>u2 fake.person@example.test']);
  assert.deepEqual(t.log, ['signin u1', 'signout u1', 'switch u1>u2', 'signin u2']);
  assert.deepEqual(t.device.rows, []);
  assert.equal(t.app.auth.blocked(), null);
  assert.equal(t.app.auth.user().uid, 'u2');
});

test('a different account already signed in when the page opens (another tab) is a switch too', async () => {
  const storage = memStorage();
  const t = setup({ storage });
  await t.app.ready;
  await t.app.auth.signIn();
  await t.app.stop();
  const sdk = fakeSdk({ signedIn: fakeUser({ uid: 'u2' }) });
  const log = [];
  const again = setup({ storage, sdk, log });
  await again.app.ready;
  await settle();
  assert.deepEqual(log, ['switch u1>u2', 'signin u2']);
});

test('a slow module (reading its data at start) is started before Auth\'s first answer is handled: its unsent saves refuse the switch', async () => {
  const storage = memStorage(), device = { rows: [], unsent: 0 };
  const t = setup({ storage, device });
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'a' });
  await t.app.stop();
  // the page opens again with another account in Auth; the data module takes a while to read its device copy
  const sdk = fakeSdk({ signedIn: fakeUser({ uid: 'u2' }) }), log = [];
  const data = fakeData(device, log), start = data.start;
  data.start = async ctx => { await settle(10); return start(ctx); };
  const again = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), data] });
  await again.ready;
  await settle(20);
  assert.equal(again.auth.user(), null);
  assert.equal(again.auth.blocked()?.from.uid, 'u1');
  assert.deepEqual(device, { rows: [{ id: 'a' }], unsent: 1 });
  assert.deepEqual(log, []);
});

test('forget(): refused while unsent unless forced; the hook, sign-out, then forget wipes; the next account is no switch', async () => {
  const t = setup();
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'r1' });
  assert.deepEqual(await t.app.auth.forget(), { ok: false, reason: 'unsent', failed: [] });
  assert.equal(t.app.auth.user().uid, 'u1');
  const steps = [];
  const r = await t.app.auth.forget({ force: true, before: () => { steps.push('before'); throw new Error('own step failed'); } });
  assert.deepEqual(r, { ok: true, reason: '', failed: ['before'] });
  assert.deepEqual(steps, ['before']);
  assert.deepEqual(t.log, ['signin u1', 'signout u1', 'forget u1']);
  assert.deepEqual(t.device, { rows: [], unsent: 0 });
  t.sdk.as(fakeUser({ uid: 'u2' }));
  await t.app.auth.signIn();
  assert.deepEqual(t.log.slice(3), ['signin u2']);
  // forget while signed out forgets the last account's data
  await t.app.auth.signOut();
  assert.deepEqual(await t.app.auth.forget(), { ok: true, reason: '', failed: [] });
  assert.deepEqual(t.log.slice(4), ['signout u2', 'forget u2']);
});

test('a save made while the app\'s beforeSwitch runs refuses the switch: nothing is wiped', async () => {
  let t;
  t = setup({ options: { beforeSwitch: async () => { t.app.data.save({ id: 'late' }); } } });
  await t.app.ready;
  await t.app.auth.signIn();
  await t.app.auth.signOut();
  t.sdk.as(fakeUser({ uid: 'u2' }));
  assert.deepEqual(await t.app.auth.signIn(), { ok: false, reason: 'unsent', from: { uid: 'u1', email: 'fake.person@example.test' } });
  assert.deepEqual(t.device, { rows: [{ id: 'late' }], unsent: 1 });
  assert.equal(t.app.auth.user(), null);
  assert.equal(t.sdk.auth.currentUser, null);
  assert.ok(!t.log.some(l => l.startsWith('switch')));
});

test('a module whose wipe throws refuses the switch: the new account is signed out, the old owner kept, tried again next time', async () => {
  const storage = memStorage(), device = { rows: [], unsent: 0 }, log = [], sdk = fakeSdk();
  let fail = true;
  const bad = { name: 'bad', needs: [], start(ctx) { ctx.on('switch', () => { if (fail) throw new Error('fake wipe failed'); log.push('bad wiped'); }); return {}; }, stop() {} };
  const reports = [];
  const app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk, report: f => reports.push(f) }, modules: [auth(), fakeData(device, log), bad] });
  await app.ready;
  await app.auth.signIn();
  await app.auth.signOut();
  sdk.as(fakeUser({ uid: 'u2' }));
  assert.deepEqual(await app.auth.signIn(), { ok: false, reason: 'wipe', from: { uid: 'u1', email: 'fake.person@example.test' } });
  assert.equal(app.auth.user(), null);
  assert.equal(sdk.auth.currentUser, null);
  assert.equal(app.auth.blocked()?.reason, 'wipe');
  assert.equal(JSON.parse(storage.getItem('fake-app:auth/owner')).uid, 'u1');
  assert.ok(!log.includes('signin u2'));
  assert.deepEqual(reports.filter(r => r.event === 'switch').map(r => r.failed), [['bad']]);
  fail = false;
  assert.deepEqual(await app.auth.signIn(), { ok: true, reason: '' });
  assert.deepEqual(log.slice(-3), ['switch u1>u2', 'bad wiped', 'signin u2']);
});

test('another tab already switched: this tab still switches (its own data and listeners), once', async () => {
  const storage = memStorage(), sdk1 = fakeSdk(), sdk2 = fakeSdk();
  const one = setup({ storage, sdk: sdk1 }), two = setup({ storage, sdk: sdk2 });
  await one.app.ready; await two.app.ready;
  await one.app.auth.signIn();
  sdk2.auth.set(fakeUser()); await settle();
  assert.deepEqual(two.log, ['signin u1']);
  sdk1.as(fakeUser({ uid: 'u2' }));
  await one.app.auth.signIn();
  assert.deepEqual(one.log.slice(-2), ['switch u1>u2', 'signin u2']);
  // Auth tells the other tab later; the owner in storage already says u2
  sdk2.auth.set(fakeUser({ uid: 'u2' })); await settle();
  assert.deepEqual(two.log, ['signin u1', 'switch u1>u2', 'signin u2']);
});

test('forget(): a save made while the app\'s before() runs refuses it (unless forced)', async () => {
  let t;
  t = setup();
  await t.app.ready;
  await t.app.auth.signIn();
  const r = await t.app.auth.forget({ before: () => { t.app.data.save({ id: 'late' }); } });
  assert.deepEqual(r, { ok: false, reason: 'unsent', failed: [] });
  assert.deepEqual(t.device, { rows: [{ id: 'late' }], unsent: 1 });
  assert.ok(!t.log.some(l => l.startsWith('forget')));
});

test('claims: asked once per uid:v when the role doc is ahead of the token; the watch asks again when it changes', async () => {
  const posts = [];
  const fetch = async (url, init) => { posts.push(url + ' ' + init.headers.Authorization); return { ok: true, status: 200 }; };
  const sdk = fakeSdk();
  const user = fakeUser({ claims: { v: 1 } });
  sdk.as(user);
  const onClaims = [];
  const t = setup({ sdk, options: { fetch, claims: { url: 'https://claims.example.test/', watch: true, doc: u => ['roles', u.uid], onClaims: r => onClaims.push(r) } } });
  await t.app.ready;
  await t.app.auth.signIn();
  await settle();
  assert.deepEqual(posts, [], 'nothing asked before the role doc first answers');
  assert.ok(sdk.docCbs.has('roles/u1'));
  sdk.setDoc('roles/u1', { v: 2 });
  await settle();
  assert.deepEqual(posts, ['https://claims.example.test/ Bearer fake-token-u1']);
  assert.equal(user.refreshed, 1);
  assert.deepEqual(onClaims.at(-1), { asked: true, status: 200 });
  sdk.setDoc('roles/u1', { v: 2, more: 1 });
  await settle();
  assert.equal(posts.length, 1, 'the same uid:v is not asked twice');
  await t.app.auth.signOut();
  assert.ok(!sdk.docCbs.has('roles/u1'), 'sign-out stops the watch');
});

test('stop() ends the Auth listener; nothing is emitted after', async () => {
  const t = setup();
  await t.app.ready;
  await t.app.stop();
  t.sdk.auth.set(fakeUser());
  await settle();
  assert.deepEqual(t.log, []);
});
