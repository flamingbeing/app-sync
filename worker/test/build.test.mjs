// tools/build-sync.mjs against a throwaway git repo: builds each tag, and refuses to change a released version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const TOOL = new URL('../../tools/build-sync.mjs', import.meta.url).pathname;
const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-build-'));
  const sh = (cmd, ...a) => execFileSync(cmd, a, { cwd: dir, stdio: 'pipe' });
  const git = (...a) => sh('git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
  git('init', '-q');
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { cwd: dir, env: { ...process.env, SYNC_ROOT: dir }, encoding: 'utf8' });
  const release = v => { put('package.json', JSON.stringify({ version: v })); put('index.js', `export const VERSION = '${v}';`); put('src/a.js', `// ${v}`);
    assert.equal(run('--lock').status, 0); git('add', '-A'); git('commit', '-qm', v); git('tag', `v${v}`); };
  return { dir, git, put, run, release };
};

test('builds every tag and lists the versions', () => {
  const t = mk(); t.release('0.1.0'); t.release('0.2.0');
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(t.dir, 'dist/sync/0.1.0/src/a.js'), 'utf8'), '// 0.1.0');
  assert.equal(fs.readFileSync(path.join(t.dir, 'dist/sync/0.2.0/src/a.js'), 'utf8'), '// 0.2.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'dist/sync/versions.json'), 'utf8')), { latest: '0.2.0', versions: ['0.1.0', '0.2.0'] });
});

test('a moved tag or an edited released version stops the build', () => {
  const t = mk(); t.release('0.1.0');
  t.put('src/a.js', '// changed'); t.git('add', '-A'); t.git('commit', '-qm', 'edit'); t.git('tag', '-f', 'v0.1.0');
  const r = t.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must never change/);
});

test('--lock and --check refuse to relock a released version, and require the lock for a new one', () => {
  const t = mk(); t.release('0.1.0');
  t.put('src/a.js', '// edited'); 
  assert.match(t.run('--lock').stderr, /bump the version/);
  t.put('package.json', JSON.stringify({ version: '0.2.0' }));
  assert.match(t.run('--check').stderr, /not in versions.lock.json/);
  assert.equal(t.run('--lock').status, 0);
  assert.equal(t.run('--check').status, 0);
});

test('a pre-release tag (v1.0.0-rc.1) builds and sorts before its release; latest stays the last stable version', () => {
  const t = mk(); t.release('0.9.4'); t.release('1.0.0-rc.1');
  let r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(t.dir, 'dist/sync/1.0.0-rc.1/src/a.js'), 'utf8'), '// 1.0.0-rc.1');
  const listed = () => JSON.parse(fs.readFileSync(path.join(t.dir, 'dist/sync/versions.json'), 'utf8'));
  assert.deepEqual(listed(), { latest: '0.9.4', versions: ['0.9.4', '1.0.0-rc.1'] });
  t.release('1.0.0'); t.release('0.10.0');
  r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listed(), { latest: '1.0.0', versions: ['0.9.4', '0.10.0', '1.0.0-rc.1', '1.0.0'] });
});
