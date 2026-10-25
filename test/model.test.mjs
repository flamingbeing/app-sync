// Run with: node --test test/model.test.mjs     (one seed: MODEL_SEED=123; more seeds: MODEL_SEEDS=500)
// Model-based multi-device tests: for each seed, a random run of saves, deletes, going offline and back, wakes and
// reloads on two or three devices (createApp, the real Firestore adapter on a fake SDK, clocks a few minutes apart),
// then everything back online and checked against a simple model of what must be true:
//  - every device shows the server's records (a record with a save the user must look at, a conflict or a refusal,
//    shows that save instead);
//  - in the merge collection each device owns one field, so the server must hold each device's last value for it;
//  - nothing is still waiting, except a later save of a record held for the user (it waits behind that one).
// A failure prints its seed and the run's steps, so it can be replayed. The steps are fixed by the seed; timer order
// can still differ a little between runs. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createFirestoreBackend } from '../src/firestore.js';
import { fakeServer } from './fake-server.mjs';
import { memOutbox, sharedSdk } from './fake-sdk.mjs';

const S = 'fake-space';
const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) return false; await settle(10); } return true; };
const unavailable = () => Object.assign(new Error('offline'), { code: 'unavailable' });
const BACKOFF = new Set([2000, 4000, 8000, 16000, 32000, 60000]);
const quick = ms => settle(ms === 180 ? 5 : BACKOFF.has(ms) ? 10 : ms);
const content = d => { if (!d) return null; const { updatedAt, serverAt, _saves, _edits, ...rest } = d; return rest; };
const sig = d => JSON.stringify(content(d), Object.keys(content(d) || {}).sort());
// mulberry32: a small seeded random number generator
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// one device: its own clock, network switch, device copy and outbox; the listener and the adapter go quiet offline
function device(name, shared, srv, clock, { held = false } = {}) {
  const dev = { name, online: true, views: { notes: [], tasks: [] }, saves: [], app: null, offs: [], subs: new Set() };
  const outbox = memOutbox();
  const nav = { get onLine() { return dev.online; }, storage: { persisted: async () => true, persist: async () => true } };
  const user = { uid: 'u-' + name, email: 'fake@example.test', displayName: 'Fake', getIdTokenResult: async () => ({ claims: {} }), getIdToken: async () => 't' };
  const auth = { currentUser: user };
  const A = { onAuthStateChanged: (_a, cb) => { cb(auth.currentUser); return () => {}; }, signOut: async () => {}, GoogleAuthProvider: class {} };
  const sdkDev = shared.device({ clock, name });
  // held (0.6.3): tasks saved with held conflicts by field, who changed what recorded in _edits
  const heldOptions = held ? { held: { tasks: true }, edits: '_edits' } : {};
  const backend = createFirestoreBackend({ sdk: sdkDev.sdk, path: (s, c) => ['spaces', s, c], merge: { notes: true }, mark: '_saves', ...heldOptions, editor: () => ({ by: 'Fake', device: name }),
    // a deleted task leaves a bin entry in the same transaction (the delete reaches devices that were offline)
    onCommit: ({ coll, before, after, at }) => coll === 'tasks' && before && !after ? [{ path: ['spaces', S, 'bin', 'task:' + before.id], data: { id: 'task:' + before.id, kind: 'task', data: before, deletedAt: at } }] : [] });
  // the listener: a subscription that stops offline and listens again (resumes) back online
  const listen = (scope, coll, opts, onSnap, onError) => {
    const sub = { args: [scope, coll, opts, onSnap, onError], off: null };
    sub.off = dev.online ? srv.listen(scope, coll, opts, onSnap, onError) : null;
    dev.subs.add(sub);
    return () => { sub.off?.(); sub.off = null; dev.subs.delete(sub); };
  };
  const adapter = {
    listen, clearCache: async () => {},
    fetchOne: async (s, c, id) => { if (!dev.online) throw unavailable(); return srv.fetchOne(s, c, id); },
    commit: async (...a) => { if (!dev.online) throw unavailable(); return backend.commit(...a); },
  };
  dev.start = async () => {
    dev.app = createApp({ name: 'model-' + name, colls: ['notes', 'tasks'], kinds: { note: 'notes', task: 'tasks' }, path: (s, c) => ['spaces', s, c],
      sdk: async () => ({ A, F: {}, auth, db: {}, emulator: true }), adapter, outbox, nav, storage: null, win: null, device: name,
      ...(held ? { backend: { mark: '_saves', ...heldOptions } } : {}), now: () => Date.now() + clock, watchEvery: 0, queue: { delay: quick }, hub: { grace: 0, binKinds: { task: 'tasks' } } });
    await dev.app.open(S);
    dev.offs = ['notes', 'tasks'].map(c => dev.app.watch(S, c, list => { dev.views[c] = list; }));
  };
  dev.stop = async () => { for (const off of dev.offs) off(); await dev.app.hub.stopAll(); };
  dev.goOffline = () => { dev.online = false; for (const s of dev.subs) { s.off?.(); s.off = null; } };
  dev.goOnline = () => { dev.online = true; for (const s of dev.subs) if (!s.off) s.off = srv.listen(...s.args); dev.app.queue.kick(); };
  dev.shown = (coll, id) => dev.views[coll].find(r => r.id === id) || null;
  return dev;
}

async function run(seed, { steps = 30, held = false } = {}) {
  const r = rng(seed), pick = xs => xs[Math.floor(r() * xs.length)];
  const srv = fakeServer(), shared = sharedSdk({ srv });
  const n = 2 + Math.floor(r() * 2);
  const notes = ['n1', 'n2'], tasks = ['t1', 't2', 't3'];
  const devs = Array.from({ length: n }, (_, i) => device('d' + i, shared, srv, Math.round((r() - 0.5) * 4 * 60e3), { held }));
  // the records every device starts from (on the server before anyone opens)
  for (const id of notes) shared.meddle(`spaces/${S}/notes/${id}`, { id, updatedAt: 1 });
  for (const id of tasks) shared.meddle(`spaces/${S}/tasks/${id}`, { id, text: 'Fake task ' + id, done: false, updatedAt: 1 });
  for (const d of devs) await d.start();
  await settle(30);
  const log = [], deleted = new Set();
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const d = pick(devs), x = r();
    if (x < 0.3) {
      // a note: only this device's field changes (its own last value must win on the server)
      const id = pick(notes), base = d.shown('notes', id);
      if (!base) { log.push(`${d.name} note ${id}: not shown`); continue; }
      const rec = { ...content(base), id, [d.name]: ++v };
      log.push(`${d.name} save note ${id} ${d.name}=${v}`);
      d.saves.push({ coll: 'notes', id, field: d.name, value: v });
      void d.app.save('note', S, rec, content(base)).catch(() => {});
    } else if (x < 0.55) {
      const id = pick(tasks), base = d.shown('tasks', id);
      if (!base) { log.push(`${d.name} task ${id}: not shown`); continue; }
      const del = !deleted.has(id) && r() < 0.15;
      const rec = del ? { ...content(base), _deleted: true } : { ...content(base), text: 'Fake text ' + (++v), done: r() < 0.5 };
      if (del) deleted.add(id);
      log.push(`${d.name} ${del ? 'delete' : 'save'} task ${id}${del ? '' : ' ' + rec.text + ' done=' + rec.done}`);
      void d.app.save('task', S, rec, content(base)).catch(() => {});
    } else if (x < 0.68) { log.push(`${d.name} offline`); d.goOffline(); }
    else if (x < 0.8) { log.push(`${d.name} online`); d.goOnline(); }
    else if (x < 0.87) { log.push(`${d.name} wake`); d.app.hub.replan(); d.app.nudge('wake'); }
    else if (x < 0.92) {
      log.push(`${d.name} reload`);
      await d.stop(); await d.start();
    } else { const ms = Math.floor(r() * 60); log.push(`wait ${ms} ms`); await settle(ms); }
    await settle(Math.floor(r() * 8));
  }
  // everyone back online, everything sent
  for (const d of devs) if (!d.online) d.goOnline();
  for (const d of devs) await d.app.flush(3000);
  const problems = [];
  // held: every held save is answered in its popup (only the phone that holds it has one), mine or theirs at random,
  // until none is left; an answer of mine that lands puts this phone's values of the clashing fields on the server
  if (held) {
    for (let round = 0; round < 6; round++) {
      let any = false;
      for (const d of devs) {
        for (const c of d.app.conflicts()) {
          any = true;
          const desc = d.app.describe(c.key), choice = r() < 0.5 ? 'mine' : 'theirs';
          log.push(`${d.name} answers ${c.kind} ${c.id} ${choice} (${desc.fields.map(f => f.path).join(',') || 'whole record'})`);
          try { await d.app.resolve(c.key, choice); } catch (e) { if (!/elsewhere|kept in/.test(e.message)) problems.push(`${d.name} answer ${c.id}: ${e.message}`); }
          await d.app.flush(3000);
          if (choice !== 'mine' || d.app.queue.status(c.kind, c.id) !== 'synced') continue;
          const doc = shared.docs.get(`spaces/${S}/${c.kind}s/${c.id}`) || null;
          if (desc.deleted.mine ? doc : !doc) problems.push(`${d.name} chose its version of ${c.id}, server ${doc ? 'has' : 'lacks'} it`);
          for (const f of desc.fields) if (doc && JSON.stringify(doc[f.path]) !== JSON.stringify(f.mine.value)) problems.push(`${d.name} chose ${c.id}.${f.path}=${JSON.stringify(f.mine.value)}, server ${JSON.stringify(doc[f.path])}`);
        }
      }
      if (!any) break;
      for (const d of devs) await d.app.flush(3000);
    }
    for (const d of devs) if (d.app.conflicts().length) problems.push(`${d.name} still holds ${d.app.conflicts().length} save(s) after answering`);
  }
  const attention = d => new Set(d.app.queue.entries().filter(e => e.state === 'conflict' || e.state === 'failed').map(e => e.kind + 's:' + e.record.id));
  const server = coll => [...shared.docs].filter(([p]) => p.startsWith(`spaces/${S}/${coll}/`)).map(([, doc]) => doc);
  const agreed = () => devs.every(d => ['notes', 'tasks'].every(coll => {
    const held = attention(d), want = server(coll).filter(x => !held.has(coll + ':' + x.id));
    const shown = d.views[coll].filter(x => !held.has(coll + ':' + x.id));
    return want.length === shown.length && want.every(x => shown.some(y => y.id === x.id && sig(y) === sig(x)));
  }));
  await until(agreed, 3000);
  for (const d of devs) {
    const held = attention(d);
    for (const coll of ['notes', 'tasks']) {
      const want = server(coll).filter(x => !held.has(coll + ':' + x.id)), shown = d.views[coll].filter(x => !held.has(coll + ':' + x.id));
      for (const x of want) { const y = shown.find(s => s.id === x.id); if (!y || sig(y) !== sig(x)) problems.push(`${d.name} shows ${coll}/${x.id} ${y ? sig(y) : 'missing'}, server ${sig(x)}`); }
      for (const y of shown) if (!want.some(x => x.id === y.id)) problems.push(`${d.name} shows ${coll}/${y.id}, gone on the server`);
    }
    // (a later save of a record held for the user waits behind it, by design)
    for (const e of d.app.queue.entries()) if ((e.state === 'pending' || e.state === 'sending') && !held.has(e.kind + 's:' + e.record.id)) problems.push(`${d.name} save ${e.kind} ${e.record.id} still ${e.state}${process.env.MODEL_DEBUG ? ' ' + JSON.stringify(e) : ''}`);
    if (process.env.MODEL_DEBUG) problems.push(`${d.name} entries ${JSON.stringify(d.app.queue.entries().map(e => [e.kind, e.record.id, e.state, e.record._deleted || false, e.error || '']))}`);
    // the merge collection: this device's last value of its own field is on the server, unless that save is held
    const last = new Map();
    for (const s of d.saves) last.set(s.id, s.value);
    for (const [id, value] of last) {
      if (held.has('notes:' + id)) continue;
      const doc = shared.docs.get(`spaces/${S}/notes/${id}`);
      if (doc?.[d.name] !== value) problems.push(`${d.name}'s last note ${id} value ${value} lost (server ${doc?.[d.name]})`);
    }
  }
  for (const d of devs) await d.stop();
  return { problems, log, n };
}

const one = process.env.MODEL_SEED ? [Number(process.env.MODEL_SEED)] : null;
const count = Number(process.env.MODEL_SEEDS) || 40;
const seeds = one || Array.from({ length: count }, (_, i) => 1000 + i);

for (const held of [false, true]) test(`model${held ? ' (held conflicts, 0.6.3)' : ''}: ${seeds.length} seeded runs of two or three devices agree with the model`, { timeout: 600e3 }, async () => {
  const failed = [];
  for (const seed of seeds) {
    const { problems, log, n } = await run(seed, { held });
    if (problems.length) {
      failed.push(seed);
      console.log(`seed ${seed}${held ? ' (held)' : ''} failed (${n} devices; replay: MODEL_SEED=${seed} node --test test/model.test.mjs)\n  steps: ${log.join('; ')}\n  ${problems.join('\n  ')}`);
    }
  }
  assert.deepEqual(failed, [], 'failing seeds: ' + failed.join(', '));
});
