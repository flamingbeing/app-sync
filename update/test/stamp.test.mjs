import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stamp } from '../tools/stamp-versions.mjs';

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>1');
  fs.writeFileSync(path.join(dir, 'app.js'), 'js 1');
  fs.writeFileSync(path.join(dir, 'sw.js'), "const VERSION = 'demo-v1';\nconst SHELL = ['./', 'app.js'];\nconst MANIFEST = {};\nimportScripts('x');\n");
  return dir;
};

test('writes a dated, hashed VERSION and a per-file manifest', () => {
  const dir = mk();
  const r = stamp({ dir, date: '2026-10-24' });
  assert.match(r.version, /^demo-v1-2026-10-24-[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(r.manifest), ['./', 'app.js']);
  const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  assert.ok(sw.includes(`const VERSION = '${r.version}';`));
  assert.ok(sw.includes(`const MANIFEST = ${JSON.stringify(r.manifest)};`));
});

test('stamping again after a change gives a new version; unchanged gives the same; the plain base is kept', () => {
  const dir = mk();
  const a = stamp({ dir, date: '2026-10-24' });
  const same = stamp({ dir, date: '2026-10-24' });
  assert.equal(same.version, a.version);
  fs.writeFileSync(path.join(dir, 'app.js'), 'js 2');
  const b = stamp({ dir, date: '2026-10-25' });
  assert.notEqual(b.version, a.version);
  assert.match(b.version, /^demo-v1-2026-10-25-/);
  assert.notEqual(b.manifest['app.js'], a.manifest['app.js']);
  assert.equal(b.manifest['./'], a.manifest['./']);
});

test('a missing SHELL file is an error (the CI check)', () => {
  const dir = mk();
  fs.rmSync(path.join(dir, 'app.js'));
  assert.throws(() => stamp({ dir, write: false }), /app\.js does not exist/);
});

test('a worker with no VERSION, SHELL or MANIFEST line is refused', () => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'sw.js'), "const VERSION = 'demo-v1';\nconst SHELL = [];\n");
  assert.throws(() => stamp({ dir }), /MANIFEST/);
});

test('only exact-pinned core.anawj.com addresses are pinned; other cross-site entries get a per-deploy hash', () => {
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'sw.js'), "const VERSION = 'demo-v1';\nconst SHELL = ['./', 'https://core.anawj.com/update/0.2.0/register.js', 'https://design.anawj.com/v1/x.css', 'https://core.anawj.com/update/latest/x.js'];\nconst MANIFEST = {};\n");
  const a = stamp({ dir, write: false, now: Date.UTC(2026, 9, 24, 1) });
  assert.equal(a.manifest['https://core.anawj.com/update/0.2.0/register.js'], 'pinned');
  assert.match(a.manifest['https://design.anawj.com/v1/x.css'], /^[0-9a-f]{12}$/);
  assert.match(a.manifest['https://core.anawj.com/update/latest/x.js'], /^[0-9a-f]{12}$/);
  const b = stamp({ dir, write: false, now: Date.UTC(2026, 9, 24, 2) });
  assert.notEqual(b.manifest['https://design.anawj.com/v1/x.css'], a.manifest['https://design.anawj.com/v1/x.css']);
});

test('the date is the last git change in SGT, else now in SGT; --date wins', () => {
  const dir = mk();
  assert.match(stamp({ dir, gitDate: '2026-10-24T20:30:00Z', now: Date.UTC(2026, 9, 30) }).version, /-2026-10-25-/);   // 04:30 SGT next day
  assert.match(stamp({ dir, gitDate: null, now: Date.UTC(2026, 9, 24, 17) }).version, /-2026-10-25-/);                 // 01:00 SGT
  assert.match(stamp({ dir, gitDate: '2026-10-24T20:30:00Z', date: '2026-01-02' }).version, /-2026-01-02-/);
});
