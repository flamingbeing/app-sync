// The engine's hot paths, timed in node (made-up data): the first load of N records, delta snapshots applied to a
// list of N, and a burst of saves while a list of N is watched (each save's queue changes hand the list again).
// Device copy in memory (node has no IndexedDB), listener and server faked, so this times the engine's own work.
//   node tools/bench.mjs [--n 1000,10000] [--deltas 200] [--saves 200] [--json]
import { createSyncHub } from '../src/sync.js';
import { createStores } from '../src/store.js';
import { createWriteQueue, watchSaved } from '../src/writes.js';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const SIZES = String(arg('n', '1000,10000')).split(',').map(Number);
const DELTAS = Number(arg('deltas', 200)), SAVES = Number(arg('saves', 200));
const tick = () => new Promise(r => setImmediate(r));
const ms = t => Math.round((performance.now() - t) * 10) / 10;

// a record like an app's: a few short fields and a longer note
const record = (i, at) => ({ id: 'r' + i, title: 'Item ' + i, kind: i % 3 ? 'task' : 'note', done: i % 2 === 0, tags: ['a', 'b' + (i % 7)], note: 'x'.repeat(120), n: i, updatedAt: at });

function memOutbox() {
  const records = new Map(), clone = x => structuredClone(x);
  return {
    async put(x) { records.set(x.key, clone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(clone); },
    async get(k) { return records.has(k) ? clone(records.get(k)) : null; }, async remove(k) { records.delete(k); },
    async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); },
  };
}

async function setup(n, run) {
  const now = Date.now(), server = new Map();
  for (let i = 0; i < n; i++) server.set('r' + i, record(i, now - 1000 + (i % 500)));
  /** @type {((s: any) => void) | null} */
  let snap = null;
  const listen = (_scope, _coll, _plan, onSnap) => { snap = onSnap; queueMicrotask(() => onSnap({ full: true, fromCache: false, hasPendingWrites: false, changes: [], docs: [...server.values()].map(d => ({ ...d })) })); return () => { snap = null; }; };
  const { openStore } = createStores({ prefix: 'bench' + run + ':', colls: ['items'] });
  const hub = createSyncHub({ openStore, listen, bin: null, grace: 0 });
  const owner = 'a@example.com';
  const queue = createWriteQueue({ store: memOutbox(), getOwner: () => owner, delay: () => tick(), backend: async (_o, _k, rec) => ({ ...rec, updatedAt: Date.now() }) });
  await queue.activate(owner);
  return { hub, queue, owner, server, snap: s => snap && snap(s) };
}

async function bench(n, run) {
  const out = { n };
  // 1. first load: the listener's full snapshot to the watcher's first list of n
  let t = performance.now(), got = 0, calls = 0;
  const env = await setup(n, run);
  let resolve; const loaded = new Promise(r => { resolve = r; });
  const stop = watchSaved({ hub: env.hub, queue: env.queue, scope: env.owner, coll: 'items', kind: 'items' }, list => { calls++; got = list.length; if (got === n) resolve(); });
  await loaded;
  out.loadMs = ms(t);
  // 2. delta snapshots: one record changed in each
  t = performance.now();
  for (let i = 0; i < DELTAS; i++) {
    const d = { ...env.server.get('r' + (i % n)), title: 'changed ' + i, updatedAt: Date.now() + i };
    env.snap({ fromCache: false, hasPendingWrites: false, changes: [{ type: 'modified', id: d.id, doc: d }] });
  }
  await env.hub.flush();
  out.deltaMs = Math.round(ms(t) / DELTAS * 100) / 100;
  // 3. a burst of saves (each one's queue changes hand the watched list again), until all are sent
  t = performance.now(); calls = 0;
  await Promise.all(Array.from({ length: SAVES }, (_, i) => env.queue.save('items', env.owner, { ...env.server.get('r' + i), title: 'saved ' + i })));
  while (env.queue.pending()) await tick();
  out.savesMs = ms(t); out.savesHands = calls;
  stop(); await env.hub.stopAll();
  return out;
}

const results = [];
let run = 0;
for (const n of SIZES) results.push(await bench(n, run++));
if (process.argv.includes('--json')) console.log(JSON.stringify(results));
else for (const r of results) console.log(`n=${r.n}: first load ${r.loadMs} ms, delta ${r.deltaMs} ms each (${DELTAS}), ${SAVES} saves ${r.savesMs} ms (${r.savesHands} lists handed)`);
