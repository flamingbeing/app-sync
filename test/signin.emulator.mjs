// The sign-in methods (1.3.0: auth({ methods })) and public read (sync({ public })) end to end against the local Auth and
// Firestore emulators (demo project: nothing reaches a real Firebase project): anonymous, password, email link (its
// link read from the emulator's oobCodes), passcode (an unsigned custom token, which only the emulator takes), an
// anonymous account linked to a password one (same uid, the device's data stays), and a public:* watch with no sign-in.
// Run with: npm run test:emulator (needs Java). Made-up data only.
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import * as A from 'firebase/auth';
import * as F from 'firebase/firestore';
import { createApp } from '../app.js';
import { auth, anonymous, password, emailLink, passcode } from '../auth.js';
import { sync } from '../sync.js';

const FS = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const PROJECT = 'demo-app-sync';
const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(50); }
  return false;
}
function memStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
function memOutbox(name, records = new Map()) {
  return {
    name, realm: 'default', records,
    async put(x) { records.set(x.key, structuredClone(x)); },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(x => structuredClone(x)); },
    async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; },
    async remove(k) { records.delete(k); },
    async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); },
  };
}
let n = 0;
function sdkFor() {
  const fb = initializeApp({ projectId: PROJECT, apiKey: 'fake-key', authDomain: 'localhost' }, 'signin-' + (++n));
  const a = A.getAuth(fb);
  A.connectAuthEmulator(a, 'http://' + AUTH, { disableWarnings: true });
  const db = F.getFirestore(fb);
  F.connectFirestoreEmulator(db, FS[0], Number(FS[1]));
  return { A, F, auth: a, db, emulator: true };
}
const run = Date.now().toString(36);
const opened = [];
async function makeApp(methods, more = {}) {
  const sdk = sdkFor(), name = 'signin' + n;
  opened.push(sdk);
  const app = await createApp({
    config: { name, storage: memStorage(), sdk: async () => sdk },
    modules: [auth({ methods, win: null }), sync({ colls: ['items', 'news'], path: (s, c) => ['spaces', s, c], scope: u => 'sp-' + u.uid,
      nav: { onLine: true, storage: { persisted: async () => true } }, win: null, outbox: memOutbox(name + '-outbox'), watchEvery: 0, ...more })],
  }).ready;
  return { app, sdk };
}
const signedIn = app => until(() => !!app.auth.user());

// ---- anonymous: an account with no email, its scope opens ----
{
  const { app, sdk } = await makeApp([anonymous()]);
  assert.equal((await app.auth.signIn({ method: 'anonymous' })).ok, true);
  assert.ok(await signedIn(app));
  assert.equal(sdk.auth.currentUser.isAnonymous, true);
  assert.equal(app.auth.user().uid, sdk.auth.currentUser.uid);
  await app.stop();
}

// ---- password: an account the app made (here through the emulator) signs in ----
{
  const email = `fake.pw.${run}@example.test`;
  const maker = sdkFor(); opened.push(maker);
  await A.createUserWithEmailAndPassword(maker.auth, email, 'fake-secret-1');
  await A.signOut(maker.auth);
  const { app } = await makeApp([password()]);
  assert.equal((await app.auth.signIn({ method: 'password', email, password: 'fake-secret-1' })).ok, true);
  assert.ok(await signedIn(app));
  assert.equal(app.auth.user().email, email);
  await assert.rejects(app.auth.signIn({ method: 'google' }), /google is not in auth/, 'only the methods named');
  await app.stop();
}

// ---- email link: sent (reason 'sent'), then the page the link opens signs in with it ----
{
  const email = `fake.link.${run}@example.test`;
  const win = { location: new URL('http://localhost/app/') };
  const { app } = await makeApp([emailLink({ win })]);
  assert.deepEqual(await app.auth.signIn({ method: 'emailLink', email }), { ok: false, reason: 'sent' });
  const codes = await (await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const link = codes.oobCodes.filter(c => c.email === email && c.requestType === 'EMAIL_SIGNIN').at(-1)?.oobLink;
  assert.ok(link, 'the emulator holds the link');
  win.location = new URL(link);
  assert.equal((await app.auth.signIn({ method: 'emailLink', email })).ok, true);
  assert.ok(await signedIn(app));
  assert.equal(app.auth.user().email, email);
  await app.stop();
}

// ---- passcode: the app's server swaps a code for a custom token; a wrong code is reason 'refused' ----
{
  const b64 = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const token = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    iss: 'fake@example.test', sub: 'fake@example.test', uid: 'fake-guest-' + run, iat: now, exp: now + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  }) + '.';
  const asked = [];
  const serve = async (_url, init) => {
    const body = JSON.parse(init.body); asked.push(body);
    return body.code === 'fake-code' ? new Response(JSON.stringify({ token })) : new Response('{}', { status: 403 });
  };
  const { app } = await makeApp([passcode({ url: 'https://passcode.example.test/', fetch: serve })]);
  assert.deepEqual(await app.auth.signIn({ method: 'passcode', code: 'wrong' }), { ok: false, reason: 'refused' });
  assert.equal(app.auth.user(), null);
  assert.equal((await app.auth.signIn({ method: 'passcode', code: 'fake-code' })).ok, true);
  assert.ok(await signedIn(app));
  assert.equal(app.auth.user().uid, 'fake-guest-' + run);
  assert.deepEqual(asked, [{ code: 'wrong' }, { code: 'fake-code' }]);
  await app.stop();
}

// ---- anonymous, then a password account linked to it: the same uid, the saves made meanwhile stay and send ----
{
  const email = `fake.linked.${run}@example.test`;
  const { app, sdk } = await makeApp([anonymous(), password()]);
  await app.auth.signIn({ method: 'anonymous' });
  assert.ok(await signedIn(app));
  const uid = app.auth.user().uid, scope = 'sp-' + uid;
  let list = [];
  app.sync.watch(scope, 'items', l => { list = l; });
  await app.sync.save('items', scope, { id: 'r1', text: 'Fake, made anonymously' });
  assert.equal((await app.auth.signIn({ method: 'password', email, password: 'fake-secret-2' })).ok, true);
  assert.ok(await until(() => app.auth.user()?.email === email), 'onUser has the email');
  assert.equal(sdk.auth.currentUser.uid, uid, 'linked: the same uid');
  assert.equal(sdk.auth.currentUser.isAnonymous, false);
  assert.equal(app.auth.blocked(), null, 'no switch');
  assert.ok(await app.sync.flush(8000), 'the save sent');
  assert.ok(list.some(d => d.id === 'r1'), 'the device copy kept');
  const snap = await F.getDoc(F.doc(sdk.db, 'spaces', scope, 'items', 'r1'));
  assert.equal(snap.data()?.text, 'Fake, made anonymously');
  await app.stop();
}

// ---- public read: a public:* watch reads with no sign-in ----
{
  const writer = sdkFor(); opened.push(writer);
  const where = 'public:' + run;
  await F.setDoc(F.doc(writer.db, 'spaces', where, 'news', 'n1'), { text: 'Fake news', updatedAt: Date.now() });
  const { app } = await makeApp([anonymous()], { public: ['news'] });
  let news = [];
  app.sync.watch(where, 'news', l => { news = l; });
  assert.ok(await until(() => news.some(d => d.id === 'n1')), 'read with no account');
  assert.equal(app.auth.user(), null);
  await assert.rejects(app.sync.save('news', where, { id: 'n2' }), /is read only/);
  await app.stop();
}

for (const s of opened) await F.terminate(s.db);
console.log('sign-in methods emulator: anonymous, password, email link, passcode, anonymous -> password link, public read: ok');
process.exit(0);
