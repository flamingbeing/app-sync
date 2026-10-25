// worker/report.js (the nothing-lost report endpoint) with a stand-in for D1 on Node's SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../sites.js';
import { parseReport, ourOrigin, digestText, sgtDay, MAX_BODY, RATE } from '../report.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: sql => statement(sql), batch: async list => { db.exec('BEGIN'); try { for (const s of list) await s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; }, raw: db };
}
const H = 'https://core.anawj.com';
const SITE = 'https://demo.anawj.com';
const good = (extra = {}) => ({ v: 1, app: 'demo', version: 'demo-v3', sync: '0.5.0', unconfirmed: 0, refused: 0, conflicts: 0, errors: {}, ...extra });
let ip = 0;
const post = (env, body, { origin = SITE, address = '10.0.0.' + (++ip) } = {}) => worker.fetch(new Request(H + '/report', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': address } }), env);
const digest = (env, token = 'right-token', day = '') => worker.fetch(new Request(H + '/report/digest' + (day ? '?day=' + day : ''), { headers: token ? { Authorization: 'Bearer ' + token } : {} }), env);
const fresh = () => ({ REPORTS: fakeD1(), REPORT_TOKEN: 'right-token', ASSETS: { fetch: async () => new Response('', { status: 404 }) } });

test('a good report is stored as per-app daily counts: highest snapshot, errors summed', async () => {
  const env = fresh();
  let r = await post(env, good({ unconfirmed: 2, errors: { unavailable: 1 } }));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), SITE);
  r = await post(env, good({ unconfirmed: 1, refused: 1, errors: { unavailable: 2, 'permission-denied': 1 } }));
  assert.equal(r.status, 204);
  const day = sgtDay(Date.now());
  const res = await digest(env, 'right-token', day);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.send, true);
  assert.deepEqual(d.apps, [{ app: 'demo', reports: 2, unconfirmed: 2, refused: 1, conflicts: 0, version: 'demo-v3', sync: '0.5.0', errors: { unavailable: 3, 'permission-denied': 1 } }]);
  assert.match(d.text, /demo .*2 unconfirmed > 1 h; 1 refused; errors: unavailable 3, permission-denied 1/);
});

test('reports carrying anything but counts and short words are refused, nothing stored', async () => {
  const env = fresh();
  for (const bad of [
    good({ note: 'Private note' }), good({ app: 'jane.doe@example.org' }), good({ version: 'people/rec-1' }),
    good({ refused: 'rec-1' }), good({ refused: -1 }), good({ refused: 1.5 }), good({ errors: { 'Bad text here': 1 } }),
    good({ errors: { unavailable: 'x' } }), good({ errors: ['unavailable'] }), good({ v: 2 }), '[1]', 'not json',
  ]) {
    const r = await post(env, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const rows = env.REPORTS.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const t of rows) assert.equal(env.REPORTS.raw.prepare(`SELECT count(*) AS n FROM ${t.name}`).get().n, 0);
});

test('only our sites may send (CORS); others get no CORS headers', async () => {
  const env = fresh();
  for (const origin of ['https://evil.example', 'http://demo.anawj.com', 'https://anawj.com.evil.example', 'https://xanawj.com', null]) {
    const r = await post(env, good(), { origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.ok(ourOrigin('https://anawj.com') && ourOrigin('https://pantry.flamingbeing.com') && ourOrigin('https://x.anantf.com'));
  const pre = await worker.fetch(new Request(H + '/report', { method: 'OPTIONS', headers: { Origin: SITE } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'POST');
});

test('size and rate limits', async () => {
  const env = fresh();
  const big = JSON.stringify(good()).replace('"errors":{}', '"errors":{},' + '"x":"' + 'a'.repeat(MAX_BODY) + '"');
  assert.equal((await post(env, big)).status, 413);
  for (let i = 0; i < RATE; i++) assert.equal((await post(env, good(), { address: '10.9.9.9' })).status, 204);
  assert.equal((await post(env, good(), { address: '10.9.9.9' })).status, 429);
  assert.equal((await post(env, good(), { address: '10.9.9.8' })).status, 204);
});

test('the digest needs the token; GET on /report is refused', async () => {
  const env = fresh();
  assert.equal((await digest(env, '')).status, 401);
  assert.equal((await digest(env, 'wrong-token')).status, 401);
  assert.equal((await digest({ ...env, REPORT_TOKEN: undefined }, 'undefined')).status, 401);
  assert.equal((await worker.fetch(new Request(H + '/report', { headers: { Origin: SITE } }), env)).status, 405);
  assert.equal((await digest(env)).status, 200);
});

test('digest text: silent when all clear except Mondays', () => {
  const quiet = [{ app: 'demo', reports: 3, unconfirmed: 0, refused: 0, conflicts: 0, version: 'v1', sync: '0.5.0', errors: {} }];
  assert.equal(digestText({ day: '2026-10-24', apps: quiet, monday: false }).send, false);
  const m = digestText({ day: '2026-10-25', apps: quiet, monday: true });
  assert.equal(m.send, true);
  assert.match(m.text, /all clear \(1 app reported: demo\)/);
  assert.equal(digestText({ day: '2026-10-24', apps: [{ ...quiet[0], conflicts: 1 }], monday: false }).send, true);
});

test('parseReport keeps only the known fields', () => {
  assert.deepEqual(parseReport(JSON.stringify(good({ errors: { unavailable: 2, aborted: 0 } }))), { app: 'demo', version: 'demo-v3', sync: '0.5.0', unconfirmed: 0, refused: 0, conflicts: 0, errors: { unavailable: 2 } });
  assert.equal(sgtDay(Date.UTC(2026, 9, 24, 16, 0)), '2026-10-25');
});

test('held conflicts by kind (0.6.3): stored as the day\'s highest per kind, shown in the digest; bad kinds refused', async () => {
  const env = fresh();
  assert.equal((await post(env, good({ conflicts: 3, held: { note: 2, task: 1 } }))).status, 204);
  assert.equal((await post(env, good({ conflicts: 1, held: { note: 1 } }))).status, 204);
  assert.equal((await post(env, good())).status, 204);   // a report without held (an older engine) still counts
  for (const held of [{ 'not a kind': 1 }, { note: -1 }, { note: 'x' }, [1], Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['k' + i, 1]))]) {
    assert.equal((await post(env, good({ conflicts: 1, held }))).status, 400, JSON.stringify(held));
  }
  const d = await (await digest(env, 'right-token', sgtDay(Date.now()))).json();
  assert.deepEqual(d.apps[0].held, { note: 2, task: 1 });
  assert.match(d.text, /3 conflicts \(note 2, task 1\)/);
  assert.deepEqual(parseReport(JSON.stringify(good({ held: { note: 0 } }))).held, undefined);
});
