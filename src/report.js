// Nothing-lost report (opt-in): at most once an hour, and when the page is hidden, the app tells the report endpoint
// how its saves are doing on this device. Only counts, error codes and versions are sent, never a record, an id, a
// path, an email or an error message: buildReport copies nothing else from what it is given.
//
// createReport({ app, version, sync, endpoint, every, storage, send, now, onError }) -> { watch, error, payload, due, flush, start, stop }
//   app: the app's id (lower case letters, digits, "-"). version: the app's own version (e.g. the service worker's), or
//   a function giving it when a report is made (a version learned later); one that is not a short label reads unknown.
//   sync: this engine's version (index.js fills it in with VERSION).
//   endpoint: where to POST (default REPORT_ENDPOINT). every: the least time between two reports (default an hour).
//   storage: localStorage or alike, keeps the error counts and the last send across page loads (none: memory only).
//   send(url, body) -> truthy when handed over (default navigator.sendBeacon as text/plain, else fetch keepalive).
// watch(queue): a write queue (writes.js) whose entries are counted; createWriteQueue({ report }) does it itself.
// error(code): one sync error of that code (the write queue counts its own; an app may add a listener's).
// flush({ force }): send now if due (force: even if not); -> true when sent. start(): a check every few minutes and on
//   page hide; stop() undoes it.
//
// Payload: { v: 1, app, version, sync, unconfirmed, refused, conflicts, errors: { code: n } }
//   unconfirmed: saves still waiting for the server after UNCONFIRMED_MS; refused: saves the server refused (failed);
//   conflicts: saves that met a change made elsewhere; errors: sync errors by code since the last report.

export const REPORT_ENDPOINT = 'https://core.anawj.com/report';
export const REPORT_EVERY = 60 * 60 * 1000;
export const UNCONFIRMED_MS = 60 * 60 * 1000;
export const MAX_CODES = 20;
const CHECK_EVERY = 5 * 60 * 1000;
const APP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const CODE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_COUNT = 1e6;

const count = n => Math.min(MAX_COUNT, Math.max(0, Math.floor(Number(n) || 0)));
// an error code as a short lower-case word ('permission-denied'); anything else (a message, an id, a path) is 'other'
export const errorCode = code => typeof code === 'string' && CODE.test(code) ? code : code == null || code === '' ? 'unknown' : 'other';

// The payload from a queue's entries and the error counts: pure, nothing from a record is read but its state and time.
export function buildReport({ app, version, sync = '', entries = [], errors = {}, now = Date.now() }) {
  if (!APP.test(String(app))) throw new Error('report: app must be lower-case letters, digits and "-"');
  if (!LABEL.test(String(version))) throw new Error('report: version must be a short label (letters, digits, . _ + -)');
  let unconfirmed = 0, refused = 0, conflicts = 0;
  for (const x of entries) {
    const state = x?.state;
    if (state === 'failed') refused++;
    else if (state === 'conflict') conflicts++;
    else if (state === 'pending' && Number(x.at) <= now - UNCONFIRMED_MS) unconfirmed++;
  }
  const codes = {};
  for (const [code, n] of Object.entries(errors || {})) {
    const c = Object.keys(codes).length >= MAX_CODES && !(errorCode(code) in codes) ? 'other' : errorCode(code);
    codes[c] = count((codes[c] || 0) + count(n));
  }
  return { v: 1, app: String(app), version: String(version), sync: LABEL.test(String(sync)) ? String(sync) : 'unknown', unconfirmed: count(unconfirmed), refused: count(refused), conflicts: count(conflicts), errors: codes };
}

function defaultSend(url, body) {
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // text/plain: a "simple" request, so no preflight, and it still goes when the page is closing
    try { if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return true; } catch { /* try fetch */ }
  }
  if (typeof fetch !== 'function') return false;
  fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', mode: 'cors', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  return true;
}

export function createReport({ app, version, sync = '', endpoint = REPORT_ENDPOINT, every = REPORT_EVERY, storage = null, send = defaultSend, now = () => Date.now(), onError = () => {} } = {}) {
  const versionNow = () => { try { const v = typeof version === 'function' ? version() : version; return LABEL.test(String(v)) ? String(v) : 'unknown'; } catch { return 'unknown'; } };
  if (typeof version !== 'function') buildReport({ app, version });   // checks app and version now, not an hour later
  else buildReport({ app, version: 'unknown' });
  const KEY = 'app-sync-report:' + app;
  const queues = new Set();
  let memory = { last: 0, errors: {} }, timer = null, hide = null;
  const load = () => {
    if (!storage) return memory;
    try { const x = JSON.parse(storage.getItem(KEY) || 'null'); return x && typeof x === 'object' ? { last: Number(x.last) || 0, errors: x.errors && typeof x.errors === 'object' ? x.errors : {} } : { last: 0, errors: {} }; }
    catch { return memory; }
  };
  const keep = state => { memory = state; if (storage) { try { storage.setItem(KEY, JSON.stringify(state)); } catch { /* memory only */ } } };
  const entries = () => [...queues].flatMap(q => { try { return q.entries(); } catch { return []; } });
  const payload = () => buildReport({ app, version: versionNow(), sync, entries: entries(), errors: load().errors, now: now() });
  const due = () => now() - load().last >= every;
  async function flush({ force = false } = {}) {
    if (!force && !due()) return false;
    let body;
    try { body = JSON.stringify(payload()); } catch (error) { onError(error); return false; }
    let sent = false;
    try { sent = !!(await send(endpoint, body)); } catch (error) { onError(error); }
    // the counts sent are taken off; errors counted meanwhile stay for the next report
    if (sent) {
      const state = load(), was = JSON.parse(body).errors, left = {};
      for (const [code, n] of Object.entries(state.errors)) { const rest = count(n) - (was[errorCode(code)] || 0); if (rest > 0) left[code] = rest; }
      keep({ last: now(), errors: left });
    }
    return sent;
  }
  return {
    watch(queue) { if (queue && typeof queue.entries === 'function') queues.add(queue); return () => queues.delete(queue); },
    error(code) { const state = load(), c = errorCode(code); state.errors[c] = count((state.errors[c] || 0) + 1); keep(state); },
    payload, due, flush,
    start() {
      if (timer) return;
      timer = setInterval(() => { void flush(); }, CHECK_EVERY);
      if (typeof document !== 'undefined' && document.addEventListener) {
        hide = event => { if (event?.type === 'pagehide' || document.visibilityState === 'hidden') void flush(); };
        document.addEventListener('visibilitychange', hide);
        globalThis.addEventListener?.('pagehide', hide);
      }
    },
    stop() {
      clearInterval(timer); timer = null;
      if (hide) { document.removeEventListener('visibilitychange', hide); globalThis.removeEventListener?.('pagehide', hide); hide = null; }
    },
  };
}
