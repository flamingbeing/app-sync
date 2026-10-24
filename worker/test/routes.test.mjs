// worker/routes.js: which folder each address serves, and what it must never serve. Run: node --test 'worker/test/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../routes.js';

test('core.anawj.com/update/ maps to the built update versions', () => {
  assert.deepEqual(resolve('core.anawj.com', '/update/0.1.0/sw-core.js'), { file: 'update/0.1.0/sw-core.js' });
  assert.deepEqual(resolve('core.anawj.com', '/update'), { redirect: '/update/' });
});

test('core.anawj.com/sync/ maps to the built versions', () => {
  assert.deepEqual(resolve('core.anawj.com', '/sync/0.1.0/index.js'), { file: 'sync/0.1.0/index.js' });
  assert.deepEqual(resolve('CORE.anawj.com:443', '/sync/versions.json'), { file: 'sync/versions.json' });
  assert.deepEqual(resolve('core.anawj.com', '/sync'), { redirect: '/sync/' });
});

test('unknown hosts serve nothing; localhost serves the repo', () => {
  assert.deepEqual(resolve('x.workers.dev', '/sync/0.1.0/index.js'), { notFound: true });
  assert.deepEqual(resolve('other.example.com', '/'), { notFound: true });
  assert.deepEqual(resolve('core.anawj.com', '/other/'), { notFound: true });
  assert.deepEqual(resolve('localhost:8787', '/sync/0.1.0/index.js'), { file: 'sync/0.1.0/index.js' });
});

test('nothing escapes its folder', () => {
  for (const p of ['/sync/../wrangler.jsonc', '/sync/%2e%2e/x', '/sync/a%2fb', '/sync/a\\b', '/sync/./x'])
    assert.deepEqual(resolve('core.anawj.com', p), { notFound: true }, p);
});
