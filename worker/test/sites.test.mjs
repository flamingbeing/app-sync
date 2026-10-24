// worker/sites.js with a stand-in for the static assets. Run: node --test 'worker/test/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sites.js';

const FILES = {
  '/sync/0.1.0/index.js': 'export const VERSION = "0.1.0";',
  '/sync/0.1.0/src/sync.js': '//',
  '/sync/0.1.0/LICENSE': 'Apache',
  '/sync/versions.json': '{"latest":"0.1.0","versions":["0.1.0"]}',
  '/sync/0.1.0/secret.txt': 'x',
  '/update/0.1.0/sw-core.js': 'self.AppUpdate = {};',
  '/update/0.1.0/register.js': 'export const CORE_VERSION = "0.1.0";',
  '/update/0.1.0/other.js': 'x',
  '/update/versions.json': '{"latest":"0.1.0","versions":["0.1.0"]}',
};
const env = { ASSETS: { fetch: async req => {
  const p = new URL(req.url).pathname;
  return p in FILES ? new Response(FILES[p], { status: 200 }) : new Response('', { status: 404 });
} } };
const get = (url, method = 'GET') => worker.fetch(new Request(url, { method }), env);
const H = 'https://core.anawj.com';

test('a version file is served with immutable caching, CORS and the right type', async () => {
  const r = await get(`${H}/sync/0.1.0/index.js`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /VERSION/);
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(r.headers.get('Content-Type'), /^text\/javascript/);
  assert.equal((await get(`${H}/sync/0.1.0/src/sync.js`)).status, 200);
  assert.equal((await get(`${H}/sync/0.1.0/LICENSE`)).status, 200);
});

test('the version list is short-lived, not immutable', async () => {
  const r = await get(`${H}/sync/versions.json`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=300');
  assert.match(r.headers.get('Content-Type'), /^application\/json/);
});

test('nothing else is served: other types, folders, other hosts, bad versions', async () => {
  for (const u of [`${H}/sync/0.1.0/secret.txt`, `${H}/sync/0.1.0/`, `${H}/sync/`, `${H}/`, `${H}/sync/latest/index.js`,
    `${H}/sync/0.1/index.js`, `${H}/sync/9.9.9/index.js`, 'https://x.workers.dev/sync/0.1.0/index.js'])
    assert.equal((await get(u)).status, 404, u);
});

test('only GET and HEAD', async () => {
  assert.equal((await get(`${H}/sync/0.1.0/index.js`, 'POST')).status, 405);
  assert.equal((await get(`${H}/sync/0.1.0/index.js`, 'HEAD')).status, 200);
});

test('the update module: two files per version, immutable, CORS; its version list is short-lived', async () => {
  for (const f of ['sw-core.js', 'register.js']) {
    const r = await get(`${H}/update/0.1.0/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(r.headers.get('Content-Type'), /^text\/javascript/);
  }
  assert.equal((await get(`${H}/update/versions.json`)).headers.get('Cache-Control'), 'public, max-age=300');
  for (const u of [`${H}/update/0.1.0/other.js`, `${H}/update/0.1.0/`, `${H}/update/`, `${H}/update/9.9.9/sw-core.js`, `${H}/update/latest/sw-core.js`])
    assert.equal((await get(u)).status, 404, u);
});
