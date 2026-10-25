// sw-core.js in a fake service worker world (test/fake-sw.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeServer, makeWorld, FakeCaches } from './fake-sw.mjs';

const SCOPE = 'https://app.test/app/';
const SHELL = ['./', 'app.js', 'style.css'];
const files = (tag = 'a') => ({ '/app/': `<html>${tag}`, '/app/app.js': `js ${tag}`, '/app/style.css': 'css' });
const man = (h = {}) => ({ './': 'h-index', 'app.js': 'h-js', 'style.css': 'h-css', ...h });
const boot = (server, caches, version, manifest, extra = {}) => {
  const w = makeWorld({ caches, server, scope: SCOPE });
  w.AppUpdate.init({ app: 'demo', version, shell: SHELL, manifest, ...extra });
  return w;
};
const install = async w => { await w.fire('install'); await w.fire('activate'); };
const text = async r => (await r).response.text();

test('install fills the cache, takes over at once, and offline the shell loads', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man());
  await install(w);
  assert.ok(w.self.skipped && w.self.claimed);
  server.fail.add('/app/'); server.fail.add('/app/app.js');
  assert.equal(await text(w.doFetch('/app/', { mode: 'navigate' })), '<html>a');
  assert.equal(await text(w.doFetch('/app/app.js?v=3')), 'js a');
});

test('navigations are served from the folder, never index.html', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man());
  await install(w);
  server.fail.add('/app/');
  assert.equal(await text(w.doFetch('/app/index.html', { mode: 'navigate' })), '<html>a');
  assert.equal(await text(w.doFetch('/app/deep/link?x=1', { mode: 'navigate' })), '<html>a');
});

test('one failed file means no install: nothing half-filled, the old version keeps its cache', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  await install(boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man()));
  server.files['/app/style.css'] = new Response('x', { status: 500 });
  const w2 = boot(server, caches, 'demo-2026-10-25-bbbbbbbb', man({ 'style.css': 'h-css2' }));
  await assert.rejects(w2.fire('install'), /500/);
  assert.deepEqual(await caches.keys(), ['demo-2026-10-24-aaaaaaaa']);
});

test('a redirected or opaque shell file also fails the install', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  server.files['/app/app.js'] = () => Object.defineProperty(new Response('r'), 'redirected', { value: true });
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man());
  await assert.rejects(w.fire('install'), /redirected/);
  assert.deepEqual(await caches.keys(), []);
});

test('an update fetches only the changed files and copies the rest', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  await install(boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man()));
  server.hits = {};
  Object.assign(server.files, files('b'));
  await install(boot(server, caches, 'demo-2026-10-25-bbbbbbbb', man({ 'app.js': 'h-js2' })));
  assert.deepEqual(server.hits, { '/app/app.js': 1 });
  const w = boot(server, caches, 'demo-2026-10-25-bbbbbbbb', man({ 'app.js': 'h-js2' }));
  server.fail.add('/app/style.css');
  assert.equal(await text(w.doFetch('/app/style.css')), 'css');
});

test('a manifest that does not match means a full refetch', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  await install(boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man()));
  server.hits = {};
  await install(boot(server, caches, 'demo-2026-10-25-bbbbbbbb', {}));              // no hashes at all
  assert.deepEqual(Object.keys(server.hits).sort(), ['/app/', '/app/app.js', '/app/style.css']);
  server.hits = {};
  await install(boot(server, caches, 'demo-2026-10-26-cccccccc', { './': 'x' }));   // hashes for part of the shell
  assert.equal(Object.keys(server.hits).length, 3);
});

test('activate removes this app\'s old caches only, and keeps runtime caches and the keep list', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  for (const n of ['demo-2026-10-01-00000000', 'demo-rt-photos', 'demo2-1', 'other-1', 'share-inbox-demo', 'demo-keepme']) await caches.open(n);
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { keep: ['demo-keepme'] });
  await install(w);
  assert.deepEqual((await caches.keys()).sort(), ['demo-2026-10-24-aaaaaaaa', 'demo-keepme', 'demo-rt-photos', 'demo2-1', 'other-1', 'share-inbox-demo'].sort());
});

test('never cached: auth pages, Cloudflare Access and the app\'s own never list go to the network', async () => {
  const server = makeServer({ ...files(), '/__/auth/handler': 'a', '/cdn-cgi/access/x': 'b', '/scan-api/x': 'c' }), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { never: ['/scan-api/'], runtime: [{ name: 'all', match: () => true }] });
  await install(w);
  for (const p of ['/__/auth/handler', '/cdn-cgi/access/x', '/scan-api/x']) assert.equal((await w.doFetch(p, { mode: 'navigate' })).handled, false, p);
});

test('other origins go to the network, except the pinned SDK rule', async () => {
  const sdk = 'https://www.gstatic.com/firebasejs/11.10.0/app.js';
  const server = makeServer({ ...files(), [new URL(sdk).pathname]: 'sdk' });
  const w = boot(server, new FakeCaches(), 'demo-2026-10-24-aaaaaaaa', man());
  await install(w);
  assert.equal((await w.doFetch('https://firestore.googleapis.com/v1/x')).handled, false);
  assert.equal((await w.doFetch('https://www.gstatic.com/firebasejs/other')).handled, false);
  assert.equal(await text(w.doFetch(sdk)), 'sdk');
  server.fail.add(new URL(sdk).pathname);
  assert.equal(await text(w.doFetch(sdk)), 'sdk');   // second time from the cache
});

test('runtime cache: only ok same-origin answers are kept, and the cap drops the oldest', async () => {
  const f = { ...files(), '/app/p/1.jpg': 'one', '/app/p/2.jpg': 'two', '/app/p/3.jpg': 'three', '/app/p/bad.jpg': new Response('no', { status: 500 }) };
  const server = makeServer(f), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { runtime: [{ name: 'photos', match: u => u.pathname.startsWith('/app/p/'), max: 2 }] });
  await install(w);
  for (const n of ['1', '2', '3']) await w.doFetch(`/app/p/${n}.jpg`);
  await w.doFetch('/app/p/bad.jpg');
  const names = (await (await caches.open('demo-rt-photos')).keys()).map(r => new URL(r.url).pathname);
  assert.deepEqual(names, ['/app/p/2.jpg', '/app/p/3.jpg']);
  // an opaque (no-cors) answer is passed on but never stored
  server.files['/app/p/op.jpg'] = () => Object.defineProperty(new Response('op'), 'type', { value: 'opaque' });
  await w.doFetch('/app/p/op.jpg');
  assert.equal((await (await caches.open('demo-rt-photos')).keys()).length, 2);
});

test('a runtime rule without a cap is not trimmed, and maxAge expires entries', async () => {
  const f = { ...files(), '/app/p/1.jpg': 'one', '/app/p/2.jpg': 'two', '/app/p/3.jpg': 'three' };
  const server = makeServer(f), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { runtime: [{ name: 'photos', match: u => u.pathname.startsWith('/app/p/') }] });
  await install(w);
  for (const n of ['1', '2', '3']) await w.doFetch(`/app/p/${n}.jpg`);
  assert.equal((await (await caches.open('demo-rt-photos')).keys()).length, 3);
  const w2 = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { runtime: [{ name: 'photos', match: u => u.pathname.startsWith('/app/p/'), maxAge: 30 }] });
  await new Promise(r => setTimeout(r, 60));
  await w2.doFetch('/app/p/1.jpg');   // expired entries are refetched, and the other old ones are dropped
  assert.deepEqual((await (await caches.open('demo-rt-photos')).keys()).map(r => new URL(r.url).pathname), ['/app/p/1.jpg']);
});

test('offline fallback page for a navigation nothing has cached', async () => {
  const server = makeServer({}), caches = new FakeCaches();
  server.fail.add('/app/other.html');
  const w = makeWorld({ caches, server, scope: SCOPE });
  w.AppUpdate.init({ app: 'demo', version: 'demo-2026-10-24-aaaaaaaa', shell: [] });
  const r = (await w.doFetch('/app/other.html', { mode: 'navigate' })).response;
  assert.equal(r.status, 503);
  assert.match(await r.text(), /offline/i);
  // an app page from the shell is used when there is one
  const server2 = makeServer({ '/app/offline.html': 'my offline page', '/app/a.html': 'a' }), caches2 = new FakeCaches();
  const w2 = makeWorld({ caches: caches2, server: server2, scope: SCOPE });
  w2.AppUpdate.init({ app: 'demo', version: 'demo-2026-10-24-aaaaaaaa', shell: ['a.html', 'offline.html'], offline: 'offline.html' });
  await install(w2);
  server2.fail.add('/app/b.html');
  assert.equal(await text(w2.doFetch('/app/b.html', { mode: 'navigate' })), 'my offline page');
});

test('the app hook answers first (share-target POST), others fall through', async () => {
  const server = makeServer(files());
  const w = boot(server, new FakeCaches(), 'demo-2026-10-24-aaaaaaaa', man(), { handle: e => (e.request.method === 'POST' ? new Response('saved') : null) });
  await install(w);
  assert.equal(await text(w.doFetch('/app/share', { method: 'POST' })), 'saved');
  assert.equal((await w.doFetch('/app/other', { method: 'POST' })).handled, true);
  assert.equal((await w.doFetch('/app/range.mp4', { headers: { range: 'bytes=0-1' } })).handled, false);
});

test('the page can ask for the stamped version', async () => {
  const w = boot(makeServer(files()), new FakeCaches(), 'demo-2026-10-24-aaaaaaaa', man());
  let got; const port = { postMessage: m => { got = m; } };
  await w.fire('message', { data: { type: 'update:version' }, ports: [port] });
  assert.equal(got.version, 'demo-2026-10-24-aaaaaaaa');
  assert.equal(got.core, JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);   // one version (1.0.0-rc.1)
});

test('init refuses a version that does not start with the app name', () => {
  const w = makeWorld({ server: makeServer({}), scope: SCOPE });
  assert.throws(() => w.AppUpdate.init({ app: 'demo', version: 'other-1', shell: [] }), /should start with/);
});

test('waitForGo: install does not take over; the page\'s update:go does (old messages still work)', async () => {
  const server = makeServer(files()), caches = new FakeCaches();
  const w = boot(server, caches, 'demo-2026-10-24-aaaaaaaa', man(), { waitForGo: true });
  await w.fire('install');
  assert.ok(!w.self.skipped);
  await w.fire('message', { data: { type: 'update:go' } });
  assert.ok(w.self.skipped);
  const w2 = boot(server, caches, 'demo-2026-10-25-bbbbbbbb', man(), { waitForGo: true });
  await w2.fire('install');
  await w2.fire('message', { data: { type: 'take-over' } });
  assert.ok(w2.self.skipped);
});
