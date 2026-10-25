// The nothing-lost report endpoint (src/report.js sends to it): core.anawj.com/report.
//
// POST /report          one report from an app: { v: 1, app, version, sync, unconfirmed, refused, conflicts, errors }.
//                       At most MAX_BODY bytes, from a browser on one of OUR_SITES only (CORS), RATE reports per address
//                       per ten minutes (per Worker instance). Stored as per-app daily counts in D1 (binding REPORTS):
//                       the highest unconfirmed / refused / conflicts any device reported that day, and errors summed.
// GET  /report/digest   the owner's digest of yesterday (SGT): needs "Authorization: Bearer <REPORT_TOKEN>" (a Worker
//                       secret). -> { send, text, day, apps }: send is true when a count is non-zero, and on Mondays
//                       ("all clear") so silence means the check still runs.
// No record data is accepted: parseReport keeps only the fields above, each a number or a short word.

export const MAX_BODY = 2048;
export const RATE = 20;
const RATE_MS = 10 * 60 * 1000;
const MAX_CODES = 20;
// browsers on these sites (and their subdomains) may send; nothing else gets CORS headers
export const OUR_SITES = ['anawj.com', 'anantf.com', 'flamingbeing.com'];
const APP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const COUNT = n => Number.isInteger(n) && n >= 0 && n <= 1e6;

export function ourOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' || u.port || u.pathname !== '/' || origin !== u.origin) return false;
    return OUR_SITES.some(site => u.hostname === site || u.hostname.endsWith('.' + site));
  } catch { return false; }
}

// -> the report, or null when anything in it is not as expected (an unknown field, a string where a count goes, …)
export function parseReport(text) {
  if (typeof text !== 'string' || text.length > MAX_BODY) return null;
  let x;
  try { x = JSON.parse(text); } catch { return null; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const keys = ['v', 'app', 'version', 'sync', 'unconfirmed', 'refused', 'conflicts', 'errors'];
  if (Object.keys(x).some(k => !keys.includes(k))) return null;
  if (x.v !== 1 || !APP.test(x.app) || !LABEL.test(x.version) || !LABEL.test(x.sync)) return null;
  if (![x.unconfirmed, x.refused, x.conflicts].every(COUNT)) return null;
  const errors = x.errors ?? {};
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return null;
  const codes = Object.entries(errors);
  if (codes.length > MAX_CODES + 1 || codes.some(([c, n]) => !CODE.test(c) || !COUNT(n))) return null;
  return { app: x.app, version: x.version, sync: x.sync, unconfirmed: x.unconfirmed, refused: x.refused, conflicts: x.conflicts, errors: Object.fromEntries(codes.filter(([, n]) => n > 0)) };
}

// the SGT calendar day of a time, 'YYYY-MM-DD'
export const sgtDay = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

export function digestText({ day, apps, monday }) {
  const busy = apps.filter(a => a.unconfirmed || a.refused || a.conflicts || Object.keys(a.errors).length);
  if (!busy.length) return { send: !!monday, text: `Sync report ${day}: all clear (${apps.length} app${apps.length === 1 ? '' : 's'} reported${apps.length ? ': ' + apps.map(a => a.app).join(', ') : ''}).` };
  const lines = busy.map(a => {
    const parts = [];
    if (a.unconfirmed) parts.push(`${a.unconfirmed} unconfirmed > 1 h`);
    if (a.refused) parts.push(`${a.refused} refused`);
    if (a.conflicts) parts.push(`${a.conflicts} conflicts`);
    const errs = Object.entries(a.errors).sort((p, q) => q[1] - p[1]).map(([c, n]) => `${c} ${n}`).join(', ');
    if (errs) parts.push(`errors: ${errs}`);
    return `- ${a.app} (${a.version}, sync ${a.sync}, ${a.reports} reports): ${parts.join('; ')}`;
  });
  return { send: true, text: [`Sync report ${day}: ${busy.length} app${busy.length === 1 ? '' : 's'} need a look`, ...lines].join('\n') };
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, app TEXT NOT NULL, reports INTEGER NOT NULL DEFAULT 0, unconfirmed INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0, version TEXT, sync TEXT, PRIMARY KEY (day, app))',
  'CREATE TABLE IF NOT EXISTS errors (day TEXT NOT NULL, app TEXT NOT NULL, code TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, app, code))',
];
// made once per database binding and Worker instance (CREATE … IF NOT EXISTS writes no rows when they exist)
const ready = new WeakMap();
const schema = db => {
  if (!ready.has(db)) ready.set(db, db.batch(SCHEMA.map(s => db.prepare(s))).catch(error => { ready.delete(db); throw error; }));
  return ready.get(db);
};

export async function store(db, report, now = Date.now()) {
  await schema(db);
  const day = sgtDay(now), r = report;
  const statements = [db.prepare('INSERT INTO daily (day, app, reports, unconfirmed, refused, conflicts, version, sync) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7) ' +
    'ON CONFLICT (day, app) DO UPDATE SET reports = reports + 1, unconfirmed = max(unconfirmed, excluded.unconfirmed), refused = max(refused, excluded.refused), ' +
    'conflicts = max(conflicts, excluded.conflicts), version = excluded.version, sync = excluded.sync').bind(day, r.app, r.unconfirmed, r.refused, r.conflicts, r.version, r.sync)];
  for (const [code, n] of Object.entries(r.errors)) {
    statements.push(db.prepare('INSERT INTO errors (day, app, code, n) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (day, app, code) DO UPDATE SET n = n + excluded.n').bind(day, r.app, code, n));
  }
  await db.batch(statements);
}

export async function readDay(db, day) {
  await schema(db);
  const apps = (await db.prepare('SELECT app, reports, unconfirmed, refused, conflicts, version, sync FROM daily WHERE day = ?1 ORDER BY app').bind(day).all()).results || [];
  const errs = (await db.prepare('SELECT app, code, n FROM errors WHERE day = ?1').bind(day).all()).results || [];
  return apps.map(a => ({ ...a, errors: Object.fromEntries(errs.filter(e => e.app === a.app && e.n > 0).map(e => [e.code, e.n])) }));
}

const hits = new Map();
export function limited(address, now = Date.now()) {
  const h = hits.get(address);
  if (!h || now - h.start > RATE_MS) { hits.set(address, { start: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  return ++h.n > RATE;
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers } });
const cors = origin => ({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleReport(request, env, now = Date.now()) {
  const url = new URL(request.url), origin = request.headers.get('Origin') || '';
  if (url.pathname === '/report/digest') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405, { Allow: 'GET' });
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!sameToken(token, env.REPORT_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : sgtDay(now - 24 * 3600 * 1000);
    const apps = await readDay(env.REPORTS, day);
    const monday = new Date(now + 8 * 3600 * 1000).getUTCDay() === 1;
    return json({ day, apps, ...digestText({ day, apps, monday }) });
  }
  if (url.pathname !== '/report') return json({ error: 'not found' }, 404);
  if (!ourOrigin(origin)) return json({ error: 'origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return json({ error: 'method' }, 405, { Allow: 'POST, OPTIONS', ...cors(origin) });
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'too large' }, 413, cors(origin));
  if (limited(request.headers.get('CF-Connecting-IP') || 'unknown', now)) return json({ error: 'slow down' }, 429, cors(origin));
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413, cors(origin));
  const report = parseReport(text);
  if (!report) return json({ error: 'bad report' }, 400, cors(origin));
  if (!env.REPORTS) return json({ error: 'no store' }, 503, cors(origin));
  await store(env.REPORTS, report, now);
  return new Response(null, { status: 204, headers: cors(origin) });
}
