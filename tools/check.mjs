// Repo checks for mistakes tests don't catch. Run before merging: node tools/check.mjs
// (1.5.0: the per-app sw.js checks are gone, no app lives in this repo any more.)
// 1. The generated parts are current (node tools/generate.mjs --check: versions, file lists, src/ exports).
// 2. wrangler.jsonc keeps preview links and the workers.dev address off.
// 3. The package.json version is locked in versions.lock.json (a released version never changes).
// 4. The Worker's tests pass (node --test 'worker/test/*.test.mjs').
// 5. The update module's version (package.json's from 1.0.0-rc.1; update/VERSION before) is locked in update.lock.json
//    and matches its files.
// 6. Size budget (core admission rule, README "Stability"): the public index and src/ stay under BUDGET bytes.
//    Raising a budget is a CHANGELOG line.
// Exits 1 on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = msg => errors.push(msg);

const BUDGET = { 'index.js': 2600, 'src/': 301400 };   // src/ 301400: 1.5.3 (held: each save's own change)
const bytesOf = rel => {
  const abs = path.join(ROOT, rel);
  return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).reduce((n, f) => n + bytesOf(path.posix.join(rel, f)), 0) : fs.statSync(abs).size;
};
for (const [rel, max] of Object.entries(BUDGET)) {
  const n = bytesOf(rel);
  if (n > max) fail(`${rel} is ${n} bytes, over its budget of ${max} (core admission rule, README "Stability"): make it smaller, or raise BUDGET in tools/check.mjs with a CHANGELOG line`);
}

const wrangler = path.join(ROOT, 'wrangler.jsonc');
if (fs.existsSync(wrangler)) {
  const w = fs.readFileSync(wrangler, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  if (!/"preview_urls"\s*:\s*false/.test(w)) fail('wrangler.jsonc: "preview_urls" should be false (no preview links)');
  if (!/"workers_dev"\s*:\s*false/.test(w)) fail('wrangler.jsonc: "workers_dev" should be false (real addresses only)');
}

try { execFileSync(process.execPath, ['tools/generate.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }); }
catch (e) { fail(String(e.stderr || e.message).trim()); }

// the package.json version must be in versions.lock.json with the working tree's hashes (tools/build-sync.mjs --lock)
try { execFileSync(process.execPath, ['tools/build-sync.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }); }
catch (e) { fail(String(e.stderr || e.message).trim()); }

try { execFileSync(process.execPath, ['tools/build-update.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' }); }
catch (e) { fail(String(e.stderr || e.message).trim()); }

if (fs.existsSync(path.join(ROOT, 'worker/test'))) {
  try { execFileSync(process.execPath, ['--test', 'worker/test/*.test.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { fail('worker tests failed:\n' + String(e.stdout || e.message).split('\n').filter(l => /not ok|Error|expected|actual/.test(l)).slice(0, 10).join('\n')); }
}

if (errors.length) {
  console.error(`check: ${errors.length} problem(s)\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log('check: ok (worker tests pass)');
