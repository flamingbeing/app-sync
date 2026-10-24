// Builds dist/update/<x.y.z>/ (sw-core.js, register.js) for every tag update-vX.Y.Z, read from git, plus
// dist/update/versions.json. Every version is checked against update.lock.json (hashes), so a moved tag or an edited
// released file stops the deploy. Run after tools/build-sync.mjs (it leaves the rest of dist/ alone).
//   node tools/build-update.mjs           build dist/update/ from the tags and verify against the lock
//   node tools/build-update.mjs --lock    add update/VERSION (from the working tree) to the lock; part of a release
//   node tools/build-update.mjs --check   only check that update/VERSION is locked and matches the working tree
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.SYNC_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILES = ['sw-core.js', 'register.js'];   // what a version contains, from update/
const LOCK = path.join(ROOT, 'update.lock.json');
const git = args => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26 });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readLock = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {});
const semver = v => v.split('.').map(Number);
const byVersion = (a, b) => { const x = semver(a), y = semver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const hashes = files => Object.fromEntries(FILES.map(n => [n, sha(files[n])]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const treeFiles = () => Object.fromEntries(FILES.map(n => [n, fs.readFileSync(path.join(ROOT, 'update', n))]));
const tagFiles = tag => Object.fromEntries(FILES.map(n => [n, git(['show', `${tag}:update/${n}`])]));

function lockVersion({ write }) {
  const v = fs.readFileSync(path.join(ROOT, 'update/VERSION'), 'utf8').trim(), files = treeFiles();
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`update/VERSION '${v}' is not x.y.z`);
  for (const n of FILES) {
    const inFile = files[n].toString().match(/CORE_VERSION = '([^']+)'/)?.[1];
    if (inFile !== v) throw new Error(`update/${n} says version ${inFile}, but update/VERSION is ${v}`);
  }
  const lock = readLock(), h = hashes(files);
  if (lock[v]) {
    if (!same(lock[v], h)) throw new Error(`update ${v} is already released and locked, but its files differ: bump the version instead of editing it`);
    return `update ${v} is locked and matches`;
  }
  if (!write) throw new Error(`update ${v} is not in update.lock.json: run node tools/build-update.mjs --lock and commit it`);
  lock[v] = h;
  fs.writeFileSync(LOCK, JSON.stringify(Object.fromEntries(Object.keys(lock).sort(byVersion).map(k => [k, lock[k]])), null, 2) + '\n');
  return `update ${v} added to update.lock.json`;
}

function build() {
  const tags = git(['tag', '--list', 'update-v*']).toString().split('\n').filter(t => /^update-v\d+\.\d+\.\d+$/.test(t));
  const out = path.join(ROOT, 'dist', 'update');
  fs.rmSync(out, { recursive: true, force: true });
  if (!tags.length) return 'no update-vX.Y.Z tags yet; nothing built';
  const lock = readLock(), versions = [];
  for (const tag of tags) {
    const v = tag.slice('update-v'.length), files = tagFiles(tag);
    if (!lock[v]) throw new Error(`${tag} is not in update.lock.json`);
    if (!same(lock[v], hashes(files))) throw new Error(`${tag} does not match update.lock.json: a released version must never change`);
    fs.mkdirSync(path.join(out, v), { recursive: true });
    for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(out, v, n), buf);
    versions.push(v);
  }
  versions.sort(byVersion);
  fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify({ latest: versions.at(-1), versions }, null, 2) + '\n');
  return `built update ${versions.join(', ')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = process.argv[2];
  try { console.log(arg === '--lock' ? lockVersion({ write: true }) : arg === '--check' ? lockVersion({ write: false }) : build()); }
  catch (e) { console.error('build-update: ' + e.message); process.exit(1); }
}
