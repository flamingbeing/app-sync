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
import { forgetDevice } from './forget.js';
import { createSyncCore } from './core.js';
import { userOf, claimsBehind } from './user.js';
export { userOf, claimsBehind } from './user.js';

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
/**
 * @deprecated 0.9.0: use the modules, `createApp({ config, modules })` from app.js with auth.js (sync and update follow
 * in 0.9.x); this one-object createApp is removed in 1.0.0-rc.1. Apps pinned to 0.x keep it.
 * @param {AppOptions} options
 */
export function createApp(options = /** @type {AppOptions} */ ({})) {
  const { name, colls, path, sdk } = options;
  for (const [k, ok] of [['name', typeof name === 'string' && name], ['colls', Array.isArray(colls) && colls.length], ['path', typeof path === 'function'], ['sdk', typeof sdk === 'function']]) {
    if (!ok) throw new Error('createApp needs ' + k);
  }
  const { scope: scopeOf = null, claims = null, forget = {}, nav = globalThis.navigator, fetch: fetchFn = globalThis.fetch, win = typeof window !== 'undefined' ? window : null } = options;

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

  // the sync part (core.js, shared with the sync module): the device copy, the outbox, the watches, the status
  const core = createSyncCore(options, { load, user: () => current });
  const { api, queue, hub, stores, adapter, saving, addDoc, dropDoc, startWatches, stopWatches } = core;
  const { flush, unsentOutside } = api;

  // sign-in: the storage guard, the claims, the scope
  let claimsAsked = '';
  // (0.8.3) claims.watch: the role doc (claims.doc(user) -> its path) read live; undefined: not heard yet
  /** @type {any} */
  let roleDoc;
  /** @type {ReturnType<typeof addDoc> | null} */
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
    const opening = core.signedIn(/** @type {AppUser} */ (userOf(u)), scopeOf);   // (the storage guard is asked first)
    if (!watchClaims(u)) void refreshClaims();
    await opening;
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
    stopWatches();   // (review, 0.8.3: the doc and claims watches too, before the hook and the wipe; started again if it stops)
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
    if (!r.wiped) { startWatches(); return { ok: false, reason, reload: false, failed: r.failed }; }
    stopClaimsWatch(); core.reset(); claimsAsked = '';
    if (clear) loaded = null;   // (the SDK instance was terminated: the page starts again)
    await s.A.signOut(s.auth);
    current = null;
    return { ok: true, reason: '', reload: !!clear, failed: r.failed };
  }

  return { signIn, signOut, onUser, user: () => current, refreshClaims, ...api };
}
