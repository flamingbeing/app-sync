// register.js in a fake page world: navigator.serviceWorker, window, document, location, sessionStorage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let n = 0;
const tick = () => new Promise(r => setTimeout(r, 0));
const target = () => {
  const l = {};
  return { l, addEventListener: (t, f) => { (l[t] ||= []).push(f); }, fire: async (t, e = {}) => { for (const f of l[t] || []) await f(e); await tick(); } };
};
async function world({ controller = true } = {}) {
  const sw = target(), win = target(), doc = target(), regT = target();
  const posted = [];
  const waiting = { postMessage: m => posted.push(m) };
  const reg = { ...regT, waiting: null, updates: 0, update: async () => { reg.updates++; }, unregister: async () => { reg.gone = true; } };
  const page = { reloads: 0, posted, reg, waiting, sw, win, doc };
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  sw.controller = controller ? {} : null;
  sw.getRegistration = async () => (controller ? { active: {} } : undefined);
  sw.register = async () => reg;
  const ss = new Map();
  set('navigator', { serviceWorker: sw });
  set('window', win);
  set('document', { ...doc, visibilityState: 'visible' });
  page.doc = globalThis.document;
  set('location', { href: 'https://app.test/app/', reload: () => { page.reloads++; } });
  set('sessionStorage', { getItem: k => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) });
  set('setInterval', () => 0);
  page.mod = await import(`../register.js?w=${n++}`);
  return page;
}

test('without canReload a take-over reloads once, as in 0.1.0', async () => {
  const p = await world();
  await p.mod.register({ app: 'demo' });
  await p.sw.fire('controllerchange'); await p.sw.fire('controllerchange');
  assert.equal(p.reloads, 1);
});

test('canReload false defers the reload; visibility, pagehide or retryUpdate try again', async () => {
  const p = await world();
  let ok = false, before = 0;
  await p.mod.register({ app: 'demo', canReload: () => ok, beforeReload: async () => { before++; throw new Error('ignored'); } });
  await p.sw.fire('controllerchange');
  assert.equal(p.reloads, 0);
  await p.doc.fire('visibilitychange'); await p.win.fire('pagehide');
  assert.equal(p.reloads, 0);
  ok = true;
  await p.mod.retryUpdate();
  assert.equal(p.reloads, 1);
  assert.equal(before, 1);
  await p.win.fire('pagehide');
  assert.equal(p.reloads, 1);
});

test('canReload is retried on pagehide, and a throwing canReload counts as no', async () => {
  const p = await world();
  let mode = 'throw';
  await p.mod.register({ app: 'demo', canReload: async () => { if (mode === 'throw') throw new Error('x'); return true; } });
  await p.sw.fire('controllerchange');
  assert.equal(p.reloads, 0);
  mode = 'yes';
  await p.win.fire('pagehide');
  assert.equal(p.reloads, 1);
});

test('a waiting worker gets update:go only when canReload allows', async () => {
  const p = await world();
  let ok = false;
  p.reg.waiting = p.waiting;
  await p.mod.register({ app: 'demo', canReload: () => ok });
  assert.deepEqual(p.posted, []);
  ok = true;
  await p.doc.fire('visibilitychange');
  assert.deepEqual(p.posted, [{ type: 'update:go' }]);
});

test('a worker that finishes installing later is offered the go', async () => {
  const p = await world();
  await p.mod.register({ app: 'demo', canReload: () => true });
  const inst = { ...target(), state: 'installing' };
  p.reg.installing = inst;
  await p.reg.fire('updatefound');
  inst.state = 'installed'; p.reg.waiting = p.waiting;
  await inst.fire('statechange');
  assert.deepEqual(p.posted, [{ type: 'update:go' }]);
});

test('coming back online checks for an update', async () => {
  const p = await world();
  await p.mod.register({ app: 'demo' });
  await p.win.fire('online');
  assert.equal(p.reg.updates, 1);
});

test('forceLatest refuses while canReload says no, before touching anything', async () => {
  const p = await world();
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true }; };
  Object.defineProperty(globalThis, 'caches', { value: { keys: async () => [], delete: async () => true }, configurable: true, writable: true });
  await p.mod.register({ app: 'demo', canReload: () => false });
  await assert.rejects(p.mod.forceLatest(), /still sending/);
  await assert.rejects(p.mod.forceLatest({ canReload: () => false }), /still sending/);
  assert.equal(fetched, 0); assert.ok(!p.reg.gone); assert.equal(p.reloads, 0);
  await p.mod.forceLatest({ canReload: () => true });
  assert.ok(p.reg.gone); assert.equal(p.reloads, 1);
  // 1.0.0-rc.1: one version for both: the update core's is the engine's
  assert.equal(p.mod.CORE_VERSION, JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
});
