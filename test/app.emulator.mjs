// createApp (src/app.js) end to end against the local Auth and Firestore emulators (demo project: nothing reaches a
// real Firebase project): sign in, save offline, come back online and sync, then sign out and wipe the device.
// Run with: npm run test:emulator (needs Java). Made-up data only.
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase/app';
import * as A from 'firebase/auth';
import * as F from 'firebase/firestore';
import { createApp } from '../src/app.js';

const FS = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await settle(50); }
  return false;
}
// node has no IndexedDB or localStorage: the outbox in memory, shaped like createOutbox's
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
function sdkFor(name) {
  const fb = initializeApp({ projectId: 'demo-app-sync', apiKey: 'fake-key', authDomain: 'localhost' }, name);
  const auth = A.getAuth(fb);
  A.connectAuthEmulator(auth, 'http://' + AUTH, { disableWarnings: true });
  const db = F.getFirestore(fb);
  F.connectFirestoreEmulator(db, FS[0], Number(FS[1]));
  return { A, F, auth, db, emulator: true };
}

const space = 'app-' + Date.now().toString(36);
const parts = sdkFor('app-e2e'), other = sdkFor('app-e2e-other');
const nav = { onLine: true, storage: { persisted: async () => true } };
const outbox = memOutbox('e2e-outbox');
const app = createApp({
  name: 'e2e', colls: ['items'], path: (s, coll) => ['spaces', s, coll], sdk: async () => parts,
  scope: () => space, nav, outbox, storage: null, watchEvery: 0, win: null,
});

// ---- sign in (the emulator's Google credential: no popup in node); the scope opens at sign-in ----
const seen = [];
await app.onUser(u => seen.push(u));
await A.signInWithCredential(parts.auth, A.GoogleAuthProvider.credential(JSON.stringify({ sub: 'fakeperson', email: 'Fake.Person@example.test', email_verified: true })));
assert.ok(await until(() => seen.at(-1)?.email === 'fake.person@example.test'), 'signed in');
assert.equal(app.user().email, 'fake.person@example.test');
const states = [];
app.status$(st => states.push(st.state));
let list = [];
app.watch(space, 'items', l => { list = l; });
assert.ok(await until(() => states.at(-1) === 'synced'), 'synced once the server answered: ' + states.join());

// ---- save offline: kept on this device, shown at once, the status says offline ----
nav.onLine = false;
await F.disableNetwork(parts.db);
await app.save('items', space, { id: 'i1', text: 'Fake offline' });
assert.ok(await until(() => list.some(d => d.id === 'i1' && d.text === 'Fake offline')), 'shown at once');
assert.ok(await until(() => states.at(-1) === 'offline'), 'offline: ' + states.join());
assert.equal((await app.signOut({ wait: 300 })).reason, 'unsent', 'sign-out refuses while it is unsent');
assert.equal(outbox.records.size, 1);

// ---- back online: sent, on the server, synced ----
await F.enableNetwork(parts.db);
nav.onLine = true;
app.queue.kick();
assert.equal(await app.flush(8000), true, 'sent');
const onServer = await F.getDocFromServer(F.doc(other.db, 'spaces', space, 'items', 'i1'));
assert.equal(onServer.data().text, 'Fake offline');
assert.equal(typeof onServer.data().updatedAt, 'number', 'stamped by the adapter');
assert.ok(await until(() => states.at(-1) === 'synced'), 'synced again: ' + states.join());

// ---- sign out: the device copy and the outbox are gone, and the account is signed out ----
const out = await app.signOut();
assert.equal(out.ok, true, JSON.stringify(out));
assert.equal(out.reload, false, 'the emulator keeps its cache');
assert.equal(parts.auth.currentUser, null);
assert.equal(app.user(), null);
assert.equal([...outbox.records.values()].filter(x => x.owner === space).length, 0, 'outbox forgotten');
const st = await app.parts.stores.openStore(space);
assert.equal((await st.load('items')).docs.length, 0, 'device copy wiped');

await F.terminate(parts.db); await F.terminate(other.db);
console.log('createApp emulator: sign-in, offline save, sync, sign-out wipe: ok');
process.exit(0);
