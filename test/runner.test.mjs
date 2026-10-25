// The module runner (0.9.0, app.js): createApp({ config, modules }), the order modules start and stop in, the frozen
// ctx, its events, storage and status. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

const memStorage = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const config = (more = {}) => ({ name: 'fake-app', storage: memStorage(), sdk: async () => ({}), ...more });
// a module that writes what happens to it into log
const mod = (name, log, more = {}) => ({
  name, needs: [],
  start(ctx, deps) { log.push('start ' + name + ' ' + Object.keys(deps).join(',')); return { name, ctx }; },
  stop() { log.push('stop ' + name); },
  ...more,
});

test('modules start in needs order, each gets only the apis it needs, and stop in reverse, once', async () => {
  const log = [];
  const app = createApp({ config: config(), modules: [mod('c', log, { needs: ['a', 'b'] }), mod('b', log, { needs: ['a'] }), mod('a', log)] });
  assert.equal(await app.ready, app);
  assert.deepEqual(log, ['start a ', 'start b a', 'start c a,b']);
  assert.equal(app.a.name, 'a');
  assert.equal(app.c.name, 'c');
  const [one, two] = [app.stop(), app.stop()];
  assert.equal(one, two);
  await one; await app.stop();
  assert.deepEqual(log.slice(3), ['stop c', 'stop b', 'stop a']);
});

test('fails fast on a cycle, a missing module, a duplicate or reserved name, a bad module', () => {
  const log = [];
  assert.throws(() => createApp({ config: config(), modules: [mod('a', log, { needs: ['b'] }), mod('b', log, { needs: ['a'] })] }), /cycle/);
  assert.throws(() => createApp({ config: config(), modules: [mod('a', log, { needs: ['b'] })] }), /needs b/);
  assert.throws(() => createApp({ config: config(), modules: [mod('a', log), mod('a', log)] }), /two modules named a/);
  assert.throws(() => createApp({ config: config(), modules: [mod('stop', log)] }), /reserved/);
  assert.throws(() => createApp({ config: config(), modules: [{ name: 'x' }] }), /start/);
  assert.throws(() => createApp({ config: { sdk: async () => ({}) }, modules: [] }), /config.name/);
  assert.deepEqual(log, []);
});

test('a start that throws stops the modules already started, in reverse, and ready rejects', async () => {
  const log = [];
  const app = createApp({ config: config(), modules: [mod('a', log), mod('b', log, { needs: ['a'], async start() { throw new Error('boom'); } }), mod('c', log)] });
  await assert.rejects(app.ready, /boom/);
  assert.deepEqual(log, ['start a ', 'stop a']);
  await app.stop();
  assert.deepEqual(log, ['start a ', 'stop a']);
});

test('stop during start waits for it, then stops what started; a failing stop does not stop the others', async () => {
  const log = [];
  let go;
  const slow = mod('b', log, { needs: ['a'], start: () => new Promise(r => { go = () => { log.push('start b'); r({}); }; }) });
  const app = createApp({ config: config(), modules: [mod('a', log, { stop() { log.push('stop a'); throw new Error('no'); } }), slow, mod('c', log, { needs: ['b'] })] });
  await new Promise(r => setTimeout(r, 5));
  const stopped = app.stop();
  go();
  const r = await stopped;
  assert.deepEqual(log, ['start a ', 'start b', 'stop b', 'stop a']);
  assert.deepEqual(r.failed, ['a']);
  await assert.rejects(app.ready, /stopped/);
});

test('ctx is frozen and small: name, module, config (frozen), one shared lazy sdk(), user, on, emit, storage, status, report', async () => {
  let loads = 0, fails = 1;
  const sdk = async () => { loads++; if (fails-- > 0) throw new Error('offline'); return { fake: true }; };
  const facts = [];
  const app = createApp({ config: config({ sdk, report: f => facts.push(f) }), modules: [mod('a', []), mod('b', [])] });
  await app.ready;
  const { ctx } = app.a;
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.config));
  assert.deepEqual(Object.keys(ctx).sort(), ['config', 'emit', 'module', 'name', 'on', 'report', 'sdk', 'status', 'storage', 'user']);
  assert.equal(ctx.name, 'fake-app'); assert.equal(ctx.module, 'a');
  assert.equal(loads, 0, 'nothing loads before a module asks');
  await assert.rejects(ctx.sdk(), /offline/);
  const [x, y] = await Promise.all([ctx.sdk(), app.b.ctx.sdk()]);
  assert.equal(x, y); assert.equal(loads, 2, 'a failed load is tried again; then one load for every module');
  ctx.report({ what: 'thing' });
  assert.deepEqual(facts, [{ module: 'a', what: 'thing' }]);
});

test('storage(ns) is namespaced <app>:<module>[:ns], JSON values, kept across apps on the same storage', async () => {
  const storage = memStorage();
  const app = createApp({ config: config({ storage }), modules: [mod('a', []), mod('b', [])] });
  await app.ready;
  const a = app.a.ctx.storage(), b = app.b.ctx.storage(), a2 = app.a.ctx.storage('extra');
  assert.equal(a.name, 'fake-app:a'); assert.equal(a2.name, 'fake-app:a:extra');
  a.set('owner', { uid: 'u1' }); b.set('owner', { uid: 'u2' });
  assert.deepEqual(a.get('owner'), { uid: 'u1' }); assert.equal(a2.get('owner'), null);
  assert.deepEqual([...storage.m.keys()].sort(), ['fake-app:a/owner', 'fake-app:b/owner']);
  const again = createApp({ config: config({ storage }), modules: [mod('a', [])] });
  await again.ready;
  assert.deepEqual(again.a.ctx.storage().get('owner'), { uid: 'u1' });
  a.remove('owner'); assert.equal(a.get('owner'), null);
  // no storage at all (null): kept in memory for the page
  const mem = createApp({ config: config({ storage: null }), modules: [mod('a', [])] });
  await mem.ready;
  mem.a.ctx.storage().set('k', 1); assert.equal(mem.a.ctx.storage().get('k'), 1);
});

test('events: only the auth module emits the core four; handlers run in start order, awaited; user() follows them', async () => {
  const log = [];
  const user = { uid: 'u1', email: 'fake@example.test' };
  const listener = name => mod(name, log, {
    needs: name === 'auth' ? [] : ['auth'],
    start(ctx) {
      for (const ev of ['signin', 'signout', 'switch', 'forget']) ctx.on(ev, async d => { await new Promise(r => setTimeout(r, 2)); log.push(name + ' ' + ev + ' ' + (ctx.user()?.uid || '-') + ' ' + JSON.stringify(d)); if (name === 'y' && ev === 'forget') throw new Error('wipe failed'); });
      return { ctx };
    },
  });
  const app = createApp({ config: config(), modules: [listener('x'), listener('y'), listener('auth')] });
  await app.ready;
  log.length = 0;
  await assert.rejects(async () => app.x.ctx.emit('signin', { user }), /auth module/);
  assert.deepEqual(await app.auth.ctx.emit('signin', { user }), []);
  assert.equal(app.x.ctx.user().uid, 'u1');
  assert.deepEqual(await app.auth.ctx.emit('forget', { user }), ['y']);
  assert.equal(app.x.ctx.user(), null);
  assert.deepEqual(log, [
    'auth signin u1 {"user":{"uid":"u1","email":"fake@example.test"}}', 'x signin u1 {"user":{"uid":"u1","email":"fake@example.test"}}', 'y signin u1 {"user":{"uid":"u1","email":"fake@example.test"}}',
    'auth forget - {"user":{"uid":"u1","email":"fake@example.test"}}', 'x forget - {"user":{"uid":"u1","email":"fake@example.test"}}', 'y forget - {"user":{"uid":"u1","email":"fake@example.test"}}',
  ]);
  // a module's handlers go when it stops; off() removes one
  const off = app.x.ctx.on('custom', () => log.push('custom'));
  await app.y.ctx.emit('custom', {}); off(); await app.y.ctx.emit('custom', {});
  assert.equal(log.filter(l => l === 'custom').length, 1);
  await app.stop();
  log.length = 0;
  await app.auth.ctx.emit('signin', { user });
  assert.deepEqual(log, []);
});

test('status: modules report in, the app reads one status (most urgent state, unsent added up)', async () => {
  const app = createApp({ config: config(), modules: [mod('a', []), mod('b', [])] });
  await app.ready;
  const seen = [];
  const off = app.status$(st => seen.push(st.state + ':' + st.count + ':' + st.unsent));
  app.a.ctx.status.set({ state: 'saving', count: 2, unsent: 2 });
  app.b.ctx.status.set({ state: 'attention', count: 1, unsent: 1 });
  assert.deepEqual(app.a.ctx.status.get(), { state: 'attention', count: 1, unsent: 3, parts: { a: { state: 'saving', count: 2, unsent: 2 }, b: { state: 'attention', count: 1, unsent: 1 } } });
  app.b.ctx.status.set(null);
  off();
  app.a.ctx.status.set({ state: 'synced', count: 0 });
  assert.deepEqual(seen, ['synced:0:0', 'saving:2:2', 'attention:1:3', 'saving:2:2']);
  assert.equal(app.b.ctx.status.get().state, 'synced');
});
