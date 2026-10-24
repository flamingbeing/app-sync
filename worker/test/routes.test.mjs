// worker/routes.js: which folder each address serves, and what it must never serve. Run: node --test 'worker/test/*.test.mjs'
// Replace the example host's cases with your own when you edit SITES.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve, SITES } from '../routes.js';

test('a root host serves its folder', () => {
  assert.deepEqual(resolve('example.example.com', '/'), { file: 'example/' });
  assert.deepEqual(resolve('example.example.com', '/app.js'), { file: 'example/app.js' });
  assert.deepEqual(resolve('EXAMPLE.example.com:443', '/'), { file: 'example/' });
  assert.deepEqual(resolve('example.example.com', '/example'), { redirect: '/example/' });
  assert.deepEqual(resolve('example.example.com', '/example/sw.js'), { file: 'example/sw.js' });
});

test('unknown hosts serve nothing; localhost serves the repo', () => {
  assert.deepEqual(resolve('x.workers.dev', '/example/'), { notFound: true });
  assert.deepEqual(resolve('other.example.com', '/'), { notFound: true });
  assert.deepEqual(resolve('localhost:8787', '/example/'), { file: 'example/' });
});

test('nothing escapes its folder', () => {
  for (const p of ['/../wrangler.jsonc', '/%2e%2e/x', '/a%2fb', '/a\\b', '/./x'])
    assert.deepEqual(resolve('example.example.com', p), { notFound: true }, p);
});

test('every folder in SITES exists', () => {
  for (const [host, s] of Object.entries(SITES))
    for (const f of [s.root, ...Object.values(s.prefixes || {})].filter(Boolean))
      assert.ok(fs.existsSync(new URL(`../../${f}`, import.meta.url)), `${host}: ${f}`);
});
