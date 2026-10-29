// Fakes shared by the fault and model tests: an in-memory outbox and a small fake of the modular Firestore SDK on one
// shared set of documents, as several devices see it. Made-up data only.
import { AsyncLocalStorage } from 'node:async_hooks';

const clone = x => structuredClone(x);
// A device's clock while its transaction function runs: Date.now() reads the real time plus the offset of the
// transaction it is called from. (It used to be swapped and put back around each transaction: two devices'
// transactions overlapping put back the wrong one, so the shared clock drifted by minutes per model run, and flush
// and settle deadlines read it.)
const offset = new AsyncLocalStorage();
/** @type {(() => number) | null} */
let wrapped = null;
/** @template T @param {number} clock @param {() => Promise<T>} fn @returns {Promise<T>} */
const onClock = (clock, fn) => {
  if (Date.now !== wrapped) { const outer = Date.now; wrapped = () => outer() + (offset.getStore() || 0); Date.now = wrapped; }
  return offset.run(clock, fn);
};
const err = (code, message = code) => Object.assign(new Error(message), { code });

// the write queue's outbox, in memory (one device; two queues on it share it like two tabs)
export function memOutbox() {
  const records = new Map();
  return {
    records,
    async put(x) { records.set(x.key, clone(x)); },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(clone); },
    async get(k) { return records.has(k) ? clone(records.get(k)) : null; },
    async remove(k) { records.delete(k); },
    async forget(o) { for (const [k, x] of records) if (x.owner === o) records.delete(k); },
  };
}

// The modular SDK on one shared set of documents, as several devices see it. A transaction reads, runs the app's
// function, and commits only if nothing it read has changed since (else it runs again, up to `attempts`, then throws
// aborted, as Firestore does). faults: codes thrown by the next transactions before they run (a dropped connection,
// a lost race); lostAck: codes thrown after the next transactions committed (the answer never came back). clock:
// this device's offset from the real time while its transaction function runs.
export function sharedSdk({ srv = null, attempts = 5 } = {}) {
  const docs = new Map(), versions = new Map(), commits = [];
  const faults = [], lostAck = [];
  const mirror = (path, data) => {
    if (!srv) return;
    const parts = path.split('/'), coll = parts.at(-2), id = parts.at(-1);
    if (data) srv.set(coll, { ...data, id }); else srv.del(coll, id);
  };
  const device = ({ clock = 0, name = 'device' } = {}) => {
    const db = { name };
    const F = {
      collection: (_db, ...segs) => ({ path: segs.join('/') }),
      doc: (parent, ...segs) => {
        const path = parent === db ? segs.join('/') : parent.path + '/' + segs.join('/');
        return { path, id: path.split('/').at(-1) };
      },
      serverTimestamp: () => ({ serverTimestamp: true }),
      async runTransaction(_db, fn) {
        if (faults.length) throw err(faults.shift());
        for (let n = 1; ; n++) {
          const read = new Map(), writes = [];
          const tx = {
            async get(ref) { read.set(ref.path, versions.get(ref.path) || 0); const d = docs.get(ref.path); return { id: ref.id, exists: () => !!d, data: () => clone(d) }; },
            set(ref, data) { writes.push({ path: ref.path, data: clone(data) }); return tx; },
            delete(ref) { writes.push({ path: ref.path, delete: true }); return tx; },
          };
          const out = await onClock(clock, () => fn(tx));
          // another device committed to what this one read: run again, or give up as aborted
          if ([...read].some(([p, v]) => (versions.get(p) || 0) !== v)) { if (n >= attempts) throw err('aborted', 'Transaction lost the race'); continue; }
          for (const w of writes) {
            versions.set(w.path, (versions.get(w.path) || 0) + 1);
            if (w.delete) docs.delete(w.path); else docs.set(w.path, w.data);
          }
          if (writes.length) commits.push({ device: name, writes });
          for (const w of writes) mirror(w.path, w.delete ? null : w.data);
          if (lostAck.length) throw err(lostAck.shift());
          return out;
        }
      },
      async terminate() {}, async clearIndexedDbPersistence() {},
    };
    return { db, F, sdk: async () => ({ db, F }) };
  };
  // a write another device makes between this one's read and its commit (the race a transaction can lose)
  const meddle = (path, data) => { versions.set(path, (versions.get(path) || 0) + 1); docs.set(path, clone(data)); mirror(path, data); };
  return { docs, commits, faults, lostAck, device, meddle };
}
