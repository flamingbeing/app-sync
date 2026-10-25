// The update module (0.9.1, update.js) on the module runner: register.js passed in (a fake here), the reload that
// waits for unsent saves, retryOn, checkNow. A fake navigator.serviceWorker and registration. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { update } from '../update.js';

const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
const target = () => {
  const l = {};
  return { l, addEventListener: (t, f) => { (l[t] ||= new Set()).add(f); }, removeEventListener: (t, f) => { l[t]?.delete(f); }, fire: t => { for (const f of [...(l[t] || [])]) f({}); } };
};
// register.js's exports, recording what they were given; the registration: update() finds `found` (a worker), which
// installs, then waits for its go (waitForGo) or takes over at once
function fakeCore({ found = null, takesOver = 'go' } = {}) {
  const sw = target(), calls = [];
  const reg = { waiting: null, installing: null, async update() {
    calls.push('update');
    if (!found) return;
    const w = { state: 'installing', ...target() }; reg.installing = w;
    setTimeout(() => { w.state = 'installed'; reg.installing = null; reg.waiting = w; w.fire('statechange'); if (takesOver === 'now') sw.fire('controllerchange'); }, 1);
  } };
  const core = {
    calls, given: null,
    async register(o) { core.given = o; calls.push('register'); return reg; },
    async version() { return 'demo-2026-10-25-ab12cd34'; },
    async versionLabel(v) { return 'label ' + v; },
    async retryUpdate() {
      calls.push('retry');
      if (reg.waiting && takesOver === 'go' && await core.given.canReload()) { reg.waiting = null; setTimeout(() => sw.fire('controllerchange'), 1); }
    },
    async forceLatest({ canReload }) { calls.push('force'); return await canReload() ? 'reloaded' : 'refused'; },
  };
  return { core, sw, reg, nav: { serviceWorker: sw } };
}
// stands in for the auth and sync modules: reports unsent saves, emits signout
function fakeData() {
  let ctxOf = null;
  return { mod: { name: 'auth', needs: [], start(ctx) { ctxOf = ctx; ctx.status.set({ state: 'synced', count: 0, unsent: 0 }); return {}; } },
    unsent(n) { ctxOf.status.set({ state: n ? 'saving' : 'synced', count: n, unsent: n }); }, emit: e => ctxOf.emit(e, {}) };
}
const make = (f, opts = {}, data = fakeData()) => ({ data, app: createApp({ config: { name: 'demo', storage: null, sdk: async () => ({}) }, modules: [data.mod, update({ register: f.core, app: 'demo', sw: 'sw.js', nav: f.nav, ...opts })] }) });

test('update: needs register.js and app; registers after start with the app\'s options; the api passes through', async () => {
  assert.throws(() => update({ app: 'demo' }), /register/);
  assert.throws(() => update({ register: fakeCore().core }), /app/);
  const f = fakeCore(), { app } = make(f, { every: 1000, beforeReload: () => {} });
  const a = await app.ready;
  await settle();
  assert.deepEqual([f.core.given.app, f.core.given.sw, f.core.given.every, typeof f.core.given.beforeReload], ['demo', 'sw.js', 1000, 'function']);
  assert.equal(await a.update.registration(), f.reg);
  assert.equal(await a.update.version(), 'demo-2026-10-25-ab12cd34');
  assert.equal(await a.update.versionLabel('x'), 'label x');
  await app.stop();
});

test('update: a register that throws leaves the app running (no worker: registration null, checkNow false)', async () => {
  const f = fakeCore(); f.core.register = async () => { throw new Error('fake: no worker'); };
  const a = await make(f).app.ready;
  assert.equal(await a.update.registration(), null);
  assert.equal(await a.update.checkNow(), false);
});

test('update: the reload waits while any module has unsent saves, and for the app\'s canReload; forceLatest too', async () => {
  let open = false;
  const f = fakeCore(), { app, data } = make(f, { canReload: () => !open });
  const a = await app.ready; await settle();
  const can = f.core.given.canReload;
  assert.equal(await can(), true);
  data.unsent(2);
  assert.equal(await can(), false, 'unsent saves: no reload');
  assert.equal(await a.update.forceLatest(), 'refused');
  data.unsent(0); open = true;
  assert.equal(await can(), false, 'the app says no');
  open = false;
  assert.equal(await a.update.forceLatest(), 'reloaded');
});

test('update: retryOn names the events after which the owed reload is tried again', async () => {
  const f = fakeCore(), { app, data } = make(f, { retryOn: ['signout'] });
  await app.ready; await settle();
  await data.emit('signout'); await data.emit('signin');
  assert.deepEqual(f.core.calls.filter(c => c === 'retry'), ['retry']);
  await app.stop();
});

test('update: checkNow: false when nothing new; true when the new one takes over (at its go, or at once)', async () => {
  const none = fakeCore();
  const a = await make(none).app.ready;
  assert.equal(await a.update.checkNow(), false);
  assert.deepEqual(none.core.calls, ['register', 'update']);
  const go = fakeCore({ found: true });
  const b = await make(go).app.ready;
  assert.equal(await b.update.checkNow(), true, 'installed, given its go, took over');
  const now = fakeCore({ found: true, takesOver: 'now' });
  const c = await make(now).app.ready;
  assert.equal(await c.update.checkNow(), true, 'took over without waiting');
  assert.equal(now.sw.l.controllerchange.size, 0, 'its listener removed');
});

test('update: checkNow: false when the new one waits (unsent saves) past wait; it takes over later, once allowed', async () => {
  const f = fakeCore({ found: true }), { app, data } = make(f);
  const a = await app.ready;
  data.unsent(1);
  assert.equal(await a.update.checkNow({ wait: 20 }), false);
  assert.ok(f.reg.waiting, 'still waiting');
  data.unsent(0);
  await a.update.retryUpdate();
  assert.equal(f.reg.waiting, null, 'its go once the saves were sent');
});

test('update: a save made while the app\'s canReload is answering still holds the reload (review)', async () => {
  const f = fakeCore(), data = fakeData();
  const { app } = make(f, { canReload: async () => { data.unsent(1); return true; } }, data);
  await app.ready; await settle();
  assert.equal(await f.core.given.canReload(), false);
});
