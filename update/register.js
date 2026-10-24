// app-update register 0.1.0 (Apache-2.0). Page side: register the service worker, check for a new version on every
// return to the tab and every few hours, reload once when the new one takes over. See update/README.md.
//   import { register, version, versionLabel, forceLatest } from 'https://core.anawj.com/update/0.1.0/register.js';
export const CORE_VERSION = '0.1.0';
const state = { app: null, swUrl: null, scope: null, reg: null };
const store = {
  get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* storage blocked: the guard just does nothing */ } },
};
const reloadKey = () => `app-update:reload:${state.app}`;

// app: the cache prefix (same as `app` in the service worker). sw: its address, relative to the page.
export async function register({ app, sw = 'sw.js', scope, every = 3 * 3600 * 1000 } = {}) {
  if (!app) throw new Error('register needs app');
  if (!('serviceWorker' in navigator)) return null;
  const swUrl = new URL(sw, location.href).href;
  Object.assign(state, { app, swUrl, scope: scope ? new URL(scope, location.href).href : null });
  const existing = await navigator.serviceWorker.getRegistration(state.scope || swUrl).catch(() => null);
  // a page that already had a worker (or has one waiting to claim it) reloads when a new one takes over; the first
  // install, which only claims the open page, does not
  let had = !!navigator.serviceWorker.controller || !!(existing && existing.active);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) { had = true; return; }
    const last = Number(store.get(reloadKey()) || 0);
    if (reloading || Date.now() - last < 20000) return;   // one reload per take-over, never a loop
    reloading = true;
    store.set(reloadKey(), String(Date.now()));
    location.reload();
  });
  let reg;
  try { reg = await navigator.serviceWorker.register(swUrl, state.scope ? { scope: state.scope } : undefined); }
  catch (e) {   // offline, or the worker file is briefly unreachable: the installed one keeps running
    reg = existing;
    if (!reg) return null;
  }
  state.reg = reg;
  let lastCheck = 0;
  const check = () => { if (Date.now() - lastCheck < 30000) return Promise.resolve(); lastCheck = Date.now(); return reg.update().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('pageshow', e => { if (e.persisted) check(); });
  setInterval(check, every);
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

// "Get the latest version": needs the network (checked first); removes only this app's worker and caches, never its
// data or sign-in, then reloads so the page installs the newest version.
export async function forceLatest() {
  if (!state.app) throw new Error('call register first');
  const res = await fetch(state.swUrl, { cache: 'reload' }).catch(() => null);
  if (!res || !res.ok) throw new Error('No connection: staying on this version');
  const reg = state.reg || await navigator.serviceWorker.getRegistration(state.scope || state.swUrl);
  if (reg) await reg.unregister();
  for (const n of await caches.keys()) if (n.startsWith(state.app + '-')) await caches.delete(n);
  location.reload();
}
