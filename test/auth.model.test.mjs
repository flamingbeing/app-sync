// Run with: node --test test/auth.model.test.mjs     (one seed: MODEL_SEED=123; more seeds: MODEL_SEEDS=500)
// Model-based test of the auth module (0.9.0) on the runner: for each seed, a random run of sign-ins (here and from
// another tab), sign-outs, saves, sends, forget() (forced or not) and page reloads (another account maybe signed in meanwhile) on one device with three accounts,
// checked after every step against a simple model:
//  - the device's data is wiped only by forget() or by another account's sign-in when the last one has nothing unsent
//    (a switch); a sign-out, a reload or a refused switch keeps every row;
//  - unsent saves are never lost, except by forget({ force: true });
//  - the device only ever holds one account's rows, and the stored owner is that account;
//  - a refused switch leaves nobody signed in and says why (blocked()).
// A fake SDK and a fake data module (its start is slow on some reloads, as reading IndexedDB is) stand in for
// Firebase and the sync module. A failure prints its seed and the run's steps. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { auth } from '../auth.js';

const settle = (ms = 2) => new Promise(r => setTimeout(r, ms));
const UIDS = ['ua', 'ub', 'uc'];
// mulberry32: a small seeded random number generator
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const fakeUser = uid => ({ uid, email: uid + '@example.test', displayName: 'Fake', photoURL: '', emailVerified: true, getIdTokenResult: async () => ({ claims: {} }), getIdToken: async () => 't' });
// Auth keeps its user across reloads (as Firebase does); a sign-in here or in another tab changes it
function fakeSdk() {
  let next = null;
  const auth = { currentUser: null, cbs: new Set(), set(u) { this.currentUser = u; for (const cb of [...this.cbs]) cb(u); } };
  const A = {
    GoogleAuthProvider: class { setCustomParameters() {} },
    async signInWithPopup(a) { a.set(next); },
    async signInWithRedirect() {},
    async getRedirectResult() { return null; },
    onAuthStateChanged(a, cb) { a.cbs.add(cb); cb(a.currentUser); return () => a.cbs.delete(cb); },
    async signOut(a) { a.set(null); },
  };
  return { auth, as(uid) { next = fakeUser(uid); }, sdk: async () => ({ A, auth }) };
}
// stands in for the sync module: rows on the device (kept across reloads, as IndexedDB), the unsent ones in the status
function fakeData(device, slow) {
  return {
    name: 'data', needs: ['auth'],
    async start(ctx) {
      if (slow) await settle(3);
      const tell = () => { const unsent = device.rows.filter(r => !r.sent).length; ctx.status.set({ state: unsent ? 'saving' : 'synced', count: unsent, unsent }); };
      const wipe = () => { device.rows = []; device.wipes++; tell(); };
      tell();
      ctx.on('switch', wipe);
      ctx.on('forget', wipe);
      return {
        save() { const u = ctx.user(); if (!u) return false; device.rows.push({ uid: u.uid, sent: false }); tell(); return true; },
        send() { const u = ctx.user(); if (!u) return; for (const r of device.rows) if (r.uid === u.uid) r.sent = true; tell(); },
      };
    },
    stop() {},
  };
}

async function run(seed) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const kv = new Map(), storage = { getItem: k => kv.has(k) ? kv.get(k) : null, setItem: (k, v) => kv.set(k, String(v)), removeItem: k => kv.delete(k) };
  const sdk = fakeSdk(), device = { rows: [], wipes: 0 };
  const open = (slow = false) => createApp({ config: { name: 'fake-app', storage, sdk: sdk.sdk }, modules: [auth(), fakeData(device, slow)] });
  let app = open();
  await app.ready;
  await settle();
  // the model
  const m = { owner: null, user: null, rows: 0, unsent: 0, wipes: 0, blocked: null };
  // Auth now holds uid (null: nobody); what the module must make of it
  const authSays = uid => {
    if (!uid) { m.user = null; return; }
    if (m.owner && m.owner !== uid) {
      if (m.unsent > 0) { m.user = null; m.blocked = m.owner; return; }
      m.rows = 0; m.unsent = 0; m.wipes++;
    }
    m.owner = uid; m.user = uid; m.blocked = null;
  };
  const log = [], problems = [];
  const check = (step) => {
    const unsent = device.rows.filter(x => !x.sent).length;
    if (device.rows.length !== m.rows) problems.push(`${step}: device has ${device.rows.length} rows, model ${m.rows}`);
    if (unsent !== m.unsent) problems.push(`${step}: device has ${unsent} unsent, model ${m.unsent}`);
    if (device.wipes !== m.wipes) problems.push(`${step}: ${device.wipes} wipes, model ${m.wipes}`);
    if ((app.auth.user()?.uid || null) !== m.user) problems.push(`${step}: user ${app.auth.user()?.uid || null}, model ${m.user}`);
    if ((sdk.auth.currentUser?.uid || null) !== m.user) problems.push(`${step}: Auth has ${sdk.auth.currentUser?.uid || null}, model ${m.user}`);
    const owner = JSON.parse(kv.get('fake-app:auth/owner') || 'null')?.uid || null;
    if (owner !== m.owner) problems.push(`${step}: stored owner ${owner}, model ${m.owner}`);
    if (device.rows.some(x => x.uid !== m.owner)) problems.push(`${step}: rows of another account than ${m.owner}`);
    if (m.blocked && app.auth.blocked()?.from.uid !== m.blocked) problems.push(`${step}: blocked() ${JSON.stringify(app.auth.blocked())}, model from ${m.blocked}`);
  };
  const steps = 8 + Math.floor(r() * 25);
  for (let i = 0; i < steps && !problems.length; i++) {
    const k = r();
    let step;
    if (k < 0.2) {
      const uid = pick(UIDS); step = 'signIn ' + uid;
      sdk.as(uid);
      const res = await app.auth.signIn({ popupOnly: true });
      const refused = !!(m.owner && m.owner !== uid && m.unsent > 0);
      authSays(uid);
      if (res.ok === refused || (refused && (res.reason !== 'unsent' || res.from?.uid !== m.owner))) problems.push(`${step}: answered ${JSON.stringify(res)}`);
    } else if (k < 0.3) {
      const uid = pick(UIDS); step = 'other tab ' + uid;
      sdk.auth.set(fakeUser(uid));
      await settle(); authSays(uid);
    } else if (k < 0.45) {
      step = 'signOut';
      await app.auth.signOut(); authSays(null);
    } else if (k < 0.7) {
      step = 'save';
      const ok = app.data.save();
      if (ok !== !!m.user) problems.push(`${step}: save ${ok} with user ${m.user}`);
      if (ok) { m.rows++; m.unsent++; }
    } else if (k < 0.8) {
      step = 'send';
      app.data.send();
      if (m.user) m.unsent = 0;   // (only one account's rows are ever on the device)
    } else if (k < 0.88) {
      const force = r() < 0.4; step = 'forget' + (force ? ' force' : '');
      const res = await app.auth.forget({ force });
      if (!force && m.unsent > 0) { if (res.ok || res.reason !== 'unsent') problems.push(`${step}: answered ${JSON.stringify(res)}`); }
      else { m.rows = 0; m.unsent = 0; m.wipes++; m.owner = null; m.user = null; m.blocked = null; if (!res.ok) problems.push(`${step}: answered ${JSON.stringify(res)}`); }
    } else {
      const slow = r() < 0.5, other = r() < 0.3 ? pick(UIDS) : '';
      step = 'reload' + (slow ? ' (slow data)' : '') + (other ? ', ' + other + ' signed in meanwhile' : '');
      await app.stop();
      if (other) sdk.auth.currentUser = fakeUser(other);   // (another tab, while this page was closed)
      app = open(slow);
      await app.ready;
      await settle(8);
      m.blocked = null;   // (blocked() is the page's: a reload forgets it)
      authSays(sdk.auth.currentUser?.uid || null);
    }
    log.push(step);
    check(step);
  }
  await app.stop();
  return { problems, log };
}

const one = process.env.MODEL_SEED ? [Number(process.env.MODEL_SEED)] : null;
const count = Number(process.env.MODEL_SEEDS) || 40;
const start = Number(process.env.MODEL_START) || 1000;
const seeds = one || Array.from({ length: count }, (_, i) => start + i);

test(`auth model: ${seeds.length} seeded runs of sign-in, sign-out, switch, forget and reload keep the data the model says`, { timeout: 600e3 }, async () => {
  const failed = [];
  for (const seed of seeds) {
    const { problems, log } = await run(seed);
    if (problems.length) {
      failed.push(seed);
      console.log(`seed ${seed} failed (replay: MODEL_SEED=${seed} node --test test/auth.model.test.mjs)\n  steps: ${log.join('; ')}\n  ${problems.join('\n  ')}`);
    }
  }
  assert.deepEqual(failed, [], 'failing seeds: ' + failed.join(', '));
});
