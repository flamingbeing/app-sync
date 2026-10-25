// 0.9.2: the modularity rules (module-contract, README "Modules"): each entry is side-effect-free on import, has no
// top-level await, never imports another module's entry, uses only literal new URL(x, import.meta.url) and `.js`
// extensions. tools/modularity.mjs is the check; these tests prove it passes here and catches each break.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModularity, ENTRIES } from '../tools/modularity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the four module entries and index.js pass every modularity rule', async () => {
  assert.deepEqual(Object.keys(ENTRIES), ['app.js', 'auth.js', 'sync.js', 'update.js']);
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
  w('package.json', '{ "type": "module" }\n');
  const problems = (await checkModularity(dir)).join('\n');
  for (const want of [/src\/auth\.js imports src\/module-sync\.js/, /'\.\/util' has no \.js extension/, /top-level await/,
    /new URL\(\) without a literal/, /import\(\) without a literal/, /update\.js touches localStorage on import/])
    assert.match(problems, want);
  fs.rmSync(dir, { recursive: true, force: true });
});
