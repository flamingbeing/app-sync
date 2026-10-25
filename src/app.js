// createApp: the one call that wires the safe path for an app, so its cloud module becomes config. Built from the
// parts below (each still exported on its own, and handed back in `parts` for anything this facade does not cover).
// No Firebase import here: the app passes its own SDK, already initialised.
//
// createApp({ name, colls, path, sdk, kinds, outbox, adapter, commit, backend, hub, stores, queue, scope, claims, onRefused,
//             forget, report, redirectFirst, popupOnly, nav, storage, fetch, now, watchEvery, win })
//   name: the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`. colls: the collections synced.
//   path(scope, coll) -> the collection's path segments. sdk: async () -> { A, F, auth, db, emulator }: the app's
//   Firebase SDK (A: auth functions, F: Firestore functions), loaded once here (a failed load is tried again next time);
//   emulator true keeps the SDK's cache at sign-out (the emulator's own) and the page need not reload.
//   kinds: { [kind]: coll } for saves (default: each coll is its own kind).
//   outbox: the queue's durable store instead of createOutbox's (same shape: name, realm, put, list, get, remove, forget).
//   adapter: { listen, fetchOne, commit, clearCache } instead of the Firestore adapter (firestore.js); backend: its
//   options (time, mark, stampMode, serverField, merge, where, writeId, onCommit, ...). commit(scope, kind, record,
//   base, extra): the app's own write instead of adapter.commit (its own transactions; the queue, the outbox and the
//   sign-out gate stay as they are).
//   hub, stores, queue: more options for createSyncHub, createStores, createWriteQueue (e.g. bin, binKinds,
//   unstamped, expire; metaOnly; otherPending, sendTimeout, labels).
//   scope(user) -> the scope opened at sign-in (e.g. the account's email); without it the app calls open(scope).
//   claims: { url, entry(user) -> the role doc { v } | null, behind(entry, tokenClaims), when() }: after sign-in and
//   on refreshClaims(), when the role doc's v is ahead of the token's, POST url (Bearer token) once per uid:v, then
//   refresh the token. A failure changes nothing (the rules fall back to reading the role doc).
//   onRefused(err, entry) -> 'archive' | anything: a save the server refused (err.code, as the backend threw it);
//   'archive' sets it aside (the app keeps its own copy for Retry/Discard). Otherwise it stays failed: shown as
//   attention, and the sign-out gate stays shut until the user chooses.
//   forget: { extra, keep }: forgetDevice's (the app's own lists; the scopes whose device copy stays).
//   report: the nothing-lost report (createReport), opt-in. storage: where the origin's outbox list is kept
//   (default localStorage; null: no registry). nav, fetch, now, win: the browser's, for tests.
//   watchEvery: ms between watchdog checks (0: only on nudge()).
//   popupOnly: sign in with the popup only, never a redirect (0.6.2): for a page served from another domain than the
//   auth domain, where a redirect sign-in can't finish; a blocked popup throws to the caller (ask for a tap).
// -> { signIn, signOut, onUser, user, open, watch, save, flush, status$, refreshClaims, nudge, relistens, hub, queue, parts }
//   signOut({ wait }) -> { ok, reason: 'unsent' | 'changed', reload, failed }: refuses while anything is unsent (this
//   app's, another tab's, another registered app's on this origin), then forgets the device and signs out.
import { createSyncHub, replanOnWake } from './sync.js';
import { createWriteQueue, watchSaved } from './writes.js';
import { createStores } from './store.js';
import { createOutbox } from './outbox.js';
import { createOutboxRegistry } from './registry.js';
import { createWatchdog } from './watchdog.js';
import { persistGuard } from './persist.js';
import { syncStatus, attentionCount } from './status.js';
import { forgetDevice } from './forget.js';
import { createFirestoreBackend } from './firestore.js';

const REDIRECT_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/cancelled-popup-request'];
const lc = s => String(s || '').trim().toLowerCase();
export const userOf = u => u ? { uid: u.uid, email: lc(u.email), name: u.displayName || u.email || '', photo: u.photoURL || '', verified: u.emailVerified === true } : null;
// the token is behind the role doc: its v is older, or the doc is gone and the token still has one
export const claimsBehind = (entry, tokenClaims = {}) => !entry ? tokenClaims.v != null : !(Number(tokenClaims.v) >= (Number.isInteger(entry.v) ? entry.v : 0));

export function createApp(options = {}) {
  const { name, colls, path, sdk } = options;
  for (const [k, ok] of [['name', typeof name === 'string' && name], ['colls', Array.isArray(colls) && colls.length], ['path', typeof path === 'function'], ['sdk', typeof sdk === 'function']]) {
    if (!ok) throw new Error('createApp needs ' + k);
  }
  const {
    kinds = Object.fromEntries(colls.map(c => [c, c])), backend: backendOptions = {}, commit = null, scope: scopeOf = null,
    claims = null, onRefused = null, forget = {}, report = null, nav = globalThis.navigator, fetch: fetchFn = globalThis.fetch,
    now = Date.now, watchEvery = 3000, win = typeof window !== 'undefined' ? window : null,
  } = options;
  const storage = 'storage' in options ? options.storage : (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const collOf = kind => kinds[kind] || kind;
  const kindOf = coll => Object.keys(kinds).find(k => kinds[k] === coll) || coll;
  const online = () => nav?.onLine !== false;
  const engineFields = [backendOptions.mark || '_saves', backendOptions.serverField || 'serverAt'];
  const strip = d => { if (!d || !engineFields.some(f => f in d)) return d; const out = { ...d }; for (const f of engineFields) delete out[f]; return out; };

  // the SDK, once a page (every caller shares one promise; a failed load is tried again next time)
  let loaded = null, current = null, signedInUid = null;
  const load = () => {
    if (loaded) return loaded;
    loaded = Promise.resolve().then(sdk).then(s => {
      s.A.getRedirectResult?.(s.auth)?.catch?.(e => console.warn('Redirect sign-in failed', e?.code || e));
      current = userOf(s.auth.currentUser);
      s.A.onAuthStateChanged(s.auth, u => { current = userOf(u); if (u && u.uid !== signedInUid) { signedInUid = u.uid; void signedIn(u); } else if (!u) signedInUid = null; });
      return s;
    });
    loaded.catch(() => { loaded = null; });
    return loaded;
  };

  // the parts
  const meta = new Set();
  const adapter = options.adapter || createFirestoreBackend({
    sdk: async () => { const { F, db } = await load(); return { F, db }; }, path,
    onSnapshotMeta: (coll, m) => { for (const fn of meta) fn(coll, m); }, ...backendOptions,
  });
  const stores = createStores({ prefix: name + '-sync:', colls, ...options.stores });
  let registry = null;
  const outbox = options.outbox || createOutbox({ name: name + '-outbox' });
  if (storage) { try { registry = createOutboxRegistry({ storage }); registry.register(outbox); } catch (e) { registry = null; console.warn('outbox registry', e?.message); } }
  let scope = '';
  const codes = new Map();   // a failed save's code, by its key (the queue keeps the message only)
  const queue = createWriteQueue({
    store: outbox, getOwner: () => scope || null, online, registry, report, ...options.queue,
    backend: async (owner, kind, record, base, extra) => {
      try { return await (commit ? commit(owner, kind, record, base, extra) : adapter.commit(owner, collOf(kind), record, base, extra)); }
      catch (e) { if (extra?.key) codes.set(extra.key, e?.code || ''); throw e; }
    },
  });
  const hub = createSyncHub({
    openStore: stores.openStore, listen: adapter.listen, fetchOne: adapter.fetchOne, now,
    binKinds: kinds, unsent: (_scope, coll, id) => queue.unsent(kindOf(coll), id),
    onError: e => { try { report?.error?.(e?.code); } catch { /* never stops sync */ } console.warn('sync', e?.code || e?.message); },
    ...(backendOptions.stampMode ? { stampMode: backendOptions.stampMode } : {}), ...options.hub,
  });
  replanOnWake(hub, win);
  win?.addEventListener?.('online', () => { queue.kick(); tell(); });
  win?.addEventListener?.('offline', () => tell());

  // the status: confirmed only once the server has answered since the page opened
  let heard = false, persisted = true, relistens = 0;
  const subs = new Set();
  let lastTold = '';
  const statusNow = () => {
    const entries = queue.entries();
    return syncStatus({ online: online(), pending: queue.pending(), attention: attentionCount(entries), persisted, stale: watchdog.stale(), confirmed: heard, atRiskOnlyOffline: true });
  };
  function tell(force = false) {
    if (!subs.size) return;
    const st = statusNow(), key = st.state + ':' + st.count;
    if (key === lastTold && !force) return;
    lastTold = key;
    for (const fn of [...subs]) fn(st);
  }
  const status$ = fn => { subs.add(fn); const st = statusNow(); lastTold = st.state + ':' + st.count; fn(st); return () => subs.delete(fn); };
  const onSnap = m => { watchdog.heard(m); if (!m?.fromCache && !heard) { heard = true; } tell(); };
  if (!options.adapter) meta.add((_coll, m) => watchdog.heard(m));

  // watches: each one's list (device copy, then the server) with this device's unsent saves laid over it, again when
  // either changes (watchSaved); only what the listener hears feeds the status and the watchdog
  const watches = new Set();
  const heardHub = { watch: (s, coll, fn) => hub.watch(s, coll, (list, m) => { if (m) onSnap(m); fn(list, m); }) };
  const start = w => { w.off = watchSaved({ hub: heardHub, queue, scope: w.scope, coll: w.coll, kind: kindOf(w.coll) }, (list, m) => w.cb(list.map(strip), m || {})); };
  const stopWatches = () => { for (const w of watches) { w.off?.(); w.off = null; } };
  const startWatches = () => { for (const w of watches) if (!w.off) start(w); };
  function watch(s, coll, cb) {
    const w = { scope: s, coll, cb, off: null };
    watches.add(w); start(w);
    if (watchEvery > 0 && !timer) { timer = setInterval(() => watchdog.check(), watchEvery); timer.unref?.(); }
    return () => { w.off?.(); watches.delete(w); };
  }

  // the watchdog: listening again restarts the engines from the device copy; restarting the connection turns the
  // SDK's network off and on (capped: the switch waits behind a save whose answer is held up)
  let timer = 0, cycling = false;
  const watchdog = createWatchdog({
    now, online, quiet: () => queue.pending() === 0,
    relisten: why => { console.warn('listeners replaced:', why); relistens++; stopWatches(); hub.stopAll().then(() => { startWatches(); tell(); }); },
    cycle: why => { console.warn('connection restarted:', why); void cycleNet().finally(() => tell()); },
  });
  async function cycleNet() {
    if (cycling) return; cycling = true;
    try {
      const { F, db } = await load();
      if (typeof F.disableNetwork !== 'function') return;
      const turn = (async () => { await F.disableNetwork(db); await new Promise(r => setTimeout(r, 300)); await F.enableNetwork(db); })();
      turn.catch(() => {});
      await Promise.race([turn, new Promise(r => setTimeout(r, 4000))]);
    } catch (e) { console.warn('network restart', e?.code || e?.message); } finally { cycling = false; }
  }

  // refused saves: told once each, and set aside when the app says so. A delete made on this page, once done, leaves
  // the device copy too: its bin entry may have come while the delete was still being sent, when the engine keeps a
  // record with unsent saves, and a delta listener never hears the record go (0.6.1)
  const told = new Set(), deleting = new Set();
  queue.onChange(() => {
    for (const x of queue.entries()) {
      if (x.record?._deleted && x.state !== 'synced' && x.state !== 'archived') deleting.add(x.key);
      else if (deleting.has(x.key) && x.state === 'synced') {
        deleting.delete(x.key);
        if (queue.jobKey(x.kind, x.record.id) === x.key) void hub.drop(x.owner, collOf(x.kind), [x.record.id]);
      }
      if (x.state !== 'failed' || told.has(x.key) || !onRefused) continue;
      told.add(x.key);
      let answer;
      try { answer = onRefused({ code: codes.get(x.key) || '', message: x.error }, x); } catch (e) { console.warn('onRefused', e); }
      if (answer === 'archive') void queue.archive(x.key);
    }
    tell();
  });

  // saves: one at a time per record from this page, in the order made (two stored in the same moment could swap)
  const chains = new Map(), saving = new Set();
  function save(kind, s, record, base = null, opts = undefined) {
    const k = kind + ':' + s + ':' + record.id;
    const run = (chains.get(k) || Promise.resolve()).then(() => queue.save(kind, s, record, base, opts));
    const tail = run.catch(() => {}).finally(() => { if (chains.get(k) === tail) chains.delete(k); saving.delete(tail); });
    chains.set(k, tail); saving.add(tail);
    return run;
  }
  async function flush(ms = 4000) {
    if (saving.size) await Promise.race([Promise.allSettled([...saving]), new Promise(r => setTimeout(r, ms))]);
    return queue.flush(ms);
  }
  async function open(s) { scope = s; await queue.activate(s); tell(); }

  // sign-in: the storage guard, the claims, the scope
  let claimsAsked = '';
  async function refreshClaims() {
    if (!claims?.url) return;
    try {
      if (claims.when && !claims.when()) return;
      const { auth } = await load(), u = auth.currentUser;
      if (!u) return;
      const entry = claims.entry ? await claims.entry(userOf(u)) : null;
      const { claims: tokenClaims = {} } = await u.getIdTokenResult();
      const key = u.uid + ':' + (entry ? entry.v ?? 0 : '-');
      if (!(claims.behind || claimsBehind)(entry, tokenClaims) || claimsAsked === key) return;
      claimsAsked = key;
      const r = await fetchFn(claims.url, { method: 'POST', headers: { Authorization: 'Bearer ' + await u.getIdToken() } });
      if (r?.ok) await u.getIdToken(true);
    } catch (e) { console.warn('claims not updated', e?.message || e); }
  }
  async function signedIn(u) {
    persistGuard(nav).then(r => { persisted = !!(r.persisted || !r.supported); tell(); }, () => {});
    void refreshClaims();
    if (scopeOf) { try { await open(scopeOf(userOf(u))); } catch (e) { console.warn('open', e?.message); } }
  }
  const standalone = () => { try { return !!(win?.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone); } catch { return false; } };
  const redirectFirst = options.redirectFirst || (() => standalone() || (/Android/i.test(nav?.userAgent || '') && /Firefox\//i.test(nav?.userAgent || '')));
  async function signIn() {
    const { A, auth } = await load();
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters?.({ prompt: 'select_account' });
    if (options.popupOnly) return void await A.signInWithPopup(auth, provider);
    if (redirectFirst()) return A.signInWithRedirect(auth, provider);
    try { await A.signInWithPopup(auth, provider); }
    catch (e) { if (!REDIRECT_CODES.includes(e?.code)) throw e; await A.signInWithRedirect(auth, provider); }
  }
  async function onUser(cb) {
    const { A, auth } = await load();
    return A.onAuthStateChanged(auth, u => cb(userOf(u)));
  }

  // sign-out on a shared device: the gate, then forgetDevice's order, then the SDK's sign-out
  async function signOut({ wait = 4000 } = {}) {
    const s = await load(), uid = s.auth.currentUser?.uid || null;
    if (!(await flush(wait))) return { ok: false, reason: 'unsent', reload: false, failed: [] };
    let reason = '';
    const clear = !s.emulator && adapter.clearCache ? () => adapter.clearCache() : null;
    const r = await forgetDevice({
      hub, stores, queue, keep: forget.keep || [], clearBackendCache: clear, extra: forget.extra || null,
      proceed: async () => {
        if ((s.auth.currentUser?.uid || null) !== uid) { reason = 'changed'; return false; }
        if (!(await queue.flush(1500))) { reason = 'unsent'; return false; }
        return true;
      },
    });
    if (!r.wiped) { stopWatches(); startWatches(); return { ok: false, reason, reload: false, failed: r.failed }; }
    stopWatches(); watches.clear(); scope = ''; heard = false; told.clear(); deleting.clear(); codes.clear(); claimsAsked = '';
    if (clear) loaded = null;   // (the SDK instance was terminated: the page starts again)
    await s.A.signOut(s.auth);
    current = null;
    return { ok: true, reason: '', reload: !!clear, failed: r.failed };
  }

  const nudge = (event = '') => { if (!watches.size) return false; const a = event ? watchdog.event() : watchdog.check(); return !!(a.relisten || a.cycle); };
  const parts = { hub, queue, stores, adapter, watchdog, registry, outbox };
  return {
    signIn, signOut, onUser, user: () => current, open, watch, save, flush, status$, refreshClaims, nudge,
    relistens: () => relistens, hub, queue, parts,
  };
}
