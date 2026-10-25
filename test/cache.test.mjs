// Run with: node --test test/cache.test.mjs     (more seeds: MODEL_SEEDS=500, as in model.test.mjs)
// The Firestore cache helper (src/cache.js) on a fake of the SDK's cache calls. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firestoreCache, cacheFailure, CACHE_KEY } from '../src/cache.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const memStore = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const err = (message, code) => Object.assign(new Error(message), code ? { code } : {});
// the SDK's calls; `break` lists the cache kinds whose creation (or initializeFirestore) throws
const sdk = ({ breakAt = [], initBreak = [] } = {}) => ({
  persistentMultipleTabManager: () => ({ tab: 'multi' }),
  persistentSingleTabManager: () => ({ tab: 'single' }),
  persistentLocalCache: o => { if (breakAt.includes(o.tabManager.tab)) throw err('IndexedDB is not available'); return { kind: o.tabManager.tab }; },
  memoryLocalCache: () => ({ kind: 'memory' }),
  initializeFirestore: (app, s) => { if (initBreak.includes(s.localCache.kind)) throw err('INTERNAL ASSERTION FAILED: Unexpected state (ID: ca9)', 'failed-precondition'); return { app, settings: s }; },
});
const rep = () => ({ codes: [], error(c) { this.codes.push(c); } });

test('multi-tab first, db built with the cache and the app settings', () => {
  const r = rep(), c = firestoreCache(sdk(), { app: 'A', settings: { ignoreUndefinedProperties: true }, report: r, storage: memStore() });
  assert.equal(c.mode, 'multi'); assert.equal(c.db.settings.localCache.kind, 'multi'); assert.equal(c.db.settings.ignoreUndefinedProperties, true);
  assert.deepEqual(r.codes, []);
});

test('without app: only the cache object, nothing initialised', () => {
  const c = firestoreCache(sdk(), { storage: memStore() });
  assert.equal(c.db, undefined); assert.equal(c.cache.kind, 'multi');
});

test('cacheFailure: quota and Unexpected state only', () => {
  assert.equal(cacheFailure(err('x', 'resource-exhausted')), 'quota');
  assert.equal(cacheFailure(Object.assign(new Error('full'), { name: 'QuotaExceededError' })), 'quota');
  assert.equal(cacheFailure(err('INTERNAL ASSERTION FAILED: Unexpected state (ID: b815)')), 'state');
  assert.equal(cacheFailure(err('offline', 'unavailable')), null);
  assert.equal(cacheFailure(null), null);
});

test('failed(): steps down one at a time, remembers, reports; other errors change nothing', () => {
  const store = memStore(), r = rep();
  let c = firestoreCache(sdk(), { app: 'A', report: r, storage: store });
  assert.deepEqual(c.failed(err('offline', 'unavailable')), { changed: false, mode: 'multi', code: null });
  assert.equal(store.m.has(CACHE_KEY), false);
  assert.deepEqual(c.failed(err('Unexpected state')), { changed: true, mode: 'single', code: 'cache-state' });
  assert.equal(store.getItem(CACHE_KEY), 'single');
  c = firestoreCache(sdk(), { app: 'A', report: r, storage: store });
  assert.equal(c.mode, 'single');
  assert.deepEqual(c.failed(err('full', 'resource-exhausted')), { changed: true, mode: 'memory', code: 'cache-quota' });
  c = firestoreCache(sdk(), { app: 'A', report: r, storage: store });
  assert.equal(c.mode, 'memory'); assert.equal(c.cache.kind, 'memory');
  assert.equal(c.failed(err('full', 'resource-exhausted')).changed, false, 'memory is the floor');
  assert.deepEqual(r.codes, ['cache-state', 'cache-single', 'cache-quota', 'cache-memory', 'cache-quota']);
  c.reset(); assert.equal(firestoreCache(sdk(), { storage: store }).mode, 'multi');
});

test('a step that cannot start falls through at once, and is remembered', () => {
  const store = memStore(), r = rep();
  const c = firestoreCache(sdk({ breakAt: ['multi'], initBreak: ['single'] }), { app: 'A', report: r, storage: store });
  assert.equal(c.mode, 'memory'); assert.equal(store.getItem(CACHE_KEY), 'memory');
  assert.deepEqual(r.codes, ['cache-single', 'cache-memory']);
});

test('an initializeFirestore "already initialised" mistake is not swallowed', () => {
  const F = sdk(); F.initializeFirestore = () => { throw err('Firestore has already been started with different settings'); };
  assert.throws(() => firestoreCache(F, { app: 'A', storage: memStore() }), /already been started/);
});

test('no storage and a throwing storage: works, remembers nothing, report errors do not escape', () => {
  assert.equal(firestoreCache(sdk(), { storage: null }).mode, 'multi');
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const c = firestoreCache(sdk(), { storage: bad, report: { error() { throw new Error('x'); } } });
  assert.equal(c.failed(err('Unexpected state')).mode, 'single');
});

// seeded: random loads and errors; the step only goes down (until reset), the stored step is what the next load runs
const seeds = Number(process.env.MODEL_SEEDS) || 40;
for (let seed = 1; seed <= seeds; seed++) {
  test(`seed ${seed}: the step never rises without reset`, () => {
    const rand = rng(seed), store = memStore(), order = ['multi', 'single', 'memory'];
    let floor = 0;
    for (let load = 0; load < 12; load++) {
      const c = firestoreCache(sdk({ breakAt: rand() < 0.15 ? ['multi'] : [] }), { app: 'A', storage: store });
      assert.ok(order.indexOf(c.mode) >= floor, 'never above the remembered step');
      floor = order.indexOf(c.mode);
      for (let k = Math.floor(rand() * 3); k > 0; k--) {
        const e = [err('offline', 'unavailable'), err('Unexpected state'), err('full', 'resource-exhausted')][Math.floor(rand() * 3)];
        const before = c.mode, out = c.failed(e);
        if (!cacheFailure(e)) assert.equal(out.changed, false);
        else if (before !== 'memory') { assert.equal(out.mode, order[order.indexOf(before) + 1]); floor = Math.max(floor, order.indexOf(out.mode)); }
      }
      if (rand() < 0.05) { c.reset(); floor = 0; }
    }
  });
}
