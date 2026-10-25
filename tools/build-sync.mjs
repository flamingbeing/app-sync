// Builds the folder the Worker serves: dist/sync/<x.y.z>/ for every release tag vX.Y.Z, read from git (so a deploy
// always rebuilds the same bytes), plus dist/sync/versions.json. Every version's files are checked against
// versions.lock.json, so a moved tag or a changed file stops the deploy instead of changing a released version.
//   node tools/build-sync.mjs           build dist/ from the tags and verify against the lock
//   node tools/build-sync.mjs --lock    add the package.json version (from the working tree) to the lock; part of a release
//   node tools/build-sync.mjs --check   only check that the package.json version is locked and matches the working tree
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ROOT = process.env.SYNC_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUBLISHED = ['index.js', 'app.js', 'auth.js', 'sync.js', 'update.js', 'files.json', 'entries.json', 'src', 'types', 'LICENSE', 'NOTICE'];   // what a version contains (files.json from 0.8.0; app.js, auth.js from 0.9.0; sync.js, update.js from 0.9.1; types/ from 0.9.2; entries.json from 0.9.4)
const LOCK = path.join(ROOT, 'versions.lock.json');
const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26, ...opts });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readLock = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {});
const semver = v => v.split('.').map(Number);
const byVersion = (a, b) => { const x = semver(a), y = semver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

// { 'src/sync.js': Buffer, … } for a tag
function tagFiles(tag) {
  const names = git(['ls-tree', '-r', '--name-only', tag, '--', ...PUBLISHED]).toString().split('\n').filter(Boolean);
  return Object.fromEntries(names.map(n => [n, git(['show', `${tag}:${n}`])]));
}
function treeFiles() {
  const out = {};
  const walk = rel => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).sort().forEach(f => walk(path.posix.join(rel, f)));
    else out[rel] = fs.readFileSync(abs);
  };
  PUBLISHED.forEach(walk);
  return out;
}
const hashes = files => Object.fromEntries(Object.keys(files).sort().map(n => [n, sha(files[n])]));
const sameHashes = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function lockVersion({ write }) {
  const v = pkgVersion(), lock = readLock(), h = hashes(treeFiles());
  if (lock[v]) {
    if (!sameHashes(lock[v], h)) throw new Error(`version ${v} is already released and locked, but its files differ: bump the version instead of editing it`);
    return `${v} is locked and matches`;
  }
  if (!write) throw new Error(`version ${v} is not in versions.lock.json: run node tools/build-sync.mjs --lock and commit it`);
  lock[v] = h;
  const sorted = Object.fromEntries(Object.keys(lock).sort(byVersion).map(k => [k, lock[k]]));
  fs.writeFileSync(LOCK, JSON.stringify(sorted, null, 2) + '\n');
  return `${v} added to versions.lock.json`;
}

function build() {
  const tags = git(['tag', '--list', 'v*']).toString().split('\n').filter(t => /^v\d+\.\d+\.\d+$/.test(t));
  if (!tags.length) throw new Error('no release tags (vX.Y.Z) found; fetch tags first');
  const lock = readLock(), out = path.join(ROOT, 'dist', 'sync');
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
  const versions = [];
  for (const tag of tags) {
    const v = tag.slice(1), files = tagFiles(tag);
    if (!lock[v]) throw new Error(`${tag} is not in versions.lock.json`);
    if (!sameHashes(lock[v], hashes(files))) throw new Error(`${tag} does not match versions.lock.json: a released version must never change`);
    for (const [n, buf] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(out, v, n)), { recursive: true });
      fs.writeFileSync(path.join(out, v, n), buf);
    }
    versions.push(v);
  }
  versions.sort(byVersion);
  fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify({ latest: versions.at(-1), versions }, null, 2) + '\n');
  return `built ${versions.join(', ')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = process.argv[2];
  try { console.log(arg === '--lock' ? lockVersion({ write: true }) : arg === '--check' ? lockVersion({ write: false }) : build()); }
  catch (e) { console.error('build-sync: ' + e.message); process.exit(1); }
}
