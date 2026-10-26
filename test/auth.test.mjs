// The auth module (0.9.0, auth.js) on the module runner: sign-in, onUser, user, the claims, and sign-out that keeps
// the device's data (same account: it carries on; another account: switch, wiped after the app's hook; forget()).
// A fake SDK and a fake data module stand in for Firebase and the sync module. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { auth, emailLink, password, passcode, anonymous } from '../auth.js';

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const memStorage = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

function fakeUser({ uid = 'u1', email = 'Fake.Person@Example.test', claims = {}, anonymous = false } = {}) {
  const u = { uid, email, displayName: 'Fake Person', photoURL: '', emailVerified: true, isAnonymous: anonymous, claims, refreshed: 0 };
  u.getIdTokenResult = async () => ({ claims: u.claims });
  u.getIdToken = async force => { if (force) u.refreshed++; return 'fake-token-' + u.uid; };
  return u;
}
// Auth (popup, redirect, state listeners, sign-out) and the bits of Firestore the claims watch uses
function fakeSdk({ popupError = null, signedIn = null, redirectError = null } = {}) {
  const calls = [], docs = new Map(), docCbs = new Map();
  let next = fakeUser();
  const auth = { currentUser: signedIn, cbs: new Set(), set(u) { this.currentUser = u; for (const cb of [...this.cbs]) cb(u); } };
  const A = {
    GoogleAuthProvider: class {
      setCustomParameters(p) { this.params = p; calls.push('params ' + JSON.stringify(p)); }
      static credentialFromError(e) { return e.credential || null; }
    },
    async signInWithPopup(a) { calls.push('popup'); if (popupError) throw Object.assign(new Error('fake'), { code: popupError }); a.set(next); },
    async signInWithRedirect() { calls.push('redirect'); },
    async getRedirectResult() { if (redirectError) throw redirectError; return null; },
    onAuthStateChanged(a, cb) { a.cbs.add(cb); cb(a.currentUser); return () => a.cbs.delete(cb); },
    async signOut(a) { calls.push('signOut'); a.set(null); },
    // the 1.3.0 methods (a credential is what it would sign in as; linking keeps the anonymous account's uid)
    EmailAuthProvider: {
      credential: (email, password) => ({ email, password }),
      credentialWithLink: (email, link) => ({ email, link }),
    },
    async signInAnonymously(a) { calls.push('anonymous'); a.set(fakeUser({ uid: 'anon1', email: '', anonymous: true })); },
    async signInWithCredential(a, c) { calls.push('credential ' + c.email); a.set(fakeUser({ uid: taken.get(c.email) || 'u-' + c.email, email: c.email })); },
    async linkWithCredential(u, c) {
      calls.push('link ' + c.email);
      if (taken.has(c.email)) throw Object.assign(new Error('fake'), { code: 'auth/email-already-in-use' });
      Object.assign(u, { email: c.email, isAnonymous: false });
    },
    async linkWithPopup(u) { calls.push('linkPopup'); Object.assign(u, { email: next.email, isAnonymous: false }); },
    async signInWithCustomToken(a, token) { calls.push('token ' + token); a.set(fakeUser({ uid: 'guest-' + token, email: '' })); },
    isSignInWithEmailLink: (_a, href) => href.includes('oobCode='),
    async sendSignInLinkToEmail(_a, email, settings) { calls.push('send ' + email + ' ' + JSON.stringify(settings)); },
  };
  const taken = new Map();
  const db = {};
  const snap = (path, fromCache = false) => ({ exists: () => docs.has(path), data: () => structuredClone(docs.get(path)), metadata: { fromCache } });
  const F = {
    doc: (_db, ...segs) => ({ path: segs.join('/') }),
    onSnapshot(ref, cb) { docCbs.set(ref.path, cb); return () => docCbs.delete(ref.path); },
  };
  const setDoc = (path, d) => { if (d) docs.set(path, d); else docs.delete(path); docCbs.get(path)?.(snap(path)); };
  return { A, F, auth, db, calls, docCbs, setDoc, taken, as(u) { next = u; }, sdk: async () => ({ A, F, auth, db }) };
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
  await assert.rejects(blocked.app.auth.signIn({ method: 'password' }), /not in auth\(\{ methods \}\)/);
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

// ---- 1.3.0: sign-in methods (SHAPES.md 8): each its own named export; the SHAPES string names load the same code ----

test('methods: only the ones listed sign in (google alone by default); a name not known fails at auth()', async () => {
  const t = setup({ options: { methods: [password()] } });
  await t.app.ready;
  await assert.rejects(t.app.auth.signIn({ method: 'anonymous' }), /not in auth\(\{ methods \}\)/);
  await assert.rejects(t.app.auth.signIn(), /not in auth\(\{ methods \}\)/, 'google is not listed here');
  assert.throws(() => auth({ methods: ['fax'] }), /unknown sign-in method fax/);
  const byName = setup({ options: { methods: ['passcode'] } });
  await byName.app.ready;
  await assert.rejects(byName.app.auth.signIn({ method: 'passcode', code: 'fake' }), /passcode needs its url/, 'by name it has no url');
});

test('password, by named export and by name: signs in as that account, then the usual signin', async () => {
  for (const methods of [[password()], ['password']]) {
    const t = setup({ options: { methods } });
    await t.app.ready;
    assert.deepEqual(await t.app.auth.signIn({ method: 'password', email: 'pw.fake@example.test', password: 'fake-pass' }), { ok: true, reason: '' });
    assert.deepEqual(t.sdk.calls, ['credential pw.fake@example.test']);
    assert.equal(t.app.auth.user().uid, 'u-pw.fake@example.test');
    assert.deepEqual(t.log, ['signin u-pw.fake@example.test']);
  }
});

test('anonymous, then a real account links to it: same uid, no switch, the unsent save stays and the owner gets the email', async () => {
  const t = setup({ options: { methods: [anonymous(), password(), 'google'] } });
  await t.app.ready;
  assert.deepEqual(await t.app.auth.signIn({ method: 'anonymous' }), { ok: true, reason: '' });
  assert.equal(t.app.auth.user().uid, 'anon1');
  t.app.data.save({ id: 'guest row' });
  const seen = [];
  t.app.auth.onUser(u => seen.push(u?.email ?? null));
  assert.deepEqual(await t.app.auth.signIn({ method: 'password', email: 'Linked.Fake@example.test', password: 'fake-pass' }), { ok: true, reason: '' });
  assert.equal(t.app.auth.user().uid, 'anon1', 'the uid is kept');
  assert.equal(t.app.auth.user().email, 'linked.fake@example.test');
  assert.deepEqual(seen, ['', 'linked.fake@example.test'], 'onUser hears the linked account');
  assert.deepEqual(t.log, ['signin anon1'], 'no switch, no second signin');
  assert.deepEqual(t.device, { rows: [{ id: 'guest row' }], unsent: 1 }, 'the device data stays');
  assert.deepEqual(JSON.parse(t.storage.m.get('fake-app:auth/owner')), { uid: 'anon1', email: 'linked.fake@example.test' });
  // anonymous again while signed in: nothing to do
  assert.deepEqual(await t.app.auth.signIn({ method: 'anonymous' }), { ok: true, reason: '' });
  assert.equal(t.sdk.calls.filter(c => c === 'anonymous').length, 1);
});

test('linking google keeps the uid; a credential already taken by an account signs in to it (a switch, guarded as ever)', async () => {
  const t = setup({ options: { methods: ['anonymous', 'google', password()] } });
  await t.app.ready;
  await t.app.auth.signIn({ method: 'anonymous' });
  assert.deepEqual(await t.app.auth.signIn(), { ok: true, reason: '' });
  assert.deepEqual(t.sdk.calls.slice(-1), ['linkPopup']);
  assert.equal(t.app.auth.user().uid, 'anon1');
  assert.equal(t.app.auth.user().email, 'fake.person@example.test');
  // a fresh guest whose unsent save would go with a switch: the taken account's sign-in is refused
  const u = setup({ options: { methods: ['anonymous', password()] } });
  await u.app.ready;
  await u.app.auth.signIn({ method: 'anonymous' });
  u.app.data.save({ id: 'guest row' });
  u.sdk.taken.set('used.fake@example.test', 'u9');
  const r = await u.app.auth.signIn({ method: 'password', email: 'used.fake@example.test', password: 'fake-pass' });
  assert.deepEqual(r, { ok: false, reason: 'unsent', from: { uid: 'anon1', email: '' } });
  assert.deepEqual(u.sdk.calls.slice(-3), ['link used.fake@example.test', 'credential used.fake@example.test', 'signOut']);
  assert.deepEqual(u.device.rows, [{ id: 'guest row' }]);
});

test('a guest back from linking google by redirect, the account already taken: signs in to it (a switch, guarded as ever)', async () => {
  const code = 'auth/credential-already-in-use', credential = { email: 'used.fake@example.test' };
  const sdk = fakeSdk({ signedIn: fakeUser({ uid: 'anon1', email: '', anonymous: true }), redirectError: Object.assign(new Error('fake'), { code, credential }) });
  sdk.taken.set('used.fake@example.test', 'u9');
  const t = setup({ sdk, options: { methods: ['anonymous', 'google'] } });
  await t.app.ready;
  await settle(20);
  assert.ok(t.sdk.calls.includes('credential used.fake@example.test'), 'signs in with the taken credential');
  assert.equal(t.app.auth.user().uid, 'u9');
  assert.ok(t.log.includes('switch anon1>u9'), 'the usual switch');
});

test('emailLink: sends the link (reason sent); on the page the link opens, signs in with it', async () => {
  const win = { location: { href: 'https://app.example.test/list?x=1', origin: 'https://app.example.test', pathname: '/list' } };
  const t = setup({ options: { methods: [emailLink({ win })] } });
  await t.app.ready;
  assert.deepEqual(await t.app.auth.signIn({ method: 'emailLink', email: 'link.fake@example.test' }), { ok: false, reason: 'sent' });
  assert.deepEqual(t.sdk.calls, ['send link.fake@example.test {"url":"https://app.example.test/list","handleCodeInApp":true}']);
  win.location.href = 'https://app.example.test/list?oobCode=fake&mode=signIn';
  assert.deepEqual(await t.app.auth.signIn({ method: 'emailLink', email: 'link.fake@example.test' }), { ok: true, reason: '' });
  assert.equal(t.app.auth.user().email, 'link.fake@example.test');
  const own = setup({ options: { methods: [emailLink({ win, url: 'https://app.example.test/done' })] } });
  await own.app.ready;
  win.location.href = 'https://app.example.test/';
  await own.app.auth.signIn({ method: 'emailLink', email: 'link.fake@example.test' });
  assert.match(own.sdk.calls[0], /"url":"https:\/\/app\.example\.test\/done"/);
  await assert.rejects(own.app.auth.signIn({ method: 'emailLink' }), /emailLink needs the email/);
});

test('passcode: the code goes to the app\'s url, its token signs in; a refused code is reason refused', async () => {
  const posts = [];
  const fetch = async (url, init) => {
    posts.push(url + ' ' + init.body);
    const { code } = JSON.parse(init.body);
    return code === 'right' ? { ok: true, status: 200, json: async () => ({ token: 'tok1' }) } : { ok: false, status: 403, json: async () => ({}) };
  };
  const t = setup({ options: { methods: [passcode({ url: 'https://guest.example.test/token', fetch })] } });
  await t.app.ready;
  assert.deepEqual(await t.app.auth.signIn({ method: 'passcode', code: 'wrong' }), { ok: false, reason: 'refused' });
  assert.equal(t.app.auth.user(), null);
  assert.deepEqual(await t.app.auth.signIn({ method: 'passcode', code: 'right', email: 'g.fake@example.test' }), { ok: true, reason: '' });
  assert.deepEqual(posts, ['https://guest.example.test/token {"code":"wrong"}', 'https://guest.example.test/token {"code":"right","email":"g.fake@example.test"}']);
  assert.deepEqual(t.sdk.calls, ['token tok1']);
  assert.equal(t.app.auth.user().uid, 'guest-tok1');
});

test('passcode: a sign-out while the code is out wins: its token signs nobody in', async () => {
  let answer;
  const fetch = () => new Promise(r => { answer = () => r({ ok: true, status: 200, json: async () => ({ token: 'tok1' }) }); });
  const t = setup({ options: { methods: [passcode({ url: 'https://guest.example.test/token', fetch })] } });
  await t.app.ready;
  const pending = t.app.auth.signIn({ method: 'passcode', code: 'right' });
  await settle();
  await t.app.auth.signOut();
  answer();
  assert.deepEqual(await pending, { ok: false, reason: 'refused' });
  assert.equal(t.sdk.auth.currentUser, null);
  assert.equal(t.app.auth.user(), null);
  assert.deepEqual(t.log, []);
});

test('forget(): a wipe that throws keeps the owner, so the next account is a switch that wipes again', async () => {
  const device = { rows: [], unsent: 0 }, log = [];
  let broken = true;
  const flaky = {
    name: 'flaky', needs: ['auth'],
    start(ctx) {
      ctx.on('forget', () => { if (broken) throw new Error('wipe failed'); });
      ctx.on('switch', () => { log.push('flaky switch'); });
      return {};
    },
    stop() {},
  };
  const sdk = fakeSdk();
  const app = createApp({ config: { name: 'fake-app', storage: memStorage(), sdk: sdk.sdk }, modules: [auth(), fakeData(device, log), flaky] });
  await app.ready;
  await app.auth.signIn();
  assert.deepEqual(await app.auth.forget(), { ok: true, reason: '', failed: ['flaky'] });
  broken = false;
  sdk.as(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  assert.deepEqual(await app.auth.signIn(), { ok: true, reason: '' });
  assert.deepEqual(log, ['signin u1', 'signout u1', 'forget u1', 'switch u1>u2', 'flaky switch', 'signin u2']);
});

test('stop() while the app\'s beforeSwitch runs: the switch goes no further, no claims watch is left', async () => {
  let release, entered;
  const inBefore = new Promise(r => { entered = r; });
  const t = setup({ options: {
    beforeSwitch: () => { entered(); return new Promise(r => { release = r; }); },
    claims: { url: 'https://claims.example.test', watch: true, doc: u => 'roles/' + u.uid },
  } });
  await t.app.ready;
  await t.app.auth.signIn();
  await t.app.auth.signOut();
  t.sdk.as(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  void t.app.auth.signIn();
  await inBefore;
  await t.app.stop();
  release();
  await settle();
  assert.equal(t.sdk.docCbs.size, 0, 'no claims watch after stop');
  assert.deepEqual(t.log, ['signin u1', 'signout u1']);
});

test('a sign-out during the SDK\'s own sign-in wins too: the late account is signed straight out, no switch, no wipe', async () => {
  const t = setup();
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'kept' });
  t.app.data.sent();
  await t.app.auth.signOut();
  await t.app.stop();
  let land;
  t.sdk.A.signInWithCustomToken = (a, token) => new Promise(r => { land = () => { a.set(fakeUser({ uid: 'guest-' + token, email: '' })); r(); }; });
  const late = { name: 'late', signIn: async () => ({ token: 'tok2' }) };
  const t2 = setup({ storage: t.storage, sdk: t.sdk, device: t.device, log: t.log, options: { methods: [late] } });
  await t2.app.ready;
  const pending = t2.app.auth.signIn({ method: 'late' });
  await settle();
  await t2.app.auth.signOut();
  land();
  assert.deepEqual(await pending, { ok: false, reason: 'refused' });
  await settle();
  assert.equal(t.sdk.auth.currentUser, null);
  assert.deepEqual(t.device.rows, [{ id: 'kept' }]);
  assert.ok(!t.log.some(l => l.startsWith('switch') || l === 'signin guest-tok2'), t.log.join());
});

test('stop() while the switch\'s wipes run: the new account is not made the owner', async () => {
  let release, entered;
  const inWipe = new Promise(r => { entered = r; });
  const slow = { name: 'slow', needs: ['auth'], start(ctx) { ctx.on('switch', () => { entered(); return new Promise(r => { release = r; }); }); return {}; }, stop() {} };
  const storage = memStorage(), sdk = fakeSdk();
  const app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), slow] });
  await app.ready;
  await app.auth.signIn();
  await app.auth.signOut();
  sdk.as(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  void app.auth.signIn();
  await inWipe;
  await app.stop();
  release();
  await settle();
  assert.match([...storage.m.values()].join(), /"uid":"u1"/);
});

test('a sign-out during a self-signing method wins too: the account it signed in is signed straight out, no switch', async () => {
  const t = setup();
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'kept' });
  t.app.data.sent();
  await t.app.auth.signOut();
  await t.app.stop();
  let land;
  // signs in by itself (a popup's own sign-in): Auth has the account when its promise ends, and tells of it later
  const self = { name: 'self', signIn: x => new Promise(r => { land = () => {
    const u = fakeUser({ uid: 'u2', email: 'other@example.test' });
    x.auth.currentUser = u;
    setTimeout(() => { for (const cb of [...x.auth.cbs]) cb(x.auth.currentUser); }, 0);
    r({});
  }; }) };
  const t2 = setup({ storage: t.storage, sdk: t.sdk, device: t.device, log: t.log, options: { methods: [self] } });
  await t2.app.ready;
  const pending = t2.app.auth.signIn({ method: 'self' });
  await settle();
  await t2.app.auth.signOut();
  land();
  assert.deepEqual(await pending, { ok: false, reason: 'refused' });
  await settle();
  assert.equal(t.sdk.auth.currentUser, null);
  assert.deepEqual(t.device.rows, [{ id: 'kept' }]);
  assert.ok(!t.log.some(l => l.startsWith('switch') || l === 'signin u2'), t.log.join());
});

test('a sign-out during the app\'s beforeSwitch wins: nothing is wiped, the old account stays the owner, no signin', async () => {
  let release, entered;
  const inBefore = new Promise(r => { entered = r; });
  const t = setup({ options: { beforeSwitch: () => { entered(); return new Promise(r => { release = r; }); } } });
  await t.app.ready;
  await t.app.auth.signIn();
  t.app.data.save({ id: 'kept' });
  t.app.data.sent();
  await t.app.auth.signOut();
  t.sdk.as(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  const pending = t.app.auth.signIn();
  await inBefore;
  const out = t.app.auth.signOut();
  await settle();
  release();
  await out;
  assert.deepEqual(await pending, { ok: false, reason: 'refused' });
  await settle();
  assert.equal(t.sdk.auth.currentUser, null);
  assert.deepEqual(t.device.rows, [{ id: 'kept' }]);
  assert.match([...t.storage.m.values()].join(), /"uid":"u1"/);
  assert.deepEqual(t.log, ['signin u1', 'signout u1']);
});

test('stop() during forget\'s wipes: the owner stays (a wipe may not have run)', async () => {
  let app;
  const stopper = { name: 'stopper', needs: ['auth'], start(ctx) { ctx.on('forget', () => app.stop()); return {}; }, stop() {} };
  const storage = memStorage(), sdk = fakeSdk(), device = { rows: [], unsent: 0 }, log = [];
  app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), stopper, fakeData(device, log)] });
  await app.ready;
  await app.auth.signIn();
  app.data.save({ id: 'kept' });
  app.data.sent();
  await app.auth.forget();
  assert.deepEqual(device.rows, [{ id: 'kept' }]);
  assert.match([...storage.m.values()].join(), /"uid":"u1"/);
});

test('a slow module stop: a switch the stop cut short does not make the new account the owner', async () => {
  let release, app;
  const slowStop = { name: 'slowStop', needs: ['auth'], start() { return {}; }, stop() { return new Promise(r => { release = r; }); } };
  const storage = memStorage(), sdk = fakeSdk(), device = { rows: [], unsent: 0 }, log = [];
  app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), fakeData(device, log), slowStop] });
  await app.ready;
  await app.auth.signIn();
  device.rows.push({ id: 'kept' });
  await app.auth.signOut();
  const stopping = app.stop();
  await settle();
  sdk.auth.set(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  await settle();
  release();
  await stopping;
  assert.deepEqual(device.rows, [{ id: 'kept' }]);
  assert.match([...storage.m.values()].join(), /"uid":"u1"/);
});

test('a stop that clears a later module\'s handlers mid-switch: the owner stays (its wipe did not run)', async () => {
  let release, gate;
  const slow = { name: 'slow', needs: ['auth'], start(ctx) { ctx.on('switch', () => new Promise(r => { gate = r; })); return {}; }, stop() { return new Promise(r => { release = r; }); } };
  const storage = memStorage(), sdk = fakeSdk(), device = { rows: [], unsent: 0 }, log = [];
  const app = createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), slow, fakeData(device, log)] });
  await app.ready;
  await app.auth.signIn();
  device.rows.push({ id: 'kept' });
  await app.auth.signOut();
  sdk.auth.set(fakeUser({ uid: 'u2', email: 'other@example.test' }));
  await settle();
  const stopping = app.stop();
  await settle();
  gate();
  await settle();
  release();
  await stopping;
  assert.deepEqual(device.rows, [{ id: 'kept' }]);
  assert.match([...storage.m.values()].join(), /"uid":"u1"/);
});
