// 0.9.2: the stored formats freeze (FORMATS.md). The device and job sections are pinned by hash: a change to them is a
// format change (2.0 only). Adding an optional field (1.x) is a deliberate edit: update FORMATS.md, the hash here and
// the CHANGELOG together.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStores } from '../src/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const formats = fs.readFileSync(path.join(ROOT, 'FORMATS.md'), 'utf8');
const section = title => {
  const at = formats.indexOf(`\n${title}\n`);
  assert.ok(at >= 0, `FORMATS.md has "${title}"`);
  const rest = formats.slice(at + title.length + 2);
  return rest.slice(0, rest.search(/\n#{2,3} /) >>> 0).replace(/\s+/g, ' ').trim();
};
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const PINNED = {
  '## On the device': 'c0bf6e7783d37ef6',
  '### Which scope holds a record (frozen at 0.9.2)': 'ddb9ff2667fcd059',
  '### A job (one save in the outbox)': '49c21c89eacd933a',
  '## On the server (Firestore adapter)': '2070ef3977198ad0',
};

test('the frozen sections of FORMATS.md are the pinned ones', () => {
  const now = Object.fromEntries(Object.keys(PINNED).map(t => [t, hash(section(t))]));
  assert.deepEqual(now, PINNED, 'a stored format changed: 2.0 only (an added optional field: update the hash with a CHANGELOG line)');
});

test('a record belongs to the scope whose database holds it: the name carries the scope, the record is stored as given', async () => {
  const s = createStores({ prefix: 'fx-sync:', colls: ['items'] });
  const a = await s.openStore(' Team-A '), b = await s.openStore('team-b');
  assert.equal(a.name, 'fx-sync:team-a');
  assert.equal(b.name, 'fx-sync:team-b');
  const rec = { id: 'r1', text: 'x', updatedAt: 5 };
  await a.write('items', { put: [rec], meta: { coll: 'items', syncAt: 5, fullAt: 5, gone: {} } });
  const got = await a.load('items');
  assert.deepEqual(got.docs, [rec], 'no scope or other field is added to the record');
  assert.deepEqual((await b.load('items')).docs, [], 'the same id in another scope is another record');
  // a record dropped without a gone entry is not a delete: only meta.gone carries deletes
  await a.write('items', { del: ['r1'], meta: { coll: 'items', syncAt: 6, fullAt: 5, gone: {} } });
  assert.deepEqual((await a.load('items')).meta.gone, {});
  const r = createStores({ prefix: 'fx-sync:', colls: ['items'], realm: 'demo:' });
  assert.equal((await r.openStore('t')).name, 'fx-sync:demo:t');
});
