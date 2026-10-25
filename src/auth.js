// The auth module (0.9.0): auth(options) -> a module for createApp({ config, modules }) (runner.js). Loaded from
// auth.js. Signs in with the app's Firebase SDK (ctx.sdk(): { A, auth, F?, db? }) and tells the other modules who is
// signed in, through the events below. Sign-out keeps this device's data: the device copy and unsent saves stay,
// and send when the same account signs in again.
//
// auth({ claims, beforeSwitch, popupOnly, redirectFirst, fetch, nav, win })
//   claims: as createApp's (url, entry, behind, when, watch + doc, onClaims): after sign-in and on refreshClaims(),
//   when the role doc's v is ahead of the token's, POST url (Bearer token) once per uid:v, then refresh the token.
//   watch: true reads the role doc (doc(user) -> its path) live with the SDK's F.onSnapshot and checks again when it
//   changes; stopped at sign-out. A failure changes nothing (the rules fall back to reading the role doc).
//   beforeSwitch({ from, to }): the app's own step before another account's sign-in wipes the last one's data.
//   popupOnly, redirectFirst: as createApp's (a popup only; redirect first, default in an installed app).
// events (ctx.emit): signin { user } | signout { user } | switch { from, to } | forget { user }
//   The account whose data the device holds (its owner) is kept in ctx.storage(): `<name>:auth/owner` = { uid,
//   email } (FORMATS.md). Another account signing in (a sign-in here, another tab, a reload) is a switch: the app's
//   beforeSwitch, then switch (the modules wipe the old data), then signin. While the old account has unsent saves
//   (ctx.status: unsent) the switch is refused: the new account is signed out again, nothing is wiped, and blocked()
//   says why, until those saves are sent (that account signs in again) or forget({ force }).
// -> api { signIn, signOut, forget, onUser, user, blocked, refreshClaims }
//   signIn({ hint, popupOnly, redirectFirst, method }) -> { ok, reason: '' | 'redirect' | 'unsent', from? }: hint is
//   Google's login_hint; 'redirect': the page is leaving to sign in; 'unsent': refused switch (from: the account with
//   unsent saves). method: 'google' only (the other methods are 1.x).
//   signOut() -> { ok, reason }: Auth signs out; signout is emitted; nothing is wiped, nothing refused.
//   forget({ force, before }) -> { ok, reason: '' | 'unsent', failed }: wipe this device on purpose: refused while
//   anything is unsent unless force; then before() (the app's step; a throw is named in failed), Auth signs out
//   (signout), forget wipes (failed names any module whose wipe threw), and the device has no owner.
//   onUser(cb) -> off: cb(user | null) once known and on each change, after the events. user() -> the account or null.
//   blocked() -> { from, to, reason: 'unsent' } | null: the last refused switch.
import { userOf, claimsBehind } from './user.js';

const REDIRECT_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/cancelled-popup-request'];

/**
 * @typedef {import('./user.js').AppUser} AppUser
 * @typedef {{ uid: string, email: string }} Owner
 * @typedef {object} AuthOptions
 * @property {any} [claims] as createApp's claims (url, entry, behind, when, watch, doc, onClaims)
 * @property {(r: { from: Owner, to: AppUser }) => any} [beforeSwitch] the app's step before another account's data replaces the last one's
 * @property {boolean} [popupOnly]
 * @property {() => boolean} [redirectFirst]
 * @property {typeof fetch} [fetch]
 * @property {any} [nav]
 * @property {any} [win]
 */

/** @param {AuthOptions} [options] @returns {import('./runner.js').Module} */
export function auth(options = {}) {
  const { claims = null, beforeSwitch = null, nav = globalThis.navigator, win = typeof window !== 'undefined' ? window : null } = options;
  const fetchFn = options.fetch || globalThis.fetch;
  /** @type {import('./runner.js').Ctx} */
  let ctx;
  /** @type {ReturnType<import('./runner.js').Ctx['storage']>} */
  let store;
  /** @type {any} */
  let s = null;
  /** @type {AppUser | null} */
  let current = null;
  let known = false, stopped = false, listening = false;
  /** @type {(() => void) | null} */
  let offAuth = null;
  /** @type {string | null | undefined} the uid last handled from Auth */
  let seen;
  /** @type {{ from: Owner, to: AppUser, reason: 'unsent' } | null} */
  let blocked = null;
  /** @type {Set<(u: AppUser | null) => void>} */
  const userSubs = new Set();
  // Auth's answers, handled one at a time (a switch's wipe finishes before the next answer is looked at)
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  const load = async () => {
    const x = await ctx.sdk();
    if (!listening && !stopped) {
      listening = true; s = x;
      x.A.getRedirectResult?.(x.auth)?.catch?.((/** @type {any} */ e) => console.warn('Redirect sign-in failed', e?.code || e));
      offAuth = x.A.onAuthStateChanged(x.auth, (/** @type {any} */ u) => { chain = chain.then(() => handle(u)).catch(e => console.warn('auth', e?.message || e)); });
    }
    return x;
  };
  const tellUser = () => { known = true; for (const fn of [...userSubs]) { try { fn(current); } catch (e) { console.warn('onUser', e); } } };
  const unsent = () => Number(ctx.status.get().unsent) || 0;
  /** @returns {Owner | null} */
  const owner = () => { const o = store.get('owner'); return o && typeof o.uid === 'string' ? { uid: o.uid, email: String(o.email || '') } : null; };

  /** @param {any} u */
  async function handle(u) {
    // every module has started (and reported its unsent saves, and listens) before an answer is looked at
    try { await ctx.ready; } catch { return; }
    if (stopped) return;
    const uid = u?.uid || null;
    if (uid === seen) { if (u && current) current = userOf(u); return; }
    seen = uid;
    if (!u) {
      stopClaimsWatch();
      const was = current;
      current = null;
      if (was) await ctx.emit('signout', { user: was });
      tellUser();
      return;
    }
    const user = /** @type {AppUser} */ (userOf(u)), from = owner();
    if (from && from.uid !== uid) {
      // the last account's unsent saves would go with its data: refuse, sign the new account out, wipe nothing
      if (unsent() > 0) {
        blocked = { from, to: user, reason: 'unsent' };
        seen = null;   // (Auth's answer to this sign-out changes nothing more)
        await s.A.signOut(s.auth);
        stopClaimsWatch();
        const was = current;
        current = null;
        if (was) await ctx.emit('signout', { user: was });
        tellUser();
        return;
      }
      /** @type {string[]} */
      const failed = [];
      if (beforeSwitch) { try { await beforeSwitch({ from, to: user }); } catch (e) { failed.push('before'); console.warn('auth: beforeSwitch', e); } }
      failed.push(...await ctx.emit('switch', { from, to: user }));
      if (failed.length) ctx.report({ event: 'switch', failed });
    }
    store.set('owner', { uid, email: user.email });
    blocked = null;
    current = user;
    await ctx.emit('signin', { user });
    tellUser();
    if (!watchClaims(u)) void refreshClaims();
  }

  /** @param {{ hint?: string, popupOnly?: boolean, redirectFirst?: boolean, method?: string }} [opts] */
  async function signIn({ hint = '', popupOnly = !!options.popupOnly, redirectFirst: redirect = undefined, method = 'google' } = {}) {
    if (method !== 'google') throw new Error(`signIn: method ${method} is not here yet (1.x); google only`);
    const { A, auth } = await load();
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters?.({ prompt: 'select_account', ...(hint ? { login_hint: hint } : {}) });
    blocked = null;
    if (!popupOnly && (redirect ?? redirectFirst())) { await A.signInWithRedirect(auth, provider); return { ok: false, reason: 'redirect' }; }
    try { await A.signInWithPopup(auth, provider); }
    catch (e) {
      if (popupOnly || !REDIRECT_CODES.includes(e?.code)) throw e;
      await A.signInWithRedirect(auth, provider);
      return { ok: false, reason: 'redirect' };
    }
    await chain;
    return blocked ? { ok: false, reason: 'unsent', from: blocked.from } : { ok: true, reason: '' };
  }
  const standalone = () => { try { return !!(win?.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone); } catch { return false; } };
  const redirectFirst = options.redirectFirst || (() => standalone() || (/Android/i.test(nav?.userAgent || '') && /Firefox\//i.test(nav?.userAgent || '')));

  async function signOut() {
    const { A, auth } = await load();
    await A.signOut(auth);
    await chain;
    return { ok: true, reason: '' };
  }

  /** @param {{ force?: boolean, before?: (() => any) | null }} [opts] @returns {Promise<{ ok: boolean, reason: '' | 'unsent', failed: string[] }>} */
  async function forget({ force = false, before = null } = {}) {
    let x = null;
    try { x = await load(); } catch (e) { console.warn('forget: no SDK', e?.message || e); }   // (the wipe needs none)
    await chain;
    if (!force && unsent() > 0) return { ok: false, reason: 'unsent', failed: [] };
    /** @type {string[]} */
    const failed = [];
    if (before) { try { await before(); } catch (e) { failed.push('before'); console.warn('forget: before', e); } }
    const user = current ? { uid: current.uid, email: current.email } : owner();
    if (x?.auth.currentUser) { await x.A.signOut(x.auth); await chain; }
    failed.push(...await ctx.emit('forget', { user }));
    store.remove('owner');
    blocked = null;
    return { ok: true, reason: '', failed };
  }

  /** @param {(u: AppUser | null) => void} cb @returns {() => void} */
  function onUser(cb) {
    userSubs.add(cb);
    if (known) cb(current);
    else void load().catch(e => console.warn('auth: SDK', e?.message || e));
    return () => { userSubs.delete(cb); };
  }

  // claims: the role doc ahead of the token asks the Worker for new claims, once per uid:v
  let claimsAsked = '';
  /** @type {any} undefined: the watched role doc has not answered yet */
  let roleDoc;
  /** @type {(() => void) | null} */
  let roleOff = null;
  const stopClaimsWatch = () => { try { roleOff?.(); } catch { /* gone */ } roleOff = null; roleDoc = undefined; };
  /** @param {any} u */
  function watchClaims(u) {
    stopClaimsWatch();
    const F = s?.F;
    if (!claims?.watch || !claims.doc || typeof F?.onSnapshot !== 'function') return false;
    const uid = u.uid, where = claims.doc(userOf(u));
    const segs = (Array.isArray(where) ? where : String(where).split('/')).map(String).filter(Boolean);
    let last = '';
    try {
      roleOff = F.onSnapshot(F.doc(s.db, ...segs), (/** @type {any} */ snap) => {
        if (current?.uid !== uid) return;
        const exists = snap.exists();
        if (!exists && snap.metadata?.fromCache) return;   // (the device copy alone never says it is gone)
        const d = exists ? snap.data() : null, j = JSON.stringify(d);
        if (j === last) return;
        last = j; roleDoc = d;
        void refreshClaims();
      }, (/** @type {any} */ e) => console.warn('claims watch', e?.code || e?.message));
    } catch (e) { console.warn('claims watch', e?.message || e); return false; }
    return true;
  }
  async function refreshClaims() {
    if (!claims?.url) return;
    let asked = false, status = 0;
    try {
      if (claims.when && !claims.when()) return;
      const { auth } = await load(), u = auth.currentUser;
      if (!u || current?.uid !== u.uid) return;
      if (claims.watch && !claims.entry && roleDoc === undefined && roleOff) return;   // (the role doc's first answer asks)
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

  const api = { signIn, signOut, forget, onUser, user: () => current, blocked: () => blocked, refreshClaims };
  return {
    name: 'auth', needs: [],
    start(c) {
      ctx = c; store = c.storage();
      void load().catch(e => console.warn('auth: SDK', e?.message || e));   // (tried again by signIn, onUser, forget)
      return api;
    },
    stop() { stopped = true; offAuth?.(); offAuth = null; stopClaimsWatch(); userSubs.clear(); },
  };
}
