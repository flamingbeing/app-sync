// Builds dist/update/<version>/ (sw-core.js, register.js), read from git, plus dist/update/versions.json (latest: the
// last stable version). Until 0.9.x the update core had its own version (update/VERSION, tags update-vX.Y.Z); from
// 1.0.0-rc.1 it has the engine's (package.json): the sync tag vX.Y.Z serves /update/X.Y.Z/ too, and update-v tags
// stop (the old ones are still built). Every version is checked against update.lock.json (hashes), so a moved tag or an
// edited released file stops the deploy. Run after tools/build-sync.mjs (it leaves the rest of dist/ alone).
//   node tools/build-update.mjs           build dist/update/ from the tags and verify against the lock
//   node tools/build-update.mjs --lock    add the update core's version (from the working tree) to the lock; a release step
//   node tools/build-update.mjs --check   only check that that version is locked and matches the working tree
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { VERSION_RE, byVersion, listing } from './semver.mjs';

const ROOT = process.env.SYNC_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILES = ['sw-core.js', 'register.js'];   // what a version contains, from update/
const LOCK = path.join(ROOT, 'update.lock.json');
const git = args => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26 });
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const readLock = () => (fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : {});
// the first engine version that carries the update core (one version for both)
const ONE_VERSION = '1.0.0-rc.1';
const hashes = files => Object.fromEntries(FILES.map(n => [n, sha(files[n])]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const treeFiles = () => Object.fromEntries(FILES.map(n => [n, fs.readFileSync(path.join(ROOT, 'update', n))]));
const tagFiles = tag => Object.fromEntries(FILES.map(n => [n, git(['show', `${tag}:update/${n}`])]));
// the working tree's update core version: update/VERSION until 0.9.x, then package.json's
function treeVersion() {
  const own = path.join(ROOT, 'update/VERSION');
  if (fs.existsSync(own)) return fs.readFileSync(own, 'utf8').trim();
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function lockVersion({ write }) {
  const v = treeVersion(), files = treeFiles();
  if (!VERSION_RE.test(v)) throw new Error(`the update core's version '${v}' is not x.y.z`);
  if (!fs.existsSync(path.join(ROOT, 'update/VERSION')) && byVersion(v, ONE_VERSION) < 0) throw new Error(`update/VERSION is gone, but ${v} is before ${ONE_VERSION}`);
  for (const n of FILES) {
    const inFile = files[n].toString().match(/CORE_VERSION = '([^']+)'/)?.[1];
    if (inFile !== v) throw new Error(`update/${n} says version ${inFile}, but the version is ${v}`);
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
  const list = pattern => git(['tag', '--list', pattern]).toString().split('\n').filter(Boolean);
  // [tag, version]: the update core's own tags (until 0.9.x), and the engine's tags from 1.0.0-rc.1 on
  const tags = [
    ...list('update-v*').map(t => [t, t.slice('update-v'.length)]).filter(([, v]) => /^\d+\.\d+\.\d+$/.test(v)),
    ...list('v*').map(t => [t, t.slice(1)]).filter(([, v]) => VERSION_RE.test(v) && byVersion(v, ONE_VERSION) >= 0),
  ];
  const out = path.join(ROOT, 'dist', 'update');
  fs.rmSync(out, { recursive: true, force: true });
  if (!tags.length) return 'no update tags yet; nothing built';
  const lock = readLock(), versions = [];
  for (const [tag, v] of tags) {
    if (versions.includes(v)) throw new Error(`update ${v} is tagged twice (update-v${v} and v${v})`);
    const files = tagFiles(tag);
    if (!lock[v]) throw new Error(`${tag} is not in update.lock.json`);
    if (!same(lock[v], hashes(files))) throw new Error(`${tag} does not match update.lock.json: a released version must never change`);
    fs.mkdirSync(path.join(out, v), { recursive: true });
    for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(out, v, n), buf);
    versions.push(v);
  }
  const listed = listing(versions);
  fs.writeFileSync(path.join(out, 'versions.json'), JSON.stringify(listed, null, 2) + '\n');
  return `built update ${listed.versions.join(', ')}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = process.argv[2];
  try { console.log(arg === '--lock' ? lockVersion({ write: true }) : arg === '--check' ? lockVersion({ write: false }) : build()); }
  catch (e) { console.error('build-update: ' + e.message); process.exit(1); }
}
