// The sync core (0.9.1, internal): the device copy, the outbox and queue, the watches, the watchdog, the status and the
// held conflicts, as one closure. The sync module (module-sync.js) is built on it; it does not sign in (auth.js does).
//
// The sync options (sync(options), module-sync.js; 1.0.0-rc.1: moved here from the one-object createApp, removed):
// sync({ colls, path, kinds, scope, public, backend, adapter, commit, outbox, hub, stores, queue, onRefused, forget, report,
//        device, outside, wake, watchEvery, nav, now, win, reload })
//   config.name (createApp's): the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`. colls: the
//   collections synced. path(scope, coll) -> the collection's path segments. config.sdk: async () -> { A, F, auth, db,
//   emulator }: the app's Firebase SDK, loaded once (ctx.sdk()); emulator true keeps the SDK's cache at a wipe (the
//   emulator's own) and the page need not reload.
//   kinds: { [kind]: coll } for saves (default: each coll is its own kind); 1.2.0: { [kind]: { coll, path } } saves
//   that kind to path(scope, coll, record) instead of the scope's (kinds.js; the same queue, outbox and report).
//   outbox: the queue's durable store instead of createOutbox's (same shape: name, realm, put, list, get, remove, forget).
//   adapter: { listen, fetchOne, commit, clearCache } instead of the Firestore adapter (firestore.js), or (1.5.0) a
//   factory such as firestore(options) from @core/sync/firestore, called here with { sdk, path, onSnapshotMeta, editor,
//   ...backend } (no adapter: sync() loads firestore() itself, the 1.x default; the core never imports firestore.js); backend: its
//   options (time, mark, stampMode, serverField, merge, where, writeId, onCommit, ...). commit(scope, kind, record,
//   base, extra): the app's own write instead of adapter.commit (its own transactions; the queue, the outbox and the
//   switch and forget() gate stay as they are).
//   hub, stores, queue: more options for createSyncHub, createStores, createWriteQueue (e.g. bin, binKinds,
//   unstamped, expire; metaOnly; otherPending, sendTimeout, labels).
//   scope(user) -> the scope opened at sign-in (e.g. the account's email); without it the app calls open(scope).
//   public (1.3.0): colls read with no account, in scopes named `public:<name>` (FORMATS.md): watched as any scope,
//   never opened or saved to (read only), and only these collections there. Their watches run signed out too, are
//   listened again at sign-in (under the account) and stay through a switch or forget() (their copy is wiped with
//   the rest: read only, it loses nothing).
//   onRefused(err, entry) -> 'archive' | anything: a save the server refused (err.code, as the backend threw it);
//   'archive' sets it aside, kept with its code for queue.refused(), retry(key) and discard(key) (0.8.2; after a
//   reload too: the code is on the job, and a refused save found then is told once more). The outbox is then its only
//   copy, so a switch or forget() is refused while it is there, until it is retried or discarded, or forget({ force }).
//   Otherwise it stays failed: shown as attention, and refuses a switch or forget() the same way until the user chooses.
//   forget: { extra, keep }: forgetDevice's (the app's own lists; the scopes whose device copy stays).
//   report: the nothing-lost report (createReport), opt-in. config.storage: where the origin's outbox list is kept
//   (default localStorage; null: no registry). nav, now, win: the browser's, for tests.
//   watchEvery: ms between watchdog checks (0: only on nudge()).
//   wake (0.8.3): true binds online, pageshow and visibilitychange (shown again) to nudge('wake') and sending what
//   waits (default off: the app may wire its own).
//   outside() -> how many writes the app knows of outside the queue and not yet acknowledged, a number at once (0.8.1;
//   e.g. writes an older version left in the SDK's own offline queue). They count as track()'s do (below).
//   quiet() (0.7.3, deprecated: use outside or track): false counts as one such write.
//   The hub reads by backend.stampMode unless hub.stampMode says otherwise (an app whose server stamps are not on
//   every record yet passes hub: { stampMode: 'client' }).
//   device: this device's name as people know it ('Ward phone'), shown in conflict popups with held conflicts (0.6.3).
//   Held conflicts (0.6.3, opt-in): backend: { held, edits, mark } (firestore.js). A same-field clash holds the save
//   on the phone that made it, and only there: the server never has it, so other phones have nothing to answer (and
//   two phones can't choose different versions); the held phone's status$ says attention until it is answered.
// -> api { open, watch, save, flush, status$, refreshClaims, nudge, relistens, facts,
//      conflicts, describe, resolve, track, unsentOutside, outsideSettled, heard, idle, copyOf, lastSeen, watchDoc, reconnect,
//      hub, queue, parts }
//   watchDoc(path, cb, onError) (0.8.3) -> stop(): one document (path: segments or 'a/b'), cb(doc | null, meta) when
//   its copy changes; null ("gone") once, only when the server says it is not there or the listener fails (then
//   onError(e) too, and that watch is finished), never from the device copy alone. It feeds facts() and the status;
//   the watchdog restarts it like the lists; sign-out pauses it, as it does the lists. Needs the adapter's listenDoc (firestore.js has it).
//   reconnect({ why }) (0.8.3) -> true once the connection was restarted (the SDK's network off and on), then sends
//   what waits; false offline, under an unsent outside write (a restart may send it twice), or without the switch.
//   watch(scope, coll, cb, { query, limit, listen }): cb(list, meta), meta (0.8.2) with { changed, removed }: the ids whose copy
//   changed since the last call (all of them the first time) and the ids gone from the list. query, limit (1.1.0,
//   view.js): cb gets only the records whose fields equal query's, the first limit of them; one leaving that view is
//   in removed. The device copy and what is listened to stay whole. listen (1.2.0): the app's own listener for that
//   collection instead of the adapter's (adapter.listen's shape: (scope, coll, plan, onSnap, onError) -> stop), its
//   snapshots kept in the device copy and feeding the status, facts() and the watchdog as the adapter's do; a
//   collection is listened to one way at a time (another listen for it throws while it runs).
//   facts() -> { persisted, confirmed, heardAt, inStepAt }: inStepAt (1.2.0): the last time the status was synced (the
//   server heard, nothing waiting), now while it is; 0 before.
//   copyOf(kind, id) (0.8.2) -> the copy of that record a running watch of the open scope last handed (null: none).
//   lastSeen(kind, id) (0.8.2) -> { stamp, signature } of the server's copy as last heard (the device copy after a
//   reload; without this device's unsent saves), to compare with queue.lastSent(kind, id) (the copy this device last
//   sent): both differ only when someone else saved since. null: no running watch has that record.
//   Outside writes (0.8.1): track(promise, { kind, id }) -> the same promise; a write the app sends another way (straight
//   to the SDK) counts as unsent until it settles (either way: a failure is the app's answer to handle). Unsent outside
//   writes keep the status saving, flush and a switch or forget() shut, idle() false, and the watchdog from restarting
//   the connection under them; with kind and id, that record is held like one with unsent saves (a delete heard from
//   elsewhere waits). unsentOutside(kind?, id?) -> their count now (with outside()'s, unless kind is given).
//   outsideSettled(ms = 4000) -> true once none is left (false after ms). queue: { otherPending } still works
//   (deprecated: an async check, only for the switch and forget() gate).
//   heard(meta?) (0.8.1): a read or listener the app runs itself answered ({ fromCache, hasPendingWrites } as its
//   snapshot said; none: the server did): it feeds facts().confirmed/heardAt, the status and the watchdog.
//   idle() (0.8.1) -> true when nothing is being stored, sent, held in the queue (failed and conflicts included) or
//   written outside it: for an update's canReload.
// host: { load() -> the app's SDK (shared, loaded once), user() -> the account signed in (AppUser) or null }.
// -> the api pieces both hand on, plus what each needs to sign out or switch (no promise: src/internal).
import { createSyncHub, replanOnWake, landSaved } from './sync.js';
import { createWriteQueue, watchSaved, jobsNow } from './writes.js';
import { createStores } from './store.js';
import { createOutbox } from './outbox.js';
import { createOutboxRegistry } from './registry.js';
import { createWatchdog } from './watchdog.js';
import { persistGuard } from './persist.js';
import { syncStatus, attentionCount } from './status.js';
import { describeConflict, mergeFields, mergeOf, resolvedRecord, recordSignature } from './conflict.js';
import { viewOf } from './view.js';
import { kindMap } from './kinds.js';

/** @template T @param {T} v @returns {T} */
const copy = v => JSON.parse(JSON.stringify(v));

// (1.3.0) scope names starting `public:` hold data read without sign-in (FORMATS.md), so read only
/** @param {string} s */
const isPublic = s => String(s).startsWith('public:');

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').AppSdk} AppSdk
 * @typedef {import('./types.js').SyncStatus} SyncStatus
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser
 * @typedef {import('./types.js').Outbox} Outbox
 * @typedef {import('./types.js').CommitExtra} CommitExtra
 * @typedef {object} SyncCoreOptions the sync module's options (sync.js), with config's name, sdk and storage
 * @property {string} name the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`
 * @property {string[]} colls the collections synced
 * @property {(scope: string, coll: string) => (string | number)[]} path a collection's path segments
 * @property {() => Promise<AppSdk> | AppSdk} sdk the app's Firebase SDK, loaded once
 * @property {Record<string, import('./kinds.js').KindOption>} [kinds] save kinds -> collection, or { coll, path } (default: each coll is its own kind)
 * @property {Outbox} [outbox] the queue's durable store instead of createOutbox's
 * @property {any} [adapter] { listen, fetchOne, commit, clearCache }, or a factory such as firestore() that makes one (1.5.0)
 * @property {(owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>} [commit] the app's own write instead of adapter.commit
 * @property {Partial<import('./firestore.js').FirestoreBackendOptions> & Record<string, any>} [backend] the Firestore adapter's options
 * @property {Record<string, any>} [hub] more options for createSyncHub
 * @property {Record<string, any>} [stores] more options for createStores
 * @property {Record<string, any>} [queue] more options for createWriteQueue
 * @property {(user: AppUser) => string} [scope] the scope opened at sign-in
 * @property {string[]} [public] (1.3.0) colls read with no account, in `public:*` scopes
 * @property {(err: { code: string, message?: string }, entry: Job) => any} [onRefused] 'archive' sets a refused save aside
 * @property {{ extra?: (() => Promise<any>) | null, keep?: string[] | (() => string[] | Promise<string[]>) }} [forget]
 * @property {import('./types.js').Report | null} [report] the nothing-lost report (createReport), opt-in
 * @property {any} [nav] the browser's navigator, for tests
 * @property {Pick<Storage, 'getItem' | 'setItem'> | null} [storage] where the origin's outbox list is kept (null: no registry)
 * @property {() => number} [now]
 * @property {number} [watchEvery] ms between watchdog checks (0: only on nudge())
 * @property {any} [win] the browser's window, for tests
 * @property {string} [device] this device's name as people know it, shown in conflict popups
 * @property {() => number} [outside] writes the app knows of outside the queue, not yet acknowledged (0.8.1)
 * @property {boolean} [wake] (0.8.3) online, pageshow and a page shown again nudge the watchdog and send what waits
 * @property {() => boolean} [quiet] deprecated (0.8.1: outside or track): false counts as one write outside the queue
 */

/** @param {SyncCoreOptions} options @param {{ load: () => Promise<AppSdk>, user: () => AppUser | null }} host */
export function createSyncCore(options, { load, user }) {
  const { name, colls, path } = options;
  const publicColls = new Set(options.public || []);
  const {
    backend: ownBackend = {}, commit = null,
    onRefused = null, report = null, nav = globalThis.navigator, now = Date.now, watchEvery = 3000,
    win = typeof window !== 'undefined' ? window : null, wake = false,
  } = options;
  // (1.5.0) a factory's own options (firestore({ field, held, ... })) count as backend options; backend's win
  const backendOptions = { ...(typeof options.adapter === 'function' ? options.adapter.options : null), ...ownBackend };
  const storage = 'storage' in options ? options.storage : (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const kinds = kindMap(options.kinds, colls), { collOf, kindOf } = kinds;
  const online = () => nav?.onLine !== false;
  const stampField = backendOptions.field || 'updatedAt';
  const engineFields = [backendOptions.mark || '_saves', backendOptions.serverField || 'serverAt', ...(backendOptions.edits ? [backendOptions.edits] : [])];
  const heldOn = !!backendOptions.held, device = String(options.device || '');
  /** @param {Doc | null | undefined} d */
  const strip = d => { if (!d || !engineFields.some(f => f in d)) return d; const out = { ...d }; for (const f of engineFields) delete out[f]; return out; };

  // the parts
  /** @type {Set<(coll: string, m: import('./types.js').SnapMeta) => void>} */
  const meta = new Set();
  // (1.5.0) a factory (firestore() from @core/sync/firestore, or sync()'s default) is given what the core knows; its
  // snapshots feed the watchdog, as the built-in Firestore adapter's did
  const made = typeof options.adapter === 'function';
  if (!options.adapter) throw new Error('sync needs an adapter');
  /** @type {any} */
  const adapter = made ? options.adapter({
    sdk: async () => { const { F, db } = await load(); return { F, db }; }, path,
    onSnapshotMeta: (/** @type {string} */ coll, /** @type {import('./types.js').SnapMeta} */ m) => { for (const fn of meta) fn(coll, m); },
    editor: () => ({ by: user()?.name || user()?.email || '', device }), ...backendOptions,
  }) : options.adapter;
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
      const tomb = record && !record._deleted ? await hub.tomb(owner, collOf(kind), record.id) : 0;
      if (tomb > 0) extra = { ...extra, after: tomb };
      const at = kinds.pathOf(kind, owner, record);
      if (at) extra = { ...extra, path: at };
      const result = await (commit ? commit(owner, kind, record, base, extra) : adapter.commit(owner, collOf(kind), record, base, extra));
      // (1.3.9) the server's copy into the device copy before the save counts as done: a reload offline right after
      // "synced" shows it, though the listener may not have heard it (only the record's latest save; not one stored
      // at its own path, which another watch holds)
      if (!at && result?.id != null && String(result.id) === String(record.id) && queue.jobKey(kind, record.id) === extra?.key) await landSaved(hub, owner, collOf(kind), result);
      return result;
    },
  });
  const hub = createSyncHub({
    openStore: stores.openStore, listen: adapter.listen, fetchOne: adapter.fetchOne, now,
    binKinds: kinds.colls, unsent: (_scope, coll, id) => queue.unsent(kindOf(coll), id) || unsentOutside(kindOf(coll), id) > 0,
    onError: e => { try { report?.error?.(e?.code); } catch { /* never stops sync */ } console.warn('sync', e?.code || e?.message); },
    ...(backendOptions.stampMode ? { stampMode: backendOptions.stampMode } : {}), ...options.hub,
    // a public scope's bin and feeds would list the account's records: never listened to
    feedsIn: s => !isPublic(s) && (options.hub?.feedsIn?.(s) ?? true),
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

  // the status: confirmed only once the server has answered since the page opened; inStepAt (1.2.0): when it last
  // said synced
  let heard = false, heardAt = 0, inStepAt = 0, persisted = true, relistens = 0;
  /** @type {Set<(st: SyncStatus) => void>} */
  const subs = new Set();
  let lastTold = '';
  const statusNow = () => {
    const n = unsentNow();
    return noteInStep(syncStatus({ online: online(), pending: n.waiting, attention: n.attention, persisted, stale: watchdog.stale(), confirmed: heard, atRiskOnlyOffline: true }));
  };
  let queued = 0;
  function unsentNow() { // 1.3.10 chip+sign-out
    const es = jobsNow(queue), a = es.filter(x => x.refused && /^(archiv|sync)ed$/.test(x.state)).length;
    const w = queue.pending() + unsentOutside() + queued;
    return { waiting: w, attention: attentionCount(es) + a, unsent: w + a };
  }
  /** @param {SyncStatus} st */
  const noteInStep = st => { if (st.state === 'synced') inStepAt = now(); return st; };
  const facts = () => { statusNow(); return { persisted, confirmed: heard, heardAt, inStepAt }; };
  /** @param {boolean} [force] */
  function tell(force = false) {
    const st = statusNow();
    if (!subs.size) return;
    const key = st.state + ':' + st.count;
    if (key === lastTold && !force) return;
    lastTold = key;
    for (const fn of [...subs]) fn(st);
  }
  /** @param {(st: SyncStatus) => void} fn @returns {() => boolean} */
  const status$ = fn => { subs.add(fn); const st = statusNow(); lastTold = st.state + ':' + st.count; fn(st); return () => subs.delete(fn); };
  /** @param {import('./types.js').SnapMeta} m */
  const onSnap = m => { watchdog.heard(m); if (!m?.fromCache) { heard = true; heardAt = now(); } tell(); };
  if (made) meta.add((_coll, m) => watchdog.heard(m));

  // watches: each one's list (device copy, then the server) with this device's unsent saves laid over it, again when
  // either changes (watchSaved); only what the listener hears feeds the status and the watchdog
  /** @typedef {{ scope: string, coll: string, cb: (list: Doc[], meta: any) => void, view: ((list: Doc[]) => Doc[]) | null, listen: import('./types.js').Listen | null, off: ReturnType<typeof watchSaved> | null }} Watch */
  /** @type {Set<Watch>} */
  const watches = new Set();
  /** @param {import('./types.js').Listen | null} listen */
  const heardHub = listen => ({ watch: (/** @type {string} */ s, /** @type {string} */ coll, /** @type {(list: Doc[], meta: any) => void} */ fn) => hub.watch(s, coll, (list, m) => { if (m) onSnap(m); fn(list, m); }, listen) });
  /** @param {Watch} w */
  const start = w => { w.off = watchSaved({ hub: heardHub(w.listen), queue, scope: w.scope, coll: w.coll, kind: kindOf(w.coll), view: w.view }, (list, m) => w.cb(/** @type {Doc[]} */ (list.map(strip)), m || {})); };
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
  // keepPublic: the public scopes' watches carry on (sign-out)
  const stopWatches = (keepPublic = false) => {
    for (const w of watches) if (!(keepPublic && isPublic(w.scope))) { w.off?.(); w.off = null; }
    for (const w of docWatches) { const off = w.off; w.off = null; off?.(); }
  };
  // (the ones on the app's own listener first: a plain watch of that collection then joins it, never the other way)
  // only (1.3.0): just those (a relisten: the ones running, not those a sign-out paused)
  /** @param {Set<Watch | DocWatch> | null} [only] */
  const startWatches = (only = null) => {
    /** @param {Watch | DocWatch} w */
    const due = w => !w.off && (!only || only.has(w));
    for (const w of [...watches].sort((a, b) => Number(!a.listen) - Number(!b.listen))) if (due(w)) start(w);
    for (const w of docWatches) if (due(w) && !w.failed) startDoc(w);
  };
  /** @param {string} s @param {string} coll @param {(list: Doc[], meta: any) => void} cb @param {import('./types.js').WatchOptions} [options] @returns {() => void} */
  function watch(s, coll, cb, options) {
    const listen = options?.listen ?? null;
    if (listen !== null && typeof listen !== 'function') throw new Error('watch: listen is a function');
    if (isPublic(s) && !publicColls.has(coll)) throw new Error('watch: ' + coll + ' is not a public collection');
    /** @type {Watch} */
    const w = { scope: s, coll, cb, view: viewOf(options), listen, off: null };
    start(w); watches.add(w);
    if (watchEvery > 0 && !timer) { timer = setInterval(() => watchdog.check(), watchEvery); /** @type {any} */ (timer).unref?.(); }
    return () => { w.off?.(); watches.delete(w); };
  }

  // (0.8.2) the copy a running watch of the open scope last handed (copyOf), and the engine's copy as last heard
  // (lastSeen: { stamp, signature }, to tell a change made elsewhere from this device's own); null: none
  /** @param {string} kind */
  const watchOf = kind => [...watches].find(w => w.scope === scope && w.coll === collOf(kind) && w.off)?.off || null;
  // (1.1.0: a watch with a view hands only part of the list, so each running one is asked)
  /** @param {string} kind @param {string} id @returns {Doc | null} */
  const copyOf = (kind, id) => {
    for (const w of watches) if (w.scope === scope && w.coll === collOf(kind) && w.off) { const d = w.off.copyOf(id); if (d) return strip(d) ?? null; }
    return null;
  };
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
    relisten: /** @param {string} why */ why => {
      console.warn('listeners replaced:', why); relistens++;
      const running = new Set([...watches, ...docWatches].filter(w => w.off));
      stopWatches(); hub.stopAll().then(() => { startWatches(running); tell(); });
    },
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
    for (const x of jobsNow(queue).map(j => ({ ...j }))) {   // (1.3.12: each job as it was now, not a deep copy of all)
      if (x.record?._deleted && x.state !== 'synced' && x.state !== 'archived') deleting.add(x.key);
      else if (deleting.has(x.key) && x.state === 'synced') {
        deleting.delete(x.key);
        if (queue.jobKey(x.kind, x.record.id) === x.key) void hub.drop(x.owner, collOf(x.kind), [x.record.id]);
      }
      if (x.state !== 'failed' || told.has(x.key) || !onRefused) continue;
      told.add(x.key);
      let answer;
      try { answer = onRefused({ code: x.code || '', message: x.error }, copy(x)); } catch (e) { console.warn('onRefused', e); }
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
    if (isPublic(s)) return Promise.reject(new Error('save: ' + s + ' is read only'));
    const k = kind + ':' + s + ':' + record.id;
    queued++;
    const run = (chains.get(k) || Promise.resolve()).then(() => (queued--, queue.save(kind, s, record, base, opts)));
    const tail = run.catch(() => {}).finally(() => { if (chains.get(k) === tail) chains.delete(k); saving.delete(tail); tell(true); });   // (1.3.9: the unsent count includes saving)
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
  async function open(s) {
    if (isPublic(s)) throw new Error('open: ' + s + ' is read only');
    scope = s; await queue.activate(s); tell(); }

  // held conflicts (0.6.3): this device's own, one per record (the first held save: entries() is newest first, so
  // reversed it is oldest first; later saves on this device's own version wait behind it, and the newest is "mine")
  /** @param {string} key */
  const heldOf = key => {
    const all = queue.entries().reverse(), first = all.find(x => x.key === key && x.state === 'conflict');
    if (!first) return null;
    // (0.7.1: also the saves queued behind it before it was held, so the answer carries them; a merge collection's
    // ops of the whole chain, in order, so the merge function replays every change of this device's)
    const chain = all.filter(x => x.kind === first.kind && x.record.id === first.record.id && (x.state === 'conflict' || x.state === 'pending' && x.at > first.at));
    // (1.5.3: the first base plus each save's own change, so another device's value heard later is never mine)
    const own = first.base && chain.every(x => x.base && !x.record._deleted) ? chain.reduce((acc, x) => mergeFields(acc, x.record, x.base), /** @type {Doc} */ (first.base)) : /** @type {Job} */ (chain.at(-1)).record;
    return { first, held: { record: own, base: first.base ?? null, remote: first.remote ?? null, at: /** @type {Job} */ (chain.at(-1)).at, ...(chain.every(x => x.ops) ? { ops: chain.flatMap(x => x.ops) } : {}) } };
  };
  // the merge function of a merge collection named in held (0.7.1: its clashes are found and answered through it)
  /** @param {string} kind */
  const mergeOfHeld = kind => {
    const h = backendOptions.held, coll = collOf(kind);
    return h && h !== true && Object.hasOwn(h, coll) && h[coll] ? mergeOf(backendOptions.merge, coll) : null;
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
  // (1.3.0) the public watches stopped and their engines ended, so startWatches() listens to them again (sign-in)
  const stopPublic = async () => {
    const pub = [...watches].filter(w => isPublic(w.scope));
    for (const w of pub) { w.off?.(); w.off = null; }
    await Promise.all([...new Set(pub.map(w => w.scope))].map(s => hub.stopScope(s)));
  };
  // what a wipe leaves: no scope, nothing heard or tracked, no watches but the public ones (stopped: startWatches())
  const reset = () => { stopWatches(); for (const w of watches) if (!isPublic(w.scope)) watches.delete(w); docWatches.clear(); scope = ''; heard = false; heardAt = 0; inStepAt = 0; told.clear(); deleting.clear(); tracked.clear(); };
  // signed out, data kept (the sync module): nothing is sent or listened to until the next sign-in
  const close = () => { stopWatches(true); scope = ''; heard = false; tell(); };
  const parts = { hub, queue, stores, adapter, watchdog, registry, outbox };
  return {
    api: {
      open, watch, save, flush, status$, nudge, relistens: () => relistens, facts,
      conflicts, describe, resolve, hub, queue, parts, track, unsentOutside, outsideSettled, heard: heardOf, idle, copyOf,
      lastSeen, watchDoc, reconnect,
    },
    hub, queue, stores, adapter, outbox, registry, saving, statusNow, unsentNow, tell, signedIn, reset, close, addDoc, dropDoc,
    startWatches, stopWatches, stopPublic, scope: () => scope, watching: () => watches.size + docWatches.size,
  };
}
