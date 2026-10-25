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
//   refresh the token. A failure changes nothing (the rules fall back to reading the role doc). (0.8.3) watch: true
//   with doc(user) -> the role doc's path: the engine reads it live (entry defaults to it; nothing is asked before its
//   first answer) and checks again whenever it changes; stopped at sign-out. onClaims({ asked, status }): after each
//   check, whether new claims were asked and the HTTP status (0: not asked or no answer), e.g. 503: not set up.
//   onRefused(err, entry) -> 'archive' | anything: a save the server refused (err.code, as the backend threw it);
//   'archive' sets it aside, kept with its code for queue.refused(), retry(key) and discard(key) (0.8.2; after a
//   reload too: the code is on the job, and a refused save found then is told once more). The outbox is then its only
//   copy, so the sign-out gate stays shut ('refused') until it is retried or discarded, or signOut({ force }). Otherwise it stays failed: shown as
//   attention, and the sign-out gate stays shut until the user chooses.
//   forget: { extra, keep }: forgetDevice's (the app's own lists; the scopes whose device copy stays).
//   report: the nothing-lost report (createReport), opt-in. storage: where the origin's outbox list is kept
//   (default localStorage; null: no registry). nav, fetch, now, win: the browser's, for tests.
//   watchEvery: ms between watchdog checks (0: only on nudge()).
//   wake (0.8.3): true binds online, pageshow and visibilitychange (shown again) to nudge('wake') and sending what
//   waits (default off: the app may wire its own).
//   outside() -> how many writes the app knows of outside the queue and not yet acknowledged, a number at once (0.8.1;
//   e.g. writes an older version left in the SDK's own offline queue). They count as track()'s do (below).
//   quiet() (0.7.3, deprecated: use outside or track): false counts as one such write.
//   The hub reads by backend.stampMode unless hub.stampMode says otherwise (an app whose server stamps are not on
//   every record yet passes hub: { stampMode: 'client' }).
//   popupOnly: sign in with the popup only, never a redirect (0.6.2): for a page served from another domain than the
//   auth domain, where a redirect sign-in can't finish; a blocked popup throws to the caller (ask for a tap).
//   device: this device's name as people know it ('Ward phone'), shown in conflict popups with held conflicts (0.6.3).
//   Held conflicts (0.6.3, opt-in): backend: { held, edits, mark } (firestore.js). A same-field clash holds the save
//   on the phone that made it, and only there: the server never has it, so other phones have nothing to answer (and
//   two phones can't choose different versions); the held phone's status$ says attention until it is answered.
// -> { signIn, signOut, onUser, user, open, watch, save, flush, status$, refreshClaims, nudge, relistens, facts,
//      conflicts, describe, resolve, track, unsentOutside, outsideSettled, heard, idle, copyOf, lastSeen, watchDoc, reconnect,
//      hub, queue, parts }
//   watchDoc(path, cb, onError) (0.8.3) -> stop(): one document (path: segments or 'a/b'), cb(doc | null, meta) when
//   its copy changes; null ("gone") once, only when the server says it is not there or the listener fails (then
//   onError(e) too, and that watch is finished), never from the device copy alone. It feeds facts() and the status;
//   the watchdog restarts it like the lists; sign-out stops it. Needs the adapter's listenDoc (firestore.js has it).
//   reconnect({ why }) (0.8.3) -> true once the connection was restarted (the SDK's network off and on), then sends
//   what waits; false offline, under an unsent outside write (a restart may send it twice), or without the switch.
//   watch(scope, coll, cb): cb(list, meta), meta (0.8.2) with { changed, removed }: the ids whose copy changed since the
//   last call (all of them the first time) and the ids gone from the list.
//   copyOf(kind, id) (0.8.2) -> the copy of that record a running watch of the open scope last handed (null: none).
//   lastSeen(kind, id) (0.8.2) -> { stamp, signature } of the server's copy as last heard (the device copy after a
//   reload; without this device's unsent saves), to compare with queue.lastSent(kind, id) (the copy this device last
//   sent): both differ only when someone else saved since. null: no running watch has that record.
//   Outside writes (0.8.1): track(promise, { kind, id }) -> the same promise; a write the app sends another way (straight
//   to the SDK) counts as unsent until it settles (either way: a failure is the app's answer to handle). Unsent outside
//   writes keep the status saving, flush and the sign-out gate shut, idle() false, and the watchdog from restarting
//   the connection under them; with kind and id, that record is held like one with unsent saves (a delete heard from
//   elsewhere waits). unsentOutside(kind?, id?) -> their count now (with outside()'s, unless kind is given).
//   outsideSettled(ms = 4000) -> true once none is left (false after ms). queue: { otherPending } still works
//   (deprecated: an async check, only for the sign-out gate).
//   heard(meta?) (0.8.1): a read or listener the app runs itself answered ({ fromCache, hasPendingWrites } as its
//   snapshot said; none: the server did): it feeds facts().confirmed/heardAt, the status and the watchdog.
//   idle() (0.8.1) -> true when nothing is being stored, sent, held in the queue (failed and conflicts included) or
//   written outside it: for an update's canReload.
//   signIn({ hint, popupOnly, redirectFirst }) (0.8.1, per call): hint, the account's email, is Google's login_hint;
//   popupOnly and redirectFirst (true/false) override the createApp options for this call.
//   hub, queue, parts (0.8.1): promised are queue.{ onChange, pending, status, error, unsent, conflicted } (0.8.2:
//   and refused, retry, discard, entries, finished, lastSent: writes.js) and
//   hub.drop; the rest of hub, queue and parts is an escape hatch with no promise (an app's own sign-out steps go in
//   signOut's before, not around hub.stopAll).
//   facts() -> { persisted, confirmed, heardAt } (0.7.3): the storage guard's answer (false: the browser may clear
//   this device's copy), whether the server has answered since sign-in, and when it last did (ms; 0: not yet), for an
//   app's own status words. flush(ms) waits ms in all (before 0.7.3, up to twice that), and is false while a save
//   is still being stored (it said true then).
//   conflicts(kind?) -> this device's held saves, one per record: [{ key, kind, id, at }] (key: for describe/resolve).
//   describe(key, { timeZone }) -> what the popup shows, side by side (conflict.js describeConflict): the clashing
//   fields, each with this device's value and the server's, when each changed (SGT by default) and who (signed-in
//   name, device). null when that save is no longer held.
//   resolve(key, choice) -> the saved version: choice 'mine' | 'theirs' | { [path]: 'mine' | 'theirs' } (path as
//   describe gives it, a '.' inside a key escaped (0.7.4, conflict.js pathOf); a field not named stays theirs); this
//   device's changes that don't clash are kept either way (conflict.js resolvedRecord), then saved over the server's
//   copy (queue.restore). Nothing is overwritten without this answer.
//   signOut({ wait, force, before }) -> { ok, reason: 'unsent' | 'refused' | 'changed', reload, failed }: refuses while
//   anything is unsent (this app's, another tab's, another registered app's on this origin, writes outside the queue)
//   with nothing deleted ('refused' (0.8.1): a save the server refused waits for the user's Retry or Discard; before,
//   'unsent'), then forgets the device and signs out. 'changed': someone else signed in meanwhile (another tab).
//   force (0.8.1): sign out anyway once the user chose to: after the wait, unsent saves (in every registered outbox)
//   and outside writes are forgotten with the device ('changed' still stops it). before (0.8.1): async (), the app's
//   own step, run after every listener stopped and before anything is wiped (e.g. its own listeners, the Auth
//   sign-out); a throw is named in failed ('before') and the sign-out goes on.
import { createSyncHub, replanOnWake } from './sync.js';
import { createWriteQueue, watchSaved } from './writes.js';
import { createStores } from './store.js';
import { createOutbox } from './outbox.js';
import { createOutboxRegistry } from './registry.js';
import { createWatchdog } from './watchdog.js';
import { persistGuard } from './persist.js';
import { syncStatus, attentionCount } from './status.js';
import { forgetDevice } from './forget.js';
import { describeConflict, mergeFields, resolvedRecord, recordSignature } from './conflict.js';
import { createFirestoreBackend } from './firestore.js';

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').AppSdk} AppSdk
 * @typedef {import('./types.js').SyncStatus} SyncStatus
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {import('./types.js').Outbox} Outbox
 * @typedef {import('./types.js').CommitExtra} CommitExtra
 * @typedef {{ uid: string, email: string, name: string, photo: string, verified: boolean }} AppUser
 * @typedef {object} ClaimsOptions
 * @property {string} url
 * @property {(user: AppUser) => any} [entry] the role doc { v } | null
 * @property {(entry: any, tokenClaims: any) => boolean} [behind]
 * @property {() => boolean} [when]
 * @property {boolean} [watch] (0.8.3) read the role doc live (doc), and refresh the claims when it changes
 * @property {(user: AppUser) => string | (string | number)[]} [doc] (0.8.3) the role doc's path, for watch
 * @property {(r: { asked: boolean, status: number }) => void} [onClaims] (0.8.3) after each check: asked, and the HTTP status (0: none)
 *
 * @typedef {object} AppOptions
 * @property {string} name the app's id: device copy `<name>-sync:`, outbox `<name>-outbox`
 * @property {string[]} colls the collections synced
 * @property {(scope: string, coll: string) => (string | number)[]} path a collection's path segments
 * @property {() => Promise<AppSdk> | AppSdk} sdk the app's Firebase SDK, loaded once
 * @property {Record<string, string>} [kinds] save kinds -> collection (default: each coll is its own kind)
 * @property {Outbox} [outbox] the queue's durable store instead of createOutbox's
 * @property {any} [adapter] { listen, fetchOne, commit, clearCache } instead of the Firestore adapter
 * @property {(owner: string, kind: string, record: Doc, base: Doc | null, extra?: CommitExtra) => Promise<Doc>} [commit] the app's own write instead of adapter.commit
 * @property {Partial<import('./firestore.js').FirestoreBackendOptions> & Record<string, any>} [backend] the Firestore adapter's options
 * @property {Record<string, any>} [hub] more options for createSyncHub
 * @property {Record<string, any>} [stores] more options for createStores
 * @property {Record<string, any>} [queue] more options for createWriteQueue
 * @property {(user: AppUser) => string} [scope] the scope opened at sign-in
 * @property {ClaimsOptions | null} [claims]
 * @property {(err: { code: string, message: string }, entry: Job) => any} [onRefused] 'archive' sets a refused save aside
 * @property {{ extra?: (() => Promise<any>) | null, keep?: string[] | (() => string[] | Promise<string[]>) }} [forget]
 * @property {import('./types.js').Report | null} [report] the nothing-lost report (createReport), opt-in
 * @property {(() => boolean)} [redirectFirst]
 * @property {boolean} [popupOnly] sign in with the popup only, never a redirect
 * @property {any} [nav] the browser's navigator, for tests
 * @property {Pick<Storage, 'getItem' | 'setItem'> | null} [storage] where the origin's outbox list is kept (null: no registry)
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 * @property {number} [watchEvery] ms between watchdog checks (0: only on nudge())
 * @property {any} [win] the browser's window, for tests
 * @property {string} [device] this device's name as people know it, shown in conflict popups
 * @property {() => number} [outside] writes the app knows of outside the queue, not yet acknowledged (0.8.1)
 * @property {boolean} [wake] (0.8.3) online, pageshow and a page shown again nudge the watchdog and send what waits
 * @property {() => boolean} [quiet] deprecated (0.8.1: outside or track): false counts as one write outside the queue
 */

const REDIRECT_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/cancelled-popup-request'];
/** @param {any} s */
const lc = s => String(s || '').trim().toLowerCase();
/** @param {any} u @returns {AppUser | null} */
export const userOf = u => u ? { uid: u.uid, email: lc(u.email), name: u.displayName || u.email || '', photo: u.photoURL || '', verified: u.emailVerified === true } : null;
// the token is behind the role doc: its v is older, or the doc is gone and the token still has one
/** @param {{ v?: any } | null | undefined} entry @param {{ v?: any }} [tokenClaims] @returns {boolean} */
export const claimsBehind = (entry, tokenClaims = {}) => !entry ? tokenClaims.v != null : !(Number(tokenClaims.v) >= (Number.isInteger(entry.v) ? entry.v : 0));

/** @param {AppOptions} options */
export function createApp(options = /** @type {AppOptions} */ ({})) {
  const { name, colls, path, sdk } = options;
  for (const [k, ok] of [['name', typeof name === 'string' && name], ['colls', Array.isArray(colls) && colls.length], ['path', typeof path === 'function'], ['sdk', typeof sdk === 'function']]) {
    if (!ok) throw new Error('createApp needs ' + k);
  }
  const {
    kinds = Object.fromEntries(colls.map(c => [c, c])), backend: backendOptions = {}, commit = null, scope: scopeOf = null,
    claims = null, onRefused = null, forget = {}, report = null, nav = globalThis.navigator, fetch: fetchFn = globalThis.fetch,
    now = Date.now, watchEvery = 3000, win = typeof window !== 'undefined' ? window : null, wake = false,
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

  // the SDK, once a page (every caller shares one promise; a failed load is tried again next time)
  /** @type {Promise<AppSdk> | null} */
  let loaded = null;
  /** @type {AppUser | null} */
  let current = null;
  /** @type {string | null} */
  let signedInUid = null;
  /** @returns {Promise<AppSdk>} */
  const load = () => {
    if (loaded) return loaded;
    loaded = Promise.resolve().then(sdk).then(/** @param {AppSdk} s */ s => {
      s.A.getRedirectResult?.(s.auth)?.catch?.((/** @type {any} */ e) => console.warn('Redirect sign-in failed', e?.code || e));
      current = userOf(s.auth.currentUser);
      s.A.onAuthStateChanged(s.auth, (/** @type {any} */ u) => { current = userOf(u); if (u && u.uid !== signedInUid) { signedInUid = u.uid; void signedIn(u); } else if (!u) { signedInUid = null; stopClaimsWatch(); } });
      return s;
    });
    loaded.catch(() => { loaded = null; });
    return loaded;
  };

  // the parts
  /** @type {Set<(coll: string, m: import('./types.js').SnapMeta) => void>} */
  const meta = new Set();
  const adapter = options.adapter || createFirestoreBackend({
    sdk: async () => { const { F, db } = await load(); return { F, db }; }, path,
    onSnapshotMeta: (coll, m) => { for (const fn of meta) fn(coll, m); },
    editor: () => ({ by: current?.name || current?.email || '', device }), ...backendOptions,
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
  const start = w => { w.off = watchSaved({ hub: heardHub, queue, scope: w.scope, coll: w.coll, kind: kindOf(w.coll) }, (list, m) => w.cb(list.map(strip), m || {})); };
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
      if (j !== w.last) { w.last = j; w.cb(d, meta); }
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
    cycle: /** @param {string} why */ why => { console.warn('connection restarted:', why); void cycleNet().finally(() => tell()); },
  });
  // -> true once the network was switched off and on again (false: no switch in this SDK, it failed, or it took over
  // 4 s); one restart at a time, a second call shares the running one
  function cycleNet() {
    return cycling ||= (async () => {
      try {
        const { F, db } = await load();
        if (typeof F.disableNetwork !== 'function') return false;
        const turn = (async () => { await F.disableNetwork(db); await new Promise(r => setTimeout(r, 300)); await F.enableNetwork(db); return true; })();
        turn.catch(() => {});
        return await Promise.race([turn, new Promise(r => setTimeout(r, 4000, false))]);
      } catch (e) { console.warn('network restart', e?.code || e?.message); return false; } finally { cycling = null; }
    })();
  }
  // (0.8.3) the app's "Reconnect" (Sync now): restart the connection now, then send what waits. Not offline, and not
  // under an unsent outside write (a restart may send it again: an increment counted twice); the queue's own saves are
  // transactions, checked against the server's copy, so they are safe
  /** @param {{ why?: string }} [opts] @returns {Promise<boolean>} */
  async function reconnect({ why = 'asked' } = {}) {
    if (!online() || unsentOutside() > 0) return false;
    console.warn('connection restarted:', why);
    const ok = await cycleNet();
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

  // sign-in: the storage guard, the claims, the scope
  let claimsAsked = '';
  // (0.8.3) claims.watch: the role doc (claims.doc(user) -> its path) read live; undefined: not heard yet
  /** @type {any} */
  let roleDoc;
  /** @type {DocWatch | null} */
  let roleWatch = null;
  const stopClaimsWatch = () => { if (roleWatch) dropDoc(roleWatch); roleWatch = null; roleDoc = undefined; };
  // (a failed listener tells nothing about the role doc: the claims stay as they are, as when the Worker fails)
  /** @param {any} u */
  function watchClaims(u) {
    stopClaimsWatch();
    if (!claims?.watch || !claims.doc || !adapter.listenDoc) return false;
    const uid = u.uid;
    roleWatch = addDoc(claims.doc(userOf(u)), (d, m) => { if (!m.error && (current?.uid || null) === uid) { roleDoc = d; void refreshClaims(); } });
    return true;
  }
  async function refreshClaims() {
    if (!claims?.url) return;
    let asked = false, status = 0;
    try {
      if (claims.when && !claims.when()) return;
      const { auth } = await load(), u = auth.currentUser;
      if (!u) return;
      if (claims.watch && !claims.entry && roleDoc === undefined && roleWatch) return;   // (the role doc's first answer asks)
      const entry = claims.entry ? await claims.entry(userOf(u)) : claims.watch ? roleDoc ?? null : null;
      const { claims: tokenClaims = {} } = await u.getIdTokenResult();
      const key = u.uid + ':' + (entry ? entry.v ?? 0 : '-');
      if ((claims.behind || claimsBehind)(entry, tokenClaims) && claimsAsked !== key) {
        claimsAsked = key; asked = true;
        const r = await fetchFn(claims.url, { method: 'POST', headers: { Authorization: 'Bearer ' + await u.getIdToken() } });
        status = Number(r?.status) || 0;
        if (r?.ok) await u.getIdToken(true);
      }
    } catch (e) { console.warn('claims not updated', e?.message || e); }
    try { claims.onClaims?.({ asked, status }); } catch (e) { console.warn('onClaims', e); }
  }
  /** @param {any} u */
  async function signedIn(u) {
    persistGuard(nav).then(r => { persisted = !!(r.persisted || !r.supported); tell(); }, () => {});
    if (!watchClaims(u)) void refreshClaims();
    if (scopeOf) { try { await open(scopeOf(userOf(u))); } catch (e) { console.warn('open', e?.message); } }
  }
  const standalone = () => { try { return !!(win?.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone); } catch { return false; } };
  const redirectFirst = options.redirectFirst || (() => standalone() || (/Android/i.test(nav?.userAgent || '') && /Firefox\//i.test(nav?.userAgent || '')));
  /** @param {{ hint?: string, popupOnly?: boolean, redirectFirst?: boolean }} [opts] */
  async function signIn({ hint = '', popupOnly = !!options.popupOnly, redirectFirst: redirect = undefined } = {}) {
    const { A, auth } = await load();
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters?.({ prompt: 'select_account', ...(hint ? { login_hint: hint } : {}) });
    if (popupOnly) return void await A.signInWithPopup(auth, provider);
    if (redirect ?? redirectFirst()) return A.signInWithRedirect(auth, provider);
    try { await A.signInWithPopup(auth, provider); }
    catch (e) { if (!REDIRECT_CODES.includes(e?.code)) throw e; await A.signInWithRedirect(auth, provider); }
  }
  /** @param {(user: AppUser | null) => void} cb */
  async function onUser(cb) {
    const { A, auth } = await load();
    return A.onAuthStateChanged(auth, (/** @type {any} */ u) => cb(userOf(u)));
  }

  // sign-out on a shared device: the gate, then forgetDevice's order, then the SDK's sign-out
  // (0.8.1) 'refused' when a save the server refused waits for the user, else 'unsent'
  const shut = () => queue.entries().some(x => x.state === 'failed' || x.refused) ? 'refused' : 'unsent';
  /** @param {{ wait?: number, force?: boolean, before?: (() => any) | null }} [options] @returns {Promise<{ ok: boolean, reason: '' | 'unsent' | 'refused' | 'changed', reload: boolean, failed: string[] }>} */
  async function signOut({ wait = 4000, force = false, before = null } = {}) {
    const s = await load(), uid = s.auth.currentUser?.uid || null;
    if (!(await flush(wait)) && !force) return { ok: false, reason: shut(), reload: false, failed: [] };
    /** @type {'' | 'unsent' | 'refused' | 'changed'} */
    let reason = '';
    let beforeFailed = false;
    const clear = !s.emulator && adapter.clearCache ? () => adapter.clearCache() : null;
    const r = await forgetDevice({
      hub, stores, queue, keep: forget.keep || [], clearBackendCache: clear, extra: forget.extra || null,
      proceed: async () => {
        if ((s.auth.currentUser?.uid || null) !== uid) { reason = 'changed'; return false; }
        if (!force && !(await flush(1500))) { reason = shut(); return false; }
        if (before) {
          try { await before(); } catch (e) { beforeFailed = true; console.warn('signOut: before', e); }
          // (before may sign out of Auth itself; someone else signed in meanwhile, or a save made then, stops the wipe)
          const now = s.auth.currentUser?.uid || null;
          if (now && now !== uid) { reason = 'changed'; return false; }
          if (!force && (saving.size || queue.pending() || unsentOutside())) { reason = shut(); return false; }
        }
        return true;
      },
    });
    if (beforeFailed) r.failed.unshift('before');
    if (!r.wiped) { stopWatches(); startWatches(); return { ok: false, reason, reload: false, failed: r.failed }; }
    stopClaimsWatch(); stopWatches(); watches.clear(); docWatches.clear(); scope = ''; heard = false; heardAt = 0; told.clear(); deleting.clear(); claimsAsked = ''; tracked.clear();
    if (clear) loaded = null;   // (the SDK instance was terminated: the page starts again)
    await s.A.signOut(s.auth);
    current = null;
    return { ok: true, reason: '', reload: !!clear, failed: r.failed };
  }

  // held conflicts (0.6.3): this device's own, one per record (the first held save: entries() is newest first, so
  // reversed it is oldest first; later saves on this device's own version wait behind it, and the newest is "mine")
  /** @param {string} key */
  const heldOf = key => {
    const all = queue.entries().reverse(), first = all.find(x => x.key === key && x.state === 'conflict');
    if (!first) return null;
    // (0.7.1: also the saves queued behind it before it was held, so the answer carries them; a merge collection's
    // ops of the whole chain, in order, so the merge function replays every change of this device's)
    const chain = all.filter(x => x.kind === first.kind && x.record.id === first.record.id && (x.state === 'conflict' || x.state === 'pending' && x.at > first.at));
    return { first, held: { record: chain.at(-1).record, base: first.base ?? null, remote: first.remote ?? null, at: chain.at(-1).at, ...(chain.every(x => x.ops) ? { ops: chain.flatMap(x => x.ops) } : {}) } };
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
    return { key, kind: h.first.kind, id: h.first.record.id, ...describeConflict(h.held, { counters: countersOf(h.first.kind), skip, edits: backendOptions.edits || null, me: { by: current?.name || current?.email || '', device }, timeZone, merge: mergeOfHeld(h.first.kind) }) };
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
  const parts = { hub, queue, stores, adapter, watchdog, registry, outbox };
  return {
    signIn, signOut, onUser, user: () => current, open, watch, save, flush, status$, refreshClaims, nudge,
    relistens: () => relistens, facts: () => ({ persisted, confirmed: heard, heardAt }), conflicts, describe, resolve, hub, queue, parts,
    track, unsentOutside, outsideSettled, heard: heardOf, idle, copyOf, lastSeen, watchDoc, reconnect,
  };
}
