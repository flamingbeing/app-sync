import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, createReport, errorCode, UNCONFIRMED_MS, MAX_CODES } from '../src/report.js';
import { createReport as createReportWithVersion, VERSION } from '../index.js';
import { createWriteQueue } from '../src/writes.js';
// made-up record data that must never reach a report
const SECRET = ['rec-7f3a', 'jane.doe@example.org', 'people/rec-7f3a', 'Private note text', 'a-user-uid-123'];
const HOUR = 60 * 60 * 1000;
const job = (state, at, extra = {}) => ({ key: 'k-' + SECRET[0], kind: 'people', owner: SECRET[1], state, at, error: SECRET[3] + ' ' + SECRET[2],
  record: { id: SECRET[0], email: SECRET[1], path: SECRET[2], note: SECRET[3], uid: SECRET[4] }, base: { id: SECRET[0] }, remote: { note: SECRET[3] }, ...extra });
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), map: m }; };
const noSecrets = text => { for (const s of SECRET) assert.ok(!text.includes(s), `report leaks "${s}": ${text}`); };

test('payload has only counts, codes and versions: nothing from a record, its id, path, email or error message', () => {
  const now = 10 * HOUR;
  const entries = [job('pending', now - 2 * HOUR), job('pending', now - 1000), job('failed', now), job('conflict', now), job('synced', 0), job('archived', 0)];
  const errors = { 'permission-denied': 2, [SECRET[1]]: 1, [SECRET[2]]: 1, ['Bad: ' + SECRET[3]]: 1, unavailable: 3 };
  const p = buildReport({ app: 'demo-app', version: 'demo-v12', sync: '0.5.0', entries, errors, now });
  assert.deepEqual(Object.keys(p).sort(), ['app', 'conflicts', 'errors', 'refused', 'sync', 'unconfirmed', 'v', 'version']);
  assert.deepEqual(p, { v: 1, app: 'demo-app', version: 'demo-v12', sync: '0.5.0', unconfirmed: 1, refused: 1, conflicts: 1, errors: { 'permission-denied': 2, other: 3, unavailable: 3 } });
  noSecrets(JSON.stringify(p));
  for (const [k, n] of Object.entries(p.errors)) { assert.match(k, /^[a-z][a-z0-9-]{0,39}$/); assert.equal(typeof n, 'number'); }
});

test('an app id or version that could carry data is refused; a bad sync version reads unknown', () => {
  assert.throws(() => buildReport({ app: SECRET[1], version: 'v1' }), /app/);
  assert.throws(() => buildReport({ app: 'demo', version: SECRET[2] }), /version/);
  assert.throws(() => createReport({ app: 'Demo App', version: 'v1' }), /app/);
  assert.equal(buildReport({ app: 'demo', version: 'v1', sync: SECRET[1] }).sync, 'unknown');
});

test('error codes: short lower-case words kept, the rest is other, at most MAX_CODES', () => {
  assert.equal(errorCode('deadline-exceeded'), 'deadline-exceeded');
  assert.equal(errorCode(undefined), 'unknown');
  assert.equal(errorCode({ toString: () => SECRET[1] }), 'other');
  assert.equal(errorCode('x'.repeat(41)), 'other');
  const errors = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['code-' + i, 1]));
  const p = buildReport({ app: 'demo', version: 'v1', errors });
  assert.ok(Object.keys(p.errors).length <= MAX_CODES + 1);
  assert.equal(Object.values(p.errors).reduce((a, b) => a + b, 0), 30);
});

test('unconfirmed counts only saves waiting longer than an hour', () => {
  const now = 5 * HOUR;
  const p = buildReport({ app: 'demo', version: 'v1', now, entries: [job('pending', now - UNCONFIRMED_MS), job('pending', now - UNCONFIRMED_MS + 1)] });
  assert.equal(p.unconfirmed, 1);
});

test('sends at most once an hour; errors survive a reload and are taken off only once sent', async () => {
  let t = 100 * HOUR, sent = [], ok = true;
  const storage = memoryStorage();
  const make = () => createReport({ app: 'demo', version: 'v1', sync: '0.5.0', storage, now: () => t, send: (url, body) => { if (ok) sent.push({ url, body }); return ok; } });
  const r = make();
  r.error('unavailable'); r.error('unavailable');
  assert.equal(await r.flush(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://core.anawj.com/report');
  assert.deepEqual(JSON.parse(sent[0].body).errors, { unavailable: 2 });
  r.error('permission-denied');
  t += HOUR - 1;
  assert.equal(await r.flush(), false);   // not an hour yet
  const again = make();                    // a reload keeps the count and the last send
  assert.equal(await again.flush(), false);
  t += 1; ok = false;
  assert.equal(await again.flush(), false); // not handed over: kept
  ok = true;
  assert.equal(await again.flush(), true);
  assert.deepEqual(JSON.parse(sent[1].body).errors, { 'permission-denied': 1 });
  assert.equal(await again.flush({ force: true }), true);
  assert.deepEqual(JSON.parse(sent[2].body).errors, {});
});

test('a throwing send or broken storage never throws into the app', async () => {
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const r = createReport({ app: 'demo', version: 'v1', storage, send: () => { throw new Error('offline'); } });
  r.error('unavailable');
  assert.equal(await r.flush({ force: true }), false);
});

test('page hide sends; start and stop leave no listener behind', async () => {
  const handlers = new Map(), sent = [];
  globalThis.document = { visibilityState: 'visible', addEventListener: (n, f) => handlers.set(n, f), removeEventListener: n => handlers.delete(n) };
  try {
    const r = createReport({ app: 'demo', version: 'v1', send: (_u, b) => { sent.push(b); return true; } });
    r.start();
    document.visibilityState = 'hidden';
    handlers.get('visibilitychange')();
    await new Promise(res => setTimeout(res, 0));
    assert.equal(sent.length, 1);
    r.stop();
    assert.equal(handlers.size, 0);
  } finally { delete globalThis.document; }
});

test('the write queue counts its entries and each failed send by code only (opt-in)', async () => {
  const records = new Map();
  const store = { async put(x) { records.set(x.key, structuredClone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o); }, async get(k) { return records.get(k) || null; }, async remove(k) { records.delete(k); }, async forget() {} };
  let t = 50 * HOUR;
  const sent = [];
  const report = createReport({ app: 'demo', version: 'v1', now: () => t, send: (_u, b) => { sent.push(b); return true; } });
  const backend = async () => { const e = new Error('Missing permission for ' + SECRET[2] + ' (' + SECRET[1] + ')'); e.code = 'permission-denied'; throw e; };
  const queue = createWriteQueue({ store, backend, getOwner: () => SECRET[1], report });
  await queue.activate(SECRET[1]);
  await assert.rejects(queue.save('people', SECRET[1], { id: SECRET[0], email: SECRET[1], note: SECRET[3] }));
  assert.equal(await report.flush({ force: true }), true);
  const p = JSON.parse(sent[0]);
  assert.equal(p.refused, 1);
  assert.deepEqual(p.errors, { 'permission-denied': 1 });
  noSecrets(sent[0]);
});

test('a queue without report works as before', async () => {
  const store = { async put() {}, async list() { return []; }, async get() { return null; }, async remove() {}, async forget() {} };
  const queue = createWriteQueue({ store, backend: async (_o, _k, r) => r, getOwner: () => 'a' });
  await queue.activate('a');
  await queue.save('item', 'a', { id: '1' });
  assert.equal(queue.pending(), 0);
});

test('index.js fills in the engine version', () => {
  const r = createReportWithVersion({ app: 'demo', version: 'v1' });
  assert.equal(r.payload().sync, VERSION);
});
