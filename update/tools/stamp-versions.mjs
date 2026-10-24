// Deploy stamp for an app that uses app-update: reads sw.js, hashes every file in its SHELL list, and writes
//   const VERSION = '<app>-<date>-<hash8>';     (the plain '<app>-v1' is kept in git; the deploy stamps it)
//   const MANIFEST = {"./":"<hash12>", "app.js":"<hash12>", ...};
// back into sw.js. Copy this file into the app's tools/ folder.
//   node tools/stamp-versions.mjs <dir> [--sw sw.js] [--date YYYY-MM-DD]   stamp (deploy build)
//   node tools/stamp-versions.mjs <dir> --check                           only check that every SHELL file exists (CI)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const STAMP = /-(\d{4}-\d{2}-\d{2}-)?[0-9a-f]{8}$/;
// only an exact-version address on core.anawj.com never changes; any other cross-site file (e.g. design.anawj.com/v1/)
// may change under the same address, so it gets a new hash every deploy and the phones fetch it again
const PINNED = /^https:\/\/core\.anawj\.com\/[a-z0-9-]+\/\d+\.\d+\.\d+\//;
const sgtDay = t => new Date(new Date(t).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const lastChange = dir => { try { return execFileSync('git', ['log', '-1', '--format=%cI', '--', '.'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch (e) { return null; } };

// now, gitDate: for tests (gitDate: the last git change of dir as ISO, null for none)
export function stamp({ dir, sw = 'sw.js', date, write = true, now = Date.now(), gitDate }) {
  const swPath = path.join(dir, sw);
  let src = fs.readFileSync(swPath, 'utf8');
  const version = src.match(/const VERSION = '([^']+)'/)?.[1];
  if (!version) throw new Error(`${sw}: no VERSION constant`);
  const shellSrc = src.match(/const SHELL = \[([\s\S]*?)\];/)?.[1];
  if (shellSrc == null) throw new Error(`${sw}: no SHELL list`);
  if (!/^const MANIFEST = .*;$/m.test(src)) throw new Error(`${sw}: no 'const MANIFEST = {};' line`);
  const shell = [...shellSrc.matchAll(/'([^']+)'/g)].map(m => m[1]);
  const manifest = {};
  for (const u of shell) {
    if (PINNED.test(u)) { manifest[u] = 'pinned'; continue; }   // an exact-pin address (core.anawj.com/update/0.2.0/...): its version is its identity
    if (/^https?:\/\//.test(u)) { manifest[u] = sha(`${u} ${now}`).slice(0, 12); continue; }   // mutable: per deploy
    const rel = u === './' ? 'index.html' : u.split('?')[0].split('#')[0];
    const file = path.join(dir, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${sw}: SHELL lists ${u}, but ${rel} does not exist`);
    manifest[u] = sha(fs.readFileSync(file)).slice(0, 12);
  }
  if (!write) return { version, manifest };
  const base = version.replace(STAMP, '');
  const line = JSON.stringify(manifest);
  const plain = src.replace(/const VERSION = '[^']+'/, `const VERSION = '${base}'`).replace(/^const MANIFEST = .*;$/m, 'const MANIFEST = {};');
  const hash8 = sha(plain + line).slice(0, 8);
  if (gitDate === undefined) gitDate = lastChange(dir);
  const day = date || sgtDay(gitDate || now);   // the last git change of the app, in SGT
  src = src.replace(/const VERSION = '[^']+'/, `const VERSION = '${base}-${day}-${hash8}'`).replace(/^const MANIFEST = .*;$/m, () => `const MANIFEST = ${line};`);
  fs.writeFileSync(swPath, src);
  return { version: `${base}-${day}-${hash8}`, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), dir = a.find(x => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--sw' && a[a.indexOf(x) - 1] !== '--date');
  const opt = n => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  try {
    const r = stamp({ dir: dir || '.', sw: opt('--sw'), date: opt('--date'), write: !a.includes('--check') });
    console.log(a.includes('--check') ? `stamp-versions: ok (${Object.keys(r.manifest).length} shell files exist)` : `stamp-versions: ${r.version}`);
  } catch (e) { console.error('stamp-versions: ' + e.message); process.exit(1); }
}
