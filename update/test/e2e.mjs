// Real-browser test: a fixture app on one local server, the core files on another (as core.anawj.com is a different
// site from the apps). Run: node update/test/e2e.mjs   (needs Playwright with Chromium)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { stamp } from '../tools/stamp-versions.mjs';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e) { ({ chromium } = await import('playwright')); }

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-e2e-'));
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

const serve = (root, { cors = false } = {}) => {
  const s = { hits: {}, down: new Set() };
  s.server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    s.hits[p] = (s.hits[p] || 0) + 1;
    const file = path.join(root, p.endsWith('/') ? p + 'index.html' : p);
    if (s.down.has(p) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(s.down.has(p) ? 500 : 404); res.end('x'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain', 'cache-control': 'no-cache', ...(cors ? { 'access-control-allow-origin': '*' } : {}) });
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => s.server.listen(0, '127.0.0.1', () => { s.url = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
};

const core = await serve(path.join(here, '..'), { cors: true });
const appRoot = path.join(dir, 'app');
const app = await serve(appRoot);
const deploy = (build, { date }) => {
  fs.mkdirSync(appRoot, { recursive: true });
  for (const f of fs.readdirSync(path.join(here, 'fixture'))) {
    fs.writeFileSync(path.join(appRoot, f), fs.readFileSync(path.join(here, 'fixture', f), 'utf8').replaceAll('__CORE__', core.url).replace('build 1', build));
  }
  return stamp({ dir: appRoot, date });
};

const v1 = deploy('build 1', { date: '2026-10-24' });
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const text = id => page.textContent('#' + id);
const settle = ms => page.waitForTimeout(ms);
let step = '';
try {
  step = 'first install: no reload, claims the page';
  await page.goto(app.url + '/');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await settle(800);
  assert.equal(await text('loads'), '1', 'the first install must not reload the page');
  assert.equal(await page.evaluate(() => window.__version()), v1.version);
  assert.match(await page.evaluate(() => window.__label()), /^2026-10-24 \([0-9a-f]{8}\)$/);


  step = 'offline shell';
  await ctx.setOffline(true);
  await page.reload();
  assert.equal(await text('build'), 'build 1');
  await ctx.setOffline(false);
  // an uncached page shows the offline fallback
  await ctx.setOffline(true);
  const other = await ctx.newPage();
  await other.goto(app.url + '/deep/link').catch(() => {});
  assert.equal(await other.textContent('#build'), 'build 1');   // navigations go to the folder page
  await other.close();
  await ctx.setOffline(false);

  step = 'a new version takes over and reloads once; only the changed file is fetched';
  await page.evaluate(() => sessionStorage.setItem('loads', '1'));
  const v2 = deploy('build 2', { date: '2026-10-25' });
  assert.notEqual(v2.version, v1.version);
  app.hits = {};
  await page.evaluate(() => window.__reg.update());
  await page.waitForFunction(() => document.getElementById('build').textContent === 'build 2', null, { timeout: 15000 });
  await settle(1500);
  assert.equal(await text('loads'), '2', 'exactly one reload, no loop');
  assert.equal(await page.evaluate(() => window.__version()), v2.version);
  assert.equal(app.hits['/app.js'] || 0, 0, 'unchanged app.js is copied, not fetched');
  assert.equal(app.hits['/style.css'] || 0, 0, 'unchanged style.css is copied, not fetched');
  assert.equal(app.hits['/'], 1);
  const caches = await page.evaluate(() => caches.keys());
  assert.deepEqual(caches, [v2.version], 'old cache removed');

  step = 'one failed file: the new version does not install and nothing changes';
  fs.writeFileSync(path.join(appRoot, 'app.js'), "document.title = 'broken build';");
  const v3 = stamp({ dir: appRoot, date: '2026-10-26' });
  app.down.add('/app.js');
  await page.evaluate(() => window.__reg.update().catch(() => {}));
  await settle(1500);
  assert.equal(await text('loads'), '2');
  assert.equal(await page.evaluate(() => window.__version()), v2.version, 'still on the old version');
  assert.deepEqual(await page.evaluate(() => caches.keys()), [v2.version], 'no half-filled cache left');
  app.down.delete('/app.js');
  await page.evaluate(() => window.__reg.update());
  await page.waitForFunction(v => window.__version().then(x => x === v), v3.version, { timeout: 15000 });
  await settle(500);
  assert.equal(await text('loads'), '2', 'a second take-over within seconds of a reload does not reload again (loop guard)');

  step = 'the next take-over, after the guard window, reloads again';
  await page.evaluate(() => sessionStorage.removeItem('app-update:reload:demo'));
  fs.writeFileSync(path.join(appRoot, 'app.js'), "document.title = 'fourth build';");
  const v4 = stamp({ dir: appRoot, date: '2026-10-27' });
  await page.evaluate(() => window.__reg.update());
  await page.waitForFunction(() => document.title === 'fourth build', null, { timeout: 15000 });
  await settle(1000);
  assert.equal(await text('loads'), '3');
  assert.equal(await page.evaluate(() => window.__version()), v4.version);

  step = 'waitForGo + canReload: a new worker waits while the page says no, takes over on retryUpdate';
  await page.evaluate(() => sessionStorage.removeItem('app-update:reload:demo'));
  const edit = (f, a, b) => fs.writeFileSync(path.join(appRoot, f), fs.readFileSync(path.join(appRoot, f), 'utf8').replace(a, b));
  edit('sw.js', "offline: 'offline.html' }", "offline: 'offline.html', waitForGo: true }");
  edit('index.html', "import { register, version, versionLabel }", "import { register, version, versionLabel, retryUpdate }");
  edit('index.html', "register({ app: 'demo', sw: 'sw.js' })", "register({ app: 'demo', sw: 'sw.js', canReload: () => !!window.__ok })");
  edit('index.html', 'window.__label = versionLabel;', 'window.__label = versionLabel; window.__retry = retryUpdate;');
  fs.writeFileSync(path.join(appRoot, 'app.js'), "document.title = 'fifth build';");
  const v5 = stamp({ dir: appRoot, date: '2026-10-28' });
  await page.evaluate(() => window.__reg.update());   // the old page has no canReload: it gives the go at once
  await page.waitForFunction(() => document.title === 'fifth build', null, { timeout: 15000 });
  await settle(1000);
  assert.equal(await text('loads'), '4');
  assert.equal(await page.evaluate(() => window.__version()), v5.version);
  await page.evaluate(() => sessionStorage.removeItem('app-update:reload:demo'));
  fs.writeFileSync(path.join(appRoot, 'app.js'), "document.title = 'sixth build';");
  const v6 = stamp({ dir: appRoot, date: '2026-10-29' });
  await page.evaluate(() => window.__reg.update());
  await page.waitForFunction(() => !!window.__reg.waiting, null, { timeout: 15000 });
  await settle(1500);
  assert.equal(await text('loads'), '4', 'no reload while canReload says no');
  assert.equal(await page.evaluate(() => window.__version()), v5.version, 'the new worker waits');
  await page.evaluate(() => { window.__ok = true; return window.__retry(); });
  await page.waitForFunction(() => document.title === 'sixth build', null, { timeout: 15000 });
  await settle(1000);
  assert.equal(await text('loads'), '5');
  assert.equal(await page.evaluate(() => window.__version()), v6.version);

  console.log('e2e: ok');
} catch (e) {
  console.error('e2e failed at: ' + step + '\n' + (e.stack || e));
  process.exitCode = 1;
} finally {
  await browser.close();
  core.server.close(); app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
