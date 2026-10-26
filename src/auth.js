// The auth module (0.9.0): auth(options) -> a module for createApp({ config, modules }) (runner.js). Loaded from
// auth.js. Signs in with the app's Firebase SDK (ctx.sdk(): { A, auth, F?, db? }) and tells the other modules who is
// signed in, through the events below. Sign-out keeps this device's data: the device copy and unsent saves stay,
// and send when the same account signs in again.
//
// auth({ methods, claims, beforeSwitch, popupOnly, redirectFirst, fetch, nav, win })
//   methods (1.3.0): the ways to sign in (default ['google']): 'google', and each of src/signin/ by its named export
//   (emailLink(), password(), passcode({ url }), anonymous(); a page bundles only those it names) or by its SHAPES.md
//   name ('emailLink', 'password', 'passcode', 'anonymous'; loaded the first time signIn asks for it).
//   claims: { url, entry(user) -> the role doc { v } | null, behind(entry, tokenClaims), when(), watch, doc,
//   onClaims }: after sign-in and on refreshClaims(), when the role doc's v is ahead of the token's, POST url (Bearer
//   token) once per uid:v, then refresh the token. watch: true reads the role doc (doc(user) -> its path) live with the
//   SDK's F.onSnapshot (entry defaults to it; nothing is asked before its first answer) and checks again when it
//   changes; stopped at sign-out. onClaims({ asked, status }): after each check, whether new claims were asked and the
//   HTTP status (0: not asked or no answer). A failure changes nothing (the rules fall back to reading the role doc).
//   beforeSwitch({ from, to }): the app's own step before another account's sign-in wipes the last one's data.
//   popupOnly: sign in with the popup only, never a redirect: for a page served from another domain than the auth
//   domain, where a redirect sign-in can't finish; a blocked popup throws to the caller (ask for a tap).
//   redirectFirst: sign in with a redirect first (default in an installed app). fetch, nav, win: the browser's, for tests.
// events (ctx.emit): signin { user } | signout { user } | switch { from, to } | forget { user, force }
//   The account whose data the device holds (its owner) is kept in ctx.storage(): `<name>:auth/owner` = { uid,
//   email } (FORMATS.md). Another account signing in (a sign-in here, another tab, a reload) is a switch: the app's
//   beforeSwitch, then switch (the modules wipe the old data), then signin. While the old account has unsent saves
//   (ctx.status: unsent) the switch is refused: the new account is signed out again, nothing is wiped, and blocked()
//   says why, until those saves are sent (that account signs in again) or forget({ force }); a save made during
//   beforeSwitch refuses it too. A module whose wipe throws refuses it as well (reason 'wipe': the old account stays
//   the owner, the new one is signed out, the next sign-in tries the switch again).
// -> api { signIn, signOut, forget, onUser, user, blocked, refreshClaims }
//   signIn({ method, hint, popupOnly, redirectFirst, email, password, code }) -> { ok, reason: '' | 'redirect' |
//   'unsent' | 'wipe' | 'sent' | 'refused', from? }: method one of methods (default 'google'); hint is Google's
//   login_hint; 'redirect': the page is leaving to sign in; 'unsent' | 'wipe': refused switch (from: the account whose
//   data stays); 'sent': the email link is on its way; 'refused': the passcode was not taken, or signOut() or forget()
//   came while the sign-in was out (1.3.6: it signs nobody in; an account that lands anyway is signed out again).
//   Signed in anonymously, another method links its account to the anonymous one (1.3.0): the uid stays, so does the
//   device's data, no switch; the owner and onUser get the account's email. An account that exists already signs in
//   instead (a switch, guarded as any). A passcode's token can't link: it signs in (a switch).
//   signOut() -> { ok, reason }: Auth signs out; signout is emitted; nothing is wiped, nothing refused.
//   forget({ force, before }) -> { ok, reason: '' | 'unsent', failed }: wipe this device on purpose: refused while
//   anything is unsent unless force; then before() (the app's step; a throw is named in failed; a save made during it
//   refuses too), Auth signs out (signout), forget wipes (failed names any module whose wipe threw), and the device has
//   no owner (1.3.6: unless a module's wipe threw: the owner stays, so another account's sign-in is a switch that
//   wipes again).
//   onUser(cb) -> off: cb(user | null) once known and on each change, after the events. user() -> the account or null.
//   blocked() -> { from, to, reason: 'unsent' | 'wipe' } | null: the last refused switch.
import { userOf, claimsBehind } from './user.js';

const REDIRECT_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/cancelled-popup-request'];
// a link refused because that credential has an account already: sign in to it instead
const TAKEN_CODES = ['auth/credential-already-in-use', 'auth/email-already-in-use'];
// the SHAPES.md names (1.3.0), each loaded the first time it is asked for (a bundler gives each a chunk of its own)
/** @type {Record<string, () => Promise<AuthMethod>>} */
const BY_NAME = {
  emailLink: () => import('./signin/email-link.js').then(m => m.emailLink()),
  password: () => import('./signin/password.js').then(m => m.password()),
  passcode: () => import('./signin/passcode.js').then(m => m.passcode()),
  anonymous: () => import('./signin/anonymous.js').then(m => m.anonymous()),
};

/**
 * A sign-in method (1.3.0, src/signin/): signIn(sdk, request, anon) -> { credential } to sign in with (linked to anon,
 * the anonymous account signed in, if any), { token } a custom token to sign in with (1.3.6), { reason } when nobody
 * is signed in by it now, or {} once it signed in.
 * @typedef {{ name: string, signIn: (sdk: any, request: SignInRequest, anon: any) => Promise<{ credential?: any, token?: string, reason?: string }> }} AuthMethod
 * @typedef {import('./types.js').SignInRequest & { popupOnly?: boolean, redirectFirst?: boolean }} SignInRequest
 * @typedef {import('./user.js').AppUser} AppUser
 * @typedef {{ uid: string, email: string }} Owner
 * @typedef {object} AuthOptions
 * @property {(string | AuthMethod)[]} [methods] the ways to sign in (1.3.0; default ['google'])
 * @property {any} [claims] the claims check (url, entry, behind, when, watch, doc, onClaims; above)
 * @property {(r: { from: Owner, to: AppUser }) => any} [beforeSwitch] the app's step before another account's data replaces the last one's
 * @property {boolean} [popupOnly]
 * @property {() => boolean} [redirectFirst]
 * @property {typeof fetch} [fetch]
 * @property {any} [nav]
 * @property {any} [win]
 */

// auth({ methods }) -> name -> the method, or what loads it (a SHAPES.md name)
/** @param {(string | AuthMethod)[]} list @param {AuthMethod} google @returns {Map<string, AuthMethod | (() => Promise<AuthMethod>)>} */
function methodsOf(list, google) {
  /** @type {Map<string, AuthMethod | (() => Promise<AuthMethod>)>} */
  const out = new Map();
  for (const m of list) {
    if (m === 'google') out.set(m, google);
    else if (typeof m === 'string' && BY_NAME[m]) out.set(m, BY_NAME[m]);
    else if (typeof m === 'object' && m?.name && typeof m.signIn === 'function') out.set(m.name, m);
    else throw new Error(`auth: unknown sign-in method ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  }
  return out;
}

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
  /** @type {{ from: Owner, to: AppUser, reason: 'unsent' | 'wipe' } | null} */
  let blocked = null;
  /** @type {Owner | null} the owner whose data this tab holds (null: read the stored one) */
  let held = null;
  /** @type {Set<(u: AppUser | null) => void>} */
  const userSubs = new Set();
  // Auth's answers, handled one at a time (a switch's wipe finishes before the next answer is looked at)
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  // the sign-ins still out; signOut() and forget() mark them overtaken: those sign nobody in
  /** @type {Set<{ overtaken: boolean }>} */
  const signIns = new Set();
  // (outs counts them: an answer whose switch waited on the app or a wipe goes no further after one)
  let outs = 0;
  const overtakeSignIns = () => { outs++; for (const t of signIns) t.overtaken = true; };

  const load = async () => {
    const x = await ctx.sdk();
    if (!listening && !stopped) {
      listening = true; s = x;
      x.A.getRedirectResult?.(x.auth)?.catch?.(async (/** @type {any} */ e) => {
        try { if (await signInIfGoogleTaken(x, e)) return; } catch (err) { e = err; }
        console.warn('Redirect sign-in failed', e?.code || e);
      });
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
    // an account that lands after a sign-out overtook its sign-in: straight out again, before any switch or signin
    if (u && [...signIns].some(t => t.overtaken)) { seen = null; await s.A.signOut(s.auth); return; }
    const uid = u?.uid || null;
    if (uid === seen) { if (u && current) current = userOf(u); return; }
    seen = uid;
    const at = outs;
    if (!u) {
      stopClaimsWatch();
      const was = current;
      current = null;
      if (was) await ctx.emit('signout', { user: was });
      tellUser();
      return;
    }
    // this tab's owner first: another tab may have switched the stored one already, this tab's data is still the old
    const user = /** @type {AppUser} */ (userOf(u)), from = held || owner();
    if (from && from.uid !== uid) {
      // the last account's unsent saves would go with its data: refuse, sign the new account out, wipe nothing
      if (unsent() > 0) return refuse(from, user, 'unsent');
      /** @type {string[]} */
      const failed = [];
      if (beforeSwitch) { try { await beforeSwitch({ from, to: user }); } catch (e) { failed.push('before'); console.warn('auth: beforeSwitch', e); } }
      if (stopped) return;   // (the app stopped during its step: nothing is wiped)
      if (outs !== at) { await s.A.signOut(s.auth); return; }   // (a sign-out came during it: nothing is wiped)
      if (unsent() > 0) return refuse(from, user, 'unsent');   // (a save made during the app's step)
      const wipes = await ctx.emit('switch', { from, to: user });
      if (stopped) return;   // (a module may have stopped before its wipe: the old account stays the owner)
      if (outs !== at) { await s.A.signOut(s.auth); return; }
      failed.push(...wipes);
      if (failed.length) ctx.report({ event: 'switch', failed });
      // a wipe that threw left old data: the old account stays the owner, the switch is tried again next sign-in
      if (wipes.length) return refuse(from, user, 'wipe');
    }
    store.set('owner', held = { uid, email: user.email });
    blocked = null;
    current = user;
    await ctx.emit('signin', { user });
    if (stopped) return;
    tellUser();
    if (!watchClaims(u)) void refreshClaims();
  }

  /** @param {Owner} from @param {AppUser} to @param {'unsent' | 'wipe'} reason */
  async function refuse(from, to, reason) {
    blocked = { from, to, reason };
    seen = null;   // (Auth's answer to this sign-out changes nothing more)
    await s.A.signOut(s.auth);
    stopClaimsWatch();
    const was = current;
    current = null;
    if (was) await ctx.emit('signout', { user: was });
    tellUser();
  }

  /** @param {SignInRequest} [request] */
  async function signIn(request = {}) {
    const ticket = { overtaken: false };
    signIns.add(ticket);
    try {
      const reason = await signInWith(request, ticket);
      if (reason) return { ok: false, reason };
    } finally { signIns.delete(ticket); }
    return blocked ? { ok: false, reason: blocked.reason, from: blocked.from } : { ok: true, reason: '' };
  }
  /** @param {SignInRequest} request @param {{ overtaken: boolean }} ticket @returns {Promise<string>} the reason nobody is signed in by it, or '' */
  async function signInWith(request, ticket) {
    const how = await methodOf(request.method || 'google');
    const x = await load();
    blocked = /** @type {{ from: Owner, to: AppUser, reason: 'unsent' | 'wipe' } | null} */ (null);
    const anon = x.auth.currentUser?.isAnonymous && how.name !== 'anonymous' ? x.auth.currentUser : null;
    const { credential = null, token = '', reason = '' } = await how.signIn(x, request, anon);
    if (reason) return reason;
    if (ticket.overtaken && (token || credential)) return 'refused';   // (a self-signing method is signed out below)
    if (token) await x.A.signInWithCustomToken(x.auth, token);
    else if (credential) await (anon ? linkOrSignIn(x, anon, credential) : x.A.signInWithCredential(x.auth, credential));
    if (anon && x.auth.currentUser?.uid === anon.uid) linked(x.auth.currentUser);
    await chain;
    if (!ticket.overtaken) return '';
    // (Auth may tell of the late account after the chain was read: signed out here then)
    if (x.auth.currentUser) { await x.A.signOut(x.auth); await chain; }
    return 'refused';
  }
  /** @param {string} name @returns {Promise<AuthMethod>} */
  async function methodOf(name) {
    const m = methods.get(name);
    if (!m) throw new Error(`signIn: method ${name} is not in auth({ methods })`);
    if (typeof m !== 'function') return m;
    const loaded = await m();
    methods.set(name, loaded);
    return loaded;
  }
  /** @param {any} x @param {any} anon @param {any} credential */
  async function linkOrSignIn(x, anon, credential) {
    try { await x.A.linkWithCredential(anon, credential); }
    catch (e) {
      if (!TAKEN_CODES.includes(/** @type {any} */ (e)?.code)) throw e;
      await x.A.signInWithCredential(x.auth, credential);
    }
  }
  // linking google to the guest failed as the google account already has its own: sign in to that one instead (a
  // normal switch, guarded as ever); the redirect brings this back as getRedirectResult's error
  /** @param {any} x @param {any} e @returns {Promise<boolean>} */
  async function signInIfGoogleTaken(x, e) {
    const taken = TAKEN_CODES.includes(e?.code) ? x.A.GoogleAuthProvider.credentialFromError?.(e) : null;
    if (taken) await x.A.signInWithCredential(x.auth, taken);
    return !!taken;
  }
  // the anonymous account now linked to a real one: the same uid (Auth tells no change), so no switch; the owner and
  // onUser get its email
  /** @param {any} u */
  const linked = u => {
    chain = chain.then(() => {
      if (current?.uid !== u.uid) return;
      const user = /** @type {AppUser} */ (userOf(u));
      current = user;
      store.set('owner', held = { uid: u.uid, email: user.email });
      tellUser();
    });
  };
  /** @type {AuthMethod} */
  const google = {
    name: 'google',
    async signIn({ A, auth }, { hint = '', popupOnly = !!options.popupOnly, redirectFirst: redirect = undefined }, anon) {
      const provider = new A.GoogleAuthProvider();
      provider.setCustomParameters?.({ prompt: 'select_account', ...(hint ? { login_hint: hint } : {}) });
      const away = () => anon ? A.linkWithRedirect(anon, provider) : A.signInWithRedirect(auth, provider);
      if (!popupOnly && (redirect ?? redirectFirst())) { await away(); return { reason: 'redirect' }; }
      try { await (anon ? A.linkWithPopup(anon, provider) : A.signInWithPopup(auth, provider)); }
      catch (e) {
        if (anon && await signInIfGoogleTaken({ A, auth }, e)) return {};
        if (popupOnly || !REDIRECT_CODES.includes(e?.code)) throw e;
        await away();
        return { reason: 'redirect' };
      }
      return {};
    },
  };
  const methods = methodsOf(options.methods || ['google'], google);
  const standalone = () => { try { return !!(win?.matchMedia?.('(display-mode: standalone)').matches || nav?.standalone); } catch { return false; } };
  const redirectFirst = options.redirectFirst || (() => standalone() || (/Android/i.test(nav?.userAgent || '') && /Firefox\//i.test(nav?.userAgent || '')));

  async function signOut() {
    overtakeSignIns();
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
    if (!force && unsent() > 0) return { ok: false, reason: 'unsent', failed };   // (a save made during the app's step)
    overtakeSignIns();
    const user = current ? { uid: current.uid, email: current.email } : owner();
    if (x?.auth.currentUser) { await x.A.signOut(x.auth); await chain; }
    const wipes = await ctx.emit('forget', { user, force });
    failed.push(...wipes);
    // a wipe that threw (or a stop before every wipe ran) left this owner's data: kept as the owner, the next other
    // account is a switch (wiped again)
    if (!wipes.length && !stopped) { store.remove('owner'); held = null; }
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
