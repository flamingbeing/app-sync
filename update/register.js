// app-update register 0.2.0 (Apache-2.0). Page side: register the service worker, check for a new version on every
// return to the tab, on coming back online and every few hours, reload once when the new one takes over (only when
// the app's canReload allows). See update/README.md.
//   import { register, version, versionLabel, forceLatest, retryUpdate } from 'https://core.anawj.com/update/0.2.0/register.js';
export const CORE_VERSION = '0.2.0';
const state = { app: null, swUrl: null, scope: null, reg: null, canReload: null, retry: null };
// canReload: the app's "nothing open or sending" answer; no hook means yes, a throw means no
const allows = async can => { if (!can) return true; try { return !!(await can()); } catch (e) { return false; } };
const store = {
  get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: the guard just does nothing */ } },
};
const reloadKey = () => `app-update:reload:${state.app}`;

// app: the cache prefix (same as `app` in the service worker). sw: its address, relative to the page.
// canReload: () => bool | Promise<bool>, false while someone types, a sheet is open or changes are sending: the
// take-over reload (and the go for a worker started with waitForGo) waits, and is tried again when the tab is hidden
// or shown, on pagehide, and when the app calls retryUpdate(). beforeReload: awaited just before the reload.
export async function register({ app, sw = 'sw.js', scope, every = 3 * 3600 * 1000, canReload, beforeReload } = {}) {
  if (!app) throw new Error('register needs app');
  if (!('serviceWorker' in navigator)) return null;
  const swUrl = new URL(sw, location.href).href;
  Object.assign(state, { app, swUrl, scope: scope ? new URL(scope, location.href).href : null, canReload: canReload || null });
  const existing = await navigator.serviceWorker.getRegistration(state.scope || swUrl).catch(() => null);
  // a page that already had a worker (or has one waiting to claim it) reloads when a new one takes over; the first
  // install, which only claims the open page, does not
  let had = !!navigator.serviceWorker.controller || !!(existing && existing.active);
  let reloading = false, owed = false;
  const reload = async () => {
    if (!owed || reloading) return;
    if (!(await allows(state.canReload)) || reloading) return;   // still owed: tried again later
    reloading = true;
    store.set(reloadKey(), String(Date.now()));
    if (beforeReload) { try { await beforeReload(); } catch (e) { /* the reload goes ahead */ } }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) { had = true; return; }
    const last = Number(store.get(reloadKey()) || 0);
    if (reloading || Date.now() - last < 20000) return;   // one reload per take-over, never a loop
    owed = true;
    return reload();
  });
  let reg;
  try { reg = await navigator.serviceWorker.register(swUrl, state.scope ? { scope: state.scope } : undefined); }
  catch (e) {   // offline, or the worker file is briefly unreachable: the installed one keeps running
    reg = existing;
    if (!reg) return null;
  }
  state.reg = reg;
  // a worker waiting for the page's go (sw-core waitForGo) gets it once canReload allows
  const go = async () => { const w = reg.waiting; if (w && await allows(state.canReload) && reg.waiting === w) w.postMessage({ type: 'update:go' }); };
  if (reg.addEventListener) reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (w && w.addEventListener) w.addEventListener('statechange', () => { if (w.state === 'installed') go(); });
  });
  state.retry = () => Promise.all([go(), reload()]);
  let lastCheck = 0;
  const check = () => { if (Date.now() - lastCheck < 30000) return Promise.resolve(); lastCheck = Date.now(); return reg.update().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); return state.retry(); });
  window.addEventListener('pageshow', e => { if (e.persisted) check(); });
  window.addEventListener('pagehide', () => state.retry());
  window.addEventListener('online', () => check());
  setInterval(check, every);
  await go();
  return reg;
}

const ask = (worker, ms = 1500) => new Promise((resolve, reject) => {
  const ch = new MessageChannel(), t = setTimeout(() => reject(new Error('no answer')), ms);
  ch.port1.onmessage = e => { clearTimeout(t); resolve(e.data); };
  worker.postMessage({ type: 'update:version' }, [ch.port2]);
});

// the stamped version of the running service worker, e.g. "pantry-2026-10-24-ab12cd34" (null before one controls)
export async function version() {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (c) { try { return (await ask(c)).version; } catch (e) { /* fall back to the caches */ } }
  if (state.app && self.caches) {
    const names = (await caches.keys()).filter(n => n.startsWith(state.app + '-') && !n.startsWith(state.app + '-rt-')).sort();
    return names.at(-1) || null;
  }
  return null;
}

// "2026-10-24 (ab12cd34)" for a settings or about line
export async function versionLabel(v) {
  v = v === undefined ? await version() : v;
  const m = /^.*?-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8})$/.exec(v || '');
  return m ? `${m[1]} (${m[2]})` : v || '';
}

// After the app's reason to wait has gone (a sheet closed, the outbox emptied): try the owed reload or go now.
export function retryUpdate() { return state.retry ? state.retry() : Promise.resolve(); }

// "Get the latest version": refused while canReload (given here, else to register) says no; needs the network
// (checked next); removes only this app's worker and caches, never its data or sign-in, then reloads so the page
// installs the newest version.
export async function forceLatest({ canReload } = {}) {
  if (!state.app) throw new Error('call register first');
  if (!(await allows(canReload || state.canReload))) throw new Error('Changes are still sending: try again in a moment');
  const res = await fetch(state.swUrl, { cache: 'reload' }).catch(() => null);
  if (!res || !res.ok) throw new Error('No connection: staying on this version');
  const reg = state.reg || await navigator.serviceWorker.getRegistration(state.scope || state.swUrl);
  if (reg) await reg.unregister();
  for (const n of await caches.keys()) if (n.startsWith(state.app + '-')) await caches.delete(n);
  location.reload();
}
