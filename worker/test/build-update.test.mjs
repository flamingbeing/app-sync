// tools/build-update.mjs against a throwaway git repo: builds each update tag, and refuses to change a released one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const TOOL = new URL('../../tools/build-update.mjs', import.meta.url).pathname;
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-build-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { cwd: dir, env: { ...process.env, SYNC_ROOT: dir }, encoding: 'utf8' });
  const files = (v, extra = '') => { put('update/VERSION', v + '\n'); put('update/sw-core.js', `const CORE_VERSION = '${v}';${extra}`); put('update/register.js', `export const CORE_VERSION = '${v}';`); };
  const release = v => { files(v); assert.equal(run('--lock').status, 0); git('add', '-A'); git('commit', '-qm', v); git('tag', `update-v${v}`); };
  return { dir, git, put, run, files, release };
};

test('builds every update tag and lists the versions', () => {
  const t = mk(); t.release('0.1.0'); t.release('0.2.0');
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(t.dir, 'dist/update/0.1.0/sw-core.js'), 'utf8'), /0\.1\.0/);
  assert.match(fs.readFileSync(path.join(t.dir, 'dist/update/0.2.0/register.js'), 'utf8'), /0\.2\.0/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'dist/update/versions.json'), 'utf8')), { latest: '0.2.0', versions: ['0.1.0', '0.2.0'] });
});

test('no tags yet builds nothing and does not fail; other dist folders are left alone', () => {
  const t = mk(); t.files('0.1.0'); t.put('dist/sync/keep.txt', 'x');
  assert.equal(t.run().status, 0);
  assert.ok(fs.existsSync(path.join(t.dir, 'dist/sync/keep.txt')));
});

test('a moved tag or an edited released version stops the build', () => {
  const t = mk(); t.release('0.1.0');
  t.files('0.1.0', ' // edited'); t.git('add', '-A'); t.git('commit', '-qm', 'edit'); t.git('tag', '-f', 'update-v0.1.0');
  const r = t.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must never change/);
});

test('--lock refuses to relock a released version; --check needs the lock and matching version constants', () => {
  const t = mk(); t.release('0.1.0');
  t.files('0.1.0', ' // edited');
  assert.match(t.run('--lock').stderr, /bump the version/);
  t.files('0.2.0');
  assert.match(t.run('--check').stderr, /not in update.lock.json/);
  assert.equal(t.run('--lock').status, 0);
  assert.equal(t.run('--check').status, 0);
  t.put('update/register.js', "export const CORE_VERSION = '9.9.9';");
  assert.match(t.run('--check').stderr, /says version 9\.9\.9/);
});

// 1.0.0-rc.1: one version for both. update/VERSION goes; the update core's version is package.json's, and the sync
// tag vX.Y.Z also serves dist/update/X.Y.Z/ (update-v tags stop; the old ones are still built).
const oneVersion = (t, v, extra = '') => {
  fs.rmSync(path.join(t.dir, 'update/VERSION'), { force: true });
  t.put('package.json', JSON.stringify({ version: v }));
  t.put('update/sw-core.js', `const CORE_VERSION = '${v}';${extra}`); t.put('update/register.js', `export const CORE_VERSION = '${v}';`);
};

test('from 1.0.0-rc.1 the sync tag carries the update core: served at the same version; old update tags still built', () => {
  const t = mk(); t.release('0.2.0');
  t.put('package.json', JSON.stringify({ version: '0.9.4' })); t.git('add', '-A'); t.git('commit', '-qm', '0.9.4'); t.git('tag', 'v0.9.4');
  oneVersion(t, '1.0.0-rc.1');
  assert.match(t.run('--check').stderr, /not in update.lock.json/);
  const l = t.run('--lock'); assert.equal(l.status, 0, l.stderr);
  assert.equal(t.run('--check').status, 0);
  t.git('add', '-A'); t.git('commit', '-qm', 'rc'); t.git('tag', 'v1.0.0-rc.1');
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(t.dir, 'dist/update/1.0.0-rc.1/sw-core.js'), 'utf8'), /1\.0\.0-rc\.1/);
  assert.match(fs.readFileSync(path.join(t.dir, 'dist/update/0.2.0/register.js'), 'utf8'), /0\.2\.0/);
  assert.ok(!fs.existsSync(path.join(t.dir, 'dist/update/0.9.4')), 'a 0.x sync tag carries no update core');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'dist/update/versions.json'), 'utf8')), { latest: '0.2.0', versions: ['0.2.0', '1.0.0-rc.1'] });
});

test('from 1.0: the version constants must say package.json\'s version; an edited released core stops the build', () => {
  const t = mk(); oneVersion(t, '1.0.0-rc.1');
  t.put('update/register.js', "export const CORE_VERSION = '0.2.0';");
  assert.match(t.run('--lock').stderr, /says version 0\.2\.0/);
  oneVersion(t, '1.0.0-rc.1'); assert.equal(t.run('--lock').status, 0);
  t.git('add', '-A'); t.git('commit', '-qm', 'rc'); t.git('tag', 'v1.0.0-rc.1');
  oneVersion(t, '1.0.0-rc.1', ' // edited'); t.git('add', '-A'); t.git('commit', '-qm', 'edit'); t.git('tag', '-f', 'v1.0.0-rc.1');
  assert.match(t.run().stderr, /must never change/);
});
