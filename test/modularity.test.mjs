// 0.9.2: the modularity rules (module-contract, README "Modules"): each entry is side-effect-free on import, has no
// top-level await, never imports another module's entry, uses only literal new URL(x, import.meta.url) and `.js`
// extensions. tools/modularity.mjs is the check; these tests prove it passes here and catches each break.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModularity, entriesOf } from '../tools/modularity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the module entries (package.json exports; 1.5.0: sync/firestore.js) and index.js pass every modularity rule', async () => {
  assert.deepEqual(entriesOf(ROOT), { 'app.js': 'src/runner.js', 'auth.js': 'src/auth.js', 'sync.js': 'src/module-sync.js',
    'update.js': 'src/module-update.js', 'sync/firestore.js': 'src/module-firestore.js' });
  assert.deepEqual(await checkModularity(ROOT), []);
});

test('the check catches each broken rule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modularity-'));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('src/runner.js', 'export const createApp = () => {};\n');
  w('src/auth.js', "import { sync } from './module-sync.js';\nexport const auth = () => sync;\n");   // imports another module
  w('src/module-sync.js', "import { x } from './util';\nexport const sync = () => x;\nawait Promise.resolve();\n");   // no .js, top-level await
  w('src/util.js', 'export const x = 1;\n');
  w('src/module-update.js', "const u = 'sw.js';\nexport const update = () => new URL(u, import.meta.url);\nlocalStorage.getItem('k');\n");   // URL not literal, side effect
  w('app.js', "export { createApp } from './src/runner.js';\n");
  w('auth.js', "export { auth } from './src/auth.js';\n");
  w('sync.js', "export { sync } from './src/module-sync.js';\n");
  w('update.js', "export { update } from './src/module-update.js';\nexport const later = () => import('./' + 'x.js');\n");   // import() not literal
  w('src/late.js', "export const late = () => import('./auth.js');\nexport const lazy = () => import('./util');\n");   // literal import(): another module, no .js
  w('src/runner.js', "export const createApp = () => import('./late.js');\n");
  w('package.json', '{ "type": "module" }\n');
  const problems = (await checkModularity(dir)).join('\n');
  for (const want of [/src\/auth\.js imports src\/module-sync\.js/, /'\.\/util' has no \.js extension/, /top-level await/,
    /new URL\(\) without a literal/, /import\(\) without a literal/, /update\.js touches localStorage on import/,
    /src\/late\.js imports src\/auth\.js, another module's main file \(app\.js\)/, /src\/late\.js:2: '\.\/util' has no \.js extension/])
    assert.match(problems, want);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 1.5.0: "sideEffects" in package.json is true: an exported file it does not list touches nothing on import
test('the check catches a package.json "sideEffects" that is not true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modularity-'));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('app.js', "export { createApp } from './src/runner.js';\n");
  w('src/runner.js', 'export const createApp = () => {};\n');
  w('index.js', "export { createApp } from './src/runner.js';\n");
  w('update/register.js', "localStorage.getItem('k');\nexport const register = () => {};\n");
  w('update/sw-core.js', "self.AppUpdate = {};\n");
  const pkg = sideEffects => w('package.json', JSON.stringify({ type: 'module', sideEffects, exports: { './app': './app.js', './update/register': './update/register.js', './update/sw-core': './update/sw-core.js' } }));
  pkg(['./update/sw-core.js']);
  assert.deepEqual(await checkModularity(dir), ['update/register.js touches localStorage on import (not in package.json "sideEffects")']);
  pkg(['./update/sw-core.js', './update/register.js']);
  assert.deepEqual(await checkModularity(dir), []);
  pkg(undefined);
  assert.match((await checkModularity(dir)).join('\n'), /no "sideEffects"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
