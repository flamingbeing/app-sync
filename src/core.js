// The sync core (0.9.1, internal): the device copy, the outbox and queue, the watches, the watchdog, the status and the
// held conflicts, as one closure. The one-object createApp (app.js) and the sync module (module-sync.js) are both
// built on it, so they behave the same; neither signs in here. Options: createApp's (app.js), less the sign-in ones.
// host: { load() -> the app's SDK (shared, loaded once), user() -> the account signed in (AppUser) or null }.
// -> the api pieces both hand on, plus what each needs to sign out or switch (no promise: src/internal).
import { createSyncHub, replanOnWake } from './sync.js';
import { createWriteQueue, watchSaved } from './writes.js';
import { createStores } from './store.js';
import { createOutbox } from './outbox.js';
import { createOutboxRegistry } from './registry.js';
import { createWatchdog } from './watchdog.js';
import { persistGuard } from './persist.js';
import { syncStatus, attentionCount } from './status.js';
import { describeConflict, mergeFields, resolvedRecord, recordSignature } from './conflict.js';
import { createFirestoreBackend } from './firestore.js';

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').AppSdk} AppSdk
 * @typedef {import('./types.js').SyncStatus} SyncStatus
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser
 */

/** @param {import('./app.js').AppOptions} options @param {{ load: () => Promise<AppSdk>, user: () => AppUser | null }} host */
export function createSyncCore(options, { load, user }) {
  const { name, colls, path } = options;
  const {
    kinds = Object.fromEntries(colls.map(c => [c, c])), backend: backendOptions = {}, commit = null,
    onRefused = null, report = null, nav = globalThis.navigator, now = Date.now, watchEvery = 3000,
    win = typeof window !== 'undefined' ? window : null, wake = false,
  } = options;
  const storage = 'storage' in options ? options.storage : (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  /** @param {string} kind */
  const collOf = kind => kinds[kind] || kind;
  /** @param {string} coll */
  const kindOf = coll => Object.keys(kinds).find(k => kinds[k] === coll) || coll;
  const online = () => nav?.onLine !== false;
  const stampField = backendOptions.field || 'updatedAt';
  const engineFields = [backendOptions.mark || '_saves', backendOptions.serverField || 'serverAt', ...(backendOptions.edits ? [backendOptions.edits] : [])];
  const heldOn = !!backendOptions.held, device = String(options.device || '');
  /** @param {Doc | null | undefined} d */
  const strip = d => { if (!d || !engineFields.some(f => f in d)) return d; const out = { ...d }; for (const f of engineFields) delete out[f]; return out; };

  // the parts
  /** @type {Set<(coll: string, m: import('./types.js').SnapMeta) => void>} */
  const meta = new Set();
  const adapter = options.adapter || createFirestoreBackend({
    sdk: async () => { const { F, db } = await load(); return { F, db }; }, path,
    onSnapshotMeta: (coll, m) => { for (const fn of meta) fn(coll, m); },
    editor: () => ({ by: user()?.name || user()?.email || '', device }), ...backendOptions,
  });
  const stores = createStores({ prefix: name + '-sync:', colls, ...options.stores });
  /** @type {import('./types.js').Registry | null} */
  let registry = null;
  const outbox = options.outbox || createOutbox({ name: name + '-outbox' });
  if (storage) { try { registry = createOutboxRegistry({ storage }); registry.register(outbox); } catch (e) { registry = null; console.warn('outbox registry', e?.message); } }
  let scope = '';
  const queue = createWriteQueue({
    store: outbox, getOwner: () => scope || null, online, registry, report, field: stampField, engine: engineFields, ...(heldOn ? { ignore: engineFields } : {}), ...options.queue,
    backend: async (owner, kind, record, base, extra) => {
      // a record deleted elsewhere and saved again here (a restore, "keep mine"): stamped above the delete's tombstone,
      // which other devices hold, or a clock behind the deleter's would leave it hidden there (0.6.3)
      const tomb = record && !record._deleted ? hub.tomb(owner, collOf(kind), record.id) : 0;
      if (tomb > 0) extra = { ...extra, after: tomb };
      return commit ? commit(owner, kind, record, base, extra) : adapter.commit(owner, collOf(kind), record, base, extra);
    },
  });
  const hub = createSyncHub({
    openStore: stores.openStore, listen: adapter.listen, fetchOne: adapter.fetchOne, now,
    binKinds: kinds, unsent: (_scope, coll, id) => queue.unsent(kindOf(coll), id) || unsentOutside(kindOf(coll), id) > 0,
    onError: e => { try { report?.error?.(e?.code); } catch { /* never stops sync */ } console.warn('sync', e?.code || e?.message); },
    ...(backendOptions.stampMode ? { stampMode: backendOptions.stampMode } : {}), ...options.hub,
  });
  replanOnWake(hub, win);
  win?.addEventListener?.('online', () => { queue.kick(); tell(); });
  win?.addEventListener?.('offline', () => tell());

  // writes the app makes outside the queue (0.8.1): tracked ones until they settle, plus the app's own count (outside;
  // the deprecated quiet() false counts one). They count as unsent everywhere the queue's saves do
  /** @type {Set<{ kind: string, id: string }>} */
  const tracked = new Set();
  /** @type {Set<() => void>} */
  const settledWaits = new Set();
  /** @param {string} [kind] @param {string} [id] @returns {number} */
  function unsentOutside(kind, id) {
    let n = 0;
    for (const t of tracked) if ((!kind || t.kind === kind) && (id == null || t.id === id)) n++;
    if (kind) return n;
    try { n += Math.max(0, Number(options.outside?.() || 0)); } catch { n++; }   // (can't tell: counts as unsent)
    try { if (options.quiet && !options.quiet()) n++; } catch { n++; }
    return n;
  }
  /** @template T @param {Promise<T>} promise @param {{ kind?: string, id?: string }} [about] @returns {Promise<T>} */
  function track(promise, { kind = '', id = '' } = {}) {
    const t = { kind, id: String(id) };
    tracked.add(t); tell();
    const done = () => { if (!tracked.delete(t)) return; if (scope) void hub.settle(scope); tell(); for (const fn of [...settledWaits]) fn(); };
    const p = Promise.resolve(promise);
    p.then(done, done);
    return p;
  }
  /** @param {number} [ms] @returns {Promise<boolean>} */
  function outsideSettled(ms = 4000) {
    if (!unsentOutside()) return Promise.resolve(true);
    return new Promise(resolve => {
      const check = () => { if (unsentOutside()) return; finish(true); };
      const timer = setTimeout(() => finish(!unsentOutside()), ms);
      /** @param {boolean} ok */
      const finish = ok => { clearTimeout(timer); settledWaits.delete(check); resolve(ok); };
      settledWaits.add(check);
    });
  }

  // the status: confirmed only once the server has answered since the page opened
  let heard = false, heardAt = 0, persisted = true, relistens = 0;
  /** @type {Set<(st: SyncStatus) => void>} */
  const subs = new Set();
  let lastTold = '';
  const statusNow = () => {
    const entries = queue.entries();
    return syncStatus({ online: online(), pending: queue.pending() + unsentOutside(), attention: attentionCount(entries), persisted, stale: watchdog.stale(), confirmed: heard, atRiskOnlyOffline: true });
  };
  /** @param {boolean} [force] */
  function tell(force = false) {
    if (!subs.size) return;
    const st = statusNow(), key = st.state + ':' + st.count;
    if (key === lastTold && !force) return;
    lastTold = key;
    for (const fn of [...subs]) fn(st);
  }
  /** @param {(st: SyncStatus) => void} fn @returns {() => boolean} */
  const status$ = fn => { subs.add(fn); const st = statusNow(); lastTold = st.state + ':' + st.count; fn(st); return () => subs.delete(fn); };
  /** @param {import('./types.js').SnapMeta} m */
  const onSnap = m => { watchdog.heard(m); if (!m?.fromCache) { heard = true; heardAt = now(); } tell(); };
  if (!options.adapter) meta.add((_coll, m) => watchdog.heard(m));

  // watches: each one's list (device copy, then the server) with this device's unsent saves laid over it, again when
  // either changes (watchSaved); only what the listener hears feeds the status and the watchdog
  /** @typedef {{ scope: string, coll: string, cb: (list: Doc[], meta: any) => void, off: ReturnType<typeof watchSaved> | null }} Watch */
  /** @type {Set<Watch>} */
  const watches = new Set();
  const heardHub = { watch: (/** @type {string} */ s, /** @type {string} */ coll, /** @type {(list: Doc[], meta: any) => void} */ fn) => hub.watch(s, coll, (list, m) => { if (m) onSnap(m); fn(list, m); }) };
  /** @param {Watch} w */
  const start = w => { w.off = watchSaved({ hub: heardHub, queue, scope: w.scope, coll: w.coll, kind: kindOf(w.coll) }, (list, m) => w.cb(/** @type {Doc[]} */ (list.map(strip)), m || {})); };
  // (0.8.3) one document: handed when its copy changes, null ("gone") once when the server says it is not there or the
  // listener fails (a failed one is finished); a device-copy answer that it is not there is never "gone"
  /** @typedef {{ segments: string[], cb: (d: Doc | null, meta: any) => void, onError: ((e: any) => void) | null, last: string, failed: boolean, off: (() => void) | null }} DocWatch */
  /** @type {Set<DocWatch>} */
  const docWatches = new Set();
  /** @param {DocWatch} w */
  const startDoc = w => {
    if (!adapter.listenDoc) throw new Error('watchDoc needs an adapter with listenDoc');
    w.off = adapter.listenDoc(w.segments, (/** @type {{ doc: Doc | null, fromCache: boolean, hasPendingWrites: boolean }} */ m) => {
      if (!w.off) return;
      onSnap(m);
      const meta = { fromCache: !!m.fromCache, hasPendingWrites: !!m.hasPendingWrites };
      if (!m.doc) { if (!m.fromCache && w.last !== 'gone') { w.last = 'gone'; w.cb(null, meta); } return; }
      const d = strip(m.doc), j = JSON.stringify(d);
      if (j !== w.last) { w.last = j; w.cb(/** @type {Doc} */ (d), meta); }
    }, (/** @type {any} */ e) => {
      if (!w.off) return;
      const off = w.off; w.off = null; w.failed = true; off();
      console.warn('watchDoc', w.segments.join('/'), e?.code || e?.message);
      try { w.onError?.(e); } catch { /* the app's */ }
      if (w.last !== 'gone') { w.last = 'gone'; w.cb(null, { fromCache: false, hasPendingWrites: false, error: e }); }
    });
  };
  /** @param {string | (string | number)[]} where @param {(d: Doc | null, meta: any) => void} cb @param {(e: any) => void} [onError] @returns {() => void} */
  function watchDoc(where, cb, onError) {
    const w = addDoc(where, cb, onError);
    return () => dropDoc(w);
  }
  /** @param {string | (string | number)[]} where @param {(d: Doc | null, meta: any) => void} cb @param {(e: any) => void} [onError] @returns {DocWatch} */
  function addDoc(where, cb, onError) {
    const segments = (Array.isArray(where) ? where : String(where).split('/')).map(String).filter(Boolean);
    /** @type {DocWatch} */
    const w = { segments, cb, onError: onError || null, last: '', failed: false, off: null };
    docWatches.add(w); startDoc(w);
    if (watchEvery > 0 && !timer) { timer = setInterval(() => watchdog.check(), watchEvery); /** @type {any} */ (timer).unref?.(); }
    return w;
  }
  /** @param {DocWatch} w */
  const dropDoc = w => { const off = w.off; w.off = null; off?.(); docWatches.delete(w); };
  const stopWatches = () => {
    for (const w of watches) { w.off?.(); w.off = null; }
    for (const w of docWatches) { const off = w.off; w.off = null; off?.(); }
  };
  const startWatches = () => { for (const w of watches) if (!w.off) start(w); for (const w of docWatches) if (!w.off && !w.failed) startDoc(w); };
  /** @param {string} s @param {string} coll @param {(list: Doc[], meta: any) => void} cb @returns {() => void} */
  function watch(s, coll, cb) {
    /** @type {Watch} */
    const w = { scope: s, coll, cb, off: null };
    watches.add(w); start(w);
    if (watchEvery > 0 && !timer) { timer = setInterval(() => watchdog.check(), watchEvery); /** @type {any} */ (timer).unref?.(); }
    return () => { w.off?.(); watches.delete(w); };
  }

  // (0.8.2) the copy a running watch of the open scope last handed (copyOf), and the engine's copy as last heard
  // (lastSeen: { stamp, signature }, to tell a change made elsewhere from this device's own); null: none
  /** @param {string} kind */
  const watchOf = kind => [...watches].find(w => w.scope === scope && w.coll === collOf(kind) && w.off)?.off || null;
  /** @param {string} kind @param {string} id @returns {Doc | null} */
  const copyOf = (kind, id) => strip(watchOf(kind)?.copyOf(id) ?? null) ?? null;
  /** @param {string} kind @param {string} id @returns {{ stamp: any, signature: string } | null} */
  function lastSeen(kind, id) {
    const d = watchOf(kind)?.seen(id);
    return d ? { stamp: d[stampField] ?? null, signature: recordSignature(strip(d)) } : null;
  }

  // the watchdog: listening again restarts the engines from the device copy; restarting the connection turns the
  // SDK's network off and on (capped: the switch waits behind a save whose answer is held up)
  /** @type {ReturnType<typeof setInterval> | 0} */
  let timer = 0;
  /** @type {Promise<boolean> | null} */
  let cycling = null;
  const watchdog = createWatchdog({
    now, online, quiet: () => queue.pending() === 0 && unsentOutside() === 0,
    relisten: /** @param {string} why */ why => { console.warn('listeners replaced:', why); relistens++; stopWatches(); hub.stopAll().then(() => { startWatches(); tell(); }); },
    cycle: /** @param {string} why */ why => { console.warn('connection restarted:', why); void cycleNet(safe).finally(() => tell()); },
  });
  // -> true once the network was switched off and on again (false: no switch in this SDK, ok() said no once the SDK
  // was loaded, it failed, or it took over 4 s); one restart at a time, a second call shares the running one, and the
  // lock is held until the switch itself settles (one past the cap is still running)
  /** @param {() => boolean} [ok] */
  function cycleNet(ok = () => true) {
    if (cycling) return cycling;
    let switching = false;
    return cycling = (async () => {
      try {
        const { F, db } = await load();
        if (typeof F.disableNetwork !== 'function' || !ok()) return false;
        switching = true;
        const turn = (async () => { await F.disableNetwork(db); await new Promise(r => setTimeout(r, 300)); await F.enableNetwork(db); return true; })();
        turn.catch(() => {}).finally(() => { cycling = null; });
        return await Promise.race([turn, new Promise(r => setTimeout(r, 4000, false))]);
      } catch (e) { console.warn('network restart', e?.code || e?.message); return false; } finally { if (!switching) cycling = null; }
    })();
  }
  // (review) checked again just before the switch: an outside write started while the SDK loaded stops it
  const safe = () => online() && unsentOutside() === 0;
  // (0.8.3) the app's "Reconnect" (Sync now): restart the connection now, then send what waits. Not offline, and not
  // under an unsent outside write (a restart may send it again: an increment counted twice); the queue's own saves are
  // transactions, checked against the server's copy, so they are safe
  /** @param {{ why?: string }} [opts] @returns {Promise<boolean>} */
  async function reconnect({ why = 'asked' } = {}) {
    if (!safe()) return false;
    console.warn('connection restarted:', why);
    const ok = await cycleNet(safe);
    queue.kick(); tell();
    return ok;
  }

  // refused saves: told once each, and set aside when the app says so. A delete made on this page, once done, leaves
  // the device copy too: its bin entry may have come while the delete was still being sent, when the engine keeps a
  // record with unsent saves, and a delta listener never hears the record go (0.6.1)
  /** @type {Set<string>} */
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
      try { answer = onRefused({ code: x.code || '', message: x.error }, x); } catch (e) { console.warn('onRefused', e); }
      if (answer === 'archive') void queue.archive(x.key, { refused: true });   // (0.8.2: kept for queue.refused())
    }
    // a delete heard while a save was held is applied once that record's saves are done (0.6.3)
    if (scope) void hub.settle(scope);
    tell();
  });

  // saves: one at a time per record from this page, in the order made (two stored in the same moment could swap)
  /** @type {Map<string, Promise<any>>} */
  const chains = new Map();
  /** @type {Set<Promise<any>>} */
  const saving = new Set();
  /** @param {string} kind @param {string} s @param {Doc} record @param {Doc | null} [base] @param {{ ops?: any }} [opts] @returns {Promise<Doc>} */
  function save(kind, s, record, base = null, opts = undefined) {
    const k = kind + ':' + s + ':' + record.id;
    const run = (chains.get(k) || Promise.resolve()).then(() => queue.save(kind, s, record, base, opts));
    const tail = run.catch(() => {}).finally(() => { if (chains.get(k) === tail) chains.delete(k); saving.delete(tail); });
    chains.set(k, tail); saving.add(tail);
    return run;
  }
  /** @param {number} [ms] @returns {Promise<boolean>} */
  async function flush(ms = 4000) {
    const end = Date.now() + ms;   // (one wait in all, 0.7.3: the saves being stored, then their sends)
    if (saving.size) await Promise.race([Promise.allSettled([...saving]), new Promise(r => setTimeout(r, ms))]);
    await outsideSettled(Math.max(0, end - Date.now()));   // (0.8.1: tracked writes and the app's count first, so the
    const sent = await queue.flush(Math.max(0, end - Date.now()));   // queue's answer is the last one asked)
    return sent && !unsentOutside() && !saving.size;   // (a save still being stored is not sent)
  }
  /** @param {string} s */
  async function open(s) { scope = s; await queue.activate(s); tell(); }

  // held conflicts (0.6.3): this device's own, one per record (the first held save: entries() is newest first, so
  // reversed it is oldest first; later saves on this device's own version wait behind it, and the newest is "mine")
  /** @param {string} key */
  const heldOf = key => {
    const all = queue.entries().reverse(), first = all.find(x => x.key === key && x.state === 'conflict');
    if (!first) return null;
    // (0.7.1: also the saves queued behind it before it was held, so the answer carries them; a merge collection's
    // ops of the whole chain, in order, so the merge function replays every change of this device's)
    const chain = all.filter(x => x.kind === first.kind && x.record.id === first.record.id && (x.state === 'conflict' || x.state === 'pending' && x.at > first.at));
    return { first, held: { record: /** @type {Job} */ (chain.at(-1)).record, base: first.base ?? null, remote: first.remote ?? null, at: /** @type {Job} */ (chain.at(-1)).at, ...(chain.every(x => x.ops) ? { ops: chain.flatMap(x => x.ops) } : {}) } };
  };
  // the merge function of a merge collection named in held (0.7.1: its clashes are found and answered through it)
  /** @param {string} kind */
  const mergeOfHeld = kind => {
    const h = backendOptions.held, m = backendOptions.merge, coll = collOf(kind);
    if (!h || h === true || !Object.hasOwn(h, coll) || !h[coll] || !m || !Object.hasOwn(m, coll) || !m[coll]) return null;
    return m[coll] === true ? mergeFields : m[coll];
  };
  /** @param {string} kind @returns {string[]} */
  const countersOf = kind => { const h = backendOptions.held, c = h && h !== true ? h[collOf(kind)] : null; return c && c !== true ? c.counters || [] : []; };
  const skip = [...engineFields, backendOptions.field || 'updatedAt'];
  /** @param {string} [kind] @returns {{ key: string, kind: string, id: string, at: number }[]} */
  function conflicts(kind = '') {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {{ key: string, kind: string, id: string, at: number }[]} */
    const out = [];
    for (const x of queue.entries().reverse()) {   // oldest first: each record's first held save (heldOf's key)
      const k = x.kind + ':' + x.record.id;
      if (x.state !== 'conflict' || (kind && x.kind !== kind) || seen.has(k)) continue;
      seen.add(k); out.push({ key: x.key, kind: x.kind, id: x.record.id, at: x.at });
    }
    return out;
  }
  /** @param {string} key @param {{ timeZone?: string }} [options] @returns {(ConflictView & { key: string, kind: string, id: string }) | null} */
  function describe(key, { timeZone } = {}) {
    const h = heldOf(key);
    if (!h) return null;
    return { key, kind: h.first.kind, id: h.first.record.id, ...describeConflict(h.held, { counters: countersOf(h.first.kind), skip, edits: backendOptions.edits || null, me: { by: user()?.name || user()?.email || '', device }, timeZone, merge: mergeOfHeld(h.first.kind) }) };
  }
  /** @param {string} key @param {ConflictChoice} choice */
  async function resolve(key, choice) {
    const h = heldOf(key);
    if (!h) throw new Error('This save is no longer waiting for a choice');
    if (choice !== 'mine' && choice !== 'theirs' && (!choice || typeof choice !== 'object')) throw new Error("resolve: choice is 'mine', 'theirs' or { [field]: 'mine' | 'theirs' }");
    const record = resolvedRecord(h.held, choice, { counters: countersOf(h.first.kind), skip, merge: mergeOfHeld(h.first.kind) });
    return queue.restore(h.first.kind, h.first.owner, record);
  }

  /** @param {string} [event] */
  const nudge = (event = '') => { if (!watches.size && !docWatches.size) return false; const a = event ? watchdog.event() : watchdog.check(); return !!(a.relisten || a.cycle); };
  // (0.8.1) a read or listener the app runs itself: { fromCache, hasPendingWrites } as its snapshot said (none: the server)
  /** @param {import('./types.js').SnapMeta} [m] */
  const heardOf = (m = {}) => onSnap({ fromCache: !!m.fromCache, hasPendingWrites: !!m.hasPendingWrites });
  // (0.8.1) nothing being stored, sent, held in the queue or written outside it: safe to reload
  const idle = () => !saving.size && queue.pending() === 0 && unsentOutside() === 0;
  // (0.8.3) wake: true: a moment the page came back (online, shown, restored) nudges the watchdog and sends what waits
  if (wake && win?.addEventListener) {
    const doc = win.document;
    const woke = () => { if (doc?.visibilityState === 'hidden') return; nudge('wake'); queue.kick(); };
    win.addEventListener('online', woke);
    win.addEventListener('pageshow', woke);
    doc?.addEventListener?.('visibilitychange', woke);
  }
  // sign-in: the storage guard, then the scope (scopeOf(user), the app's; none: the app calls open)
  /** @param {AppUser} u @param {((user: AppUser) => string) | null} scopeOf */
  async function signedIn(u, scopeOf) {
    persistGuard(nav).then(r => { persisted = !!(r.persisted || !r.supported); tell(); }, () => {});
    if (scopeOf) { try { await open(scopeOf(u)); } catch (e) { console.warn('open', /** @type {any} */ (e)?.message); } }
  }
  // what a wipe leaves: no watches, no scope, nothing heard or tracked
  const reset = () => { stopWatches(); watches.clear(); docWatches.clear(); scope = ''; heard = false; heardAt = 0; told.clear(); deleting.clear(); tracked.clear(); };
  // signed out, data kept (the sync module): nothing is sent or listened to until the next sign-in
  const close = () => { stopWatches(); scope = ''; heard = false; tell(); };
  const parts = { hub, queue, stores, adapter, watchdog, registry, outbox };
  return {
    api: {
      open, watch, save, flush, status$, nudge, relistens: () => relistens, facts: () => ({ persisted, confirmed: heard, heardAt }),
      conflicts, describe, resolve, hub, queue, parts, track, unsentOutside, outsideSettled, heard: heardOf, idle, copyOf,
      lastSeen, watchDoc, reconnect,
    },
    hub, queue, stores, adapter, outbox, registry, saving, statusNow, tell, signedIn, reset, close, addDoc, dropDoc,
    startWatches, stopWatches, scope: () => scope, watching: () => watches.size + docWatches.size,
  };
}
