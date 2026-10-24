// Repo checks for mistakes tests don't catch. Run before merging: node tools/check.mjs
// 1. Each app's sw.js has a plain VERSION starting with its folder name (no deploy stamp) and deletes only caches with
//    its own prefix (apps can share an origin).
// 2. Every file in an app's SHELL list exists.
// 3. wrangler.jsonc keeps preview links and the workers.dev address off.
// 4. The Worker's tests pass (node --test 'worker/test/*.test.mjs').
// Exits 1 on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = msg => errors.push(msg);

const apps = fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'sw.js')));
for (const app of apps) {
  const swPath = `${app}/sw.js`;
  const sw = fs.readFileSync(path.join(ROOT, swPath), 'utf8');
  const prefix = `${app}-`;

  const version = sw.match(/const VERSION = '([^']+)'/)?.[1];
  if (!version) fail(`${swPath}: no VERSION constant`);
  else if (!version.startsWith(prefix)) fail(`${swPath}: VERSION '${version}' should start with '${prefix}'`);
  // a stamped VERSION (from a deploy build) committed by mistake
  else if (/-[0-9a-f]{8}$/.test(version)) fail(`${swPath}: VERSION '${version}' carries a deploy stamp; put back the plain '${version.replace(/-(\d{4}-\d{2}-\d{2}-)?[0-9a-f]{8}$/, '')}'`);

  for (const line of sw.split('\n').filter(l => l.includes('caches.delete'))) {
    if (!line.includes(`startsWith('${prefix}')`)) fail(`${swPath}: caches.delete without a startsWith('${prefix}') guard deletes other apps' caches:\n    ${line.trim()}`);
  }

  const shellSrc = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1];
  if (!shellSrc) { fail(`${swPath}: no SHELL list`); continue; }
  const shell = [...shellSrc.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(f => f !== './')
    .map(f => path.posix.normalize(`${app}/${f}`));
  for (const f of shell) if (!fs.existsSync(path.join(ROOT, f))) fail(`${swPath}: SHELL lists ${f}, which doesn't exist`);
}

const wrangler = path.join(ROOT, 'wrangler.jsonc');
if (fs.existsSync(wrangler)) {
  const w = fs.readFileSync(wrangler, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  if (!/"preview_urls"\s*:\s*false/.test(w)) fail('wrangler.jsonc: "preview_urls" should be false (no preview links)');
  if (!/"workers_dev"\s*:\s*false/.test(w)) fail('wrangler.jsonc: "workers_dev" should be false (real addresses only)');
}

if (fs.existsSync(path.join(ROOT, 'worker/test'))) {
  try { execFileSync(process.execPath, ['--test', 'worker/test/*.test.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { fail('worker tests failed:\n' + String(e.stdout || e.message).split('\n').filter(l => /not ok|Error|expected|actual/.test(l)).slice(0, 10).join('\n')); }
}

if (errors.length) {
  console.error(`check: ${errors.length} problem(s)\n- ` + errors.join('\n- '));
  process.exit(1);
}
console.log(`check: ok (${apps.join(', ') || 'no apps'}; worker tests pass)`);
