/* app-update sw-core 0.2.0 (Apache-2.0). The service worker core shared by the apps: load it with importScripts from a
   pinned address, then call AppUpdate.init({ app, version, shell, manifest, ... }). See update/README.md. */
(function (self) {
  'use strict';
  const CORE_VERSION = '1.3.2';
  const MANIFEST_PATH = './.app-update-manifest';
  // never cached, whatever the app says: Firebase auth pages, Cloudflare Access, and its return pages
  const NEVER = [/^\/__\//, /^\/cdn-cgi\//];
  // versioned SDK files are the only cross-origin files cached by default (everything else goes to the network)
  const DEFAULT_RULES = [{ name: 'sdk', match: /^https:\/\/www\.gstatic\.com\/firebasejs\/\d/, strategy: 'cache-first', max: 60 }];

  function init(cfg) {
    if (!cfg || !cfg.app || !cfg.version) throw new Error('AppUpdate.init needs app and version');
    const app = cfg.app, version = cfg.version, prefix = app + '-', rtPrefix = prefix + 'rt-';
    if (!version.startsWith(prefix)) throw new Error(`version '${version}' should start with '${prefix}'`);
    const scope = self.registration.scope;
    const abs = u => new URL(u, scope).href;
    const keyOf = u => { const x = new URL(u, scope); x.hash = ''; x.search = ''; return x.href; };
    const root = abs('./'), manifestKey = abs(MANIFEST_PATH);
    const shell = (cfg.shell || []).map(String), manifest = cfg.manifest || {};
    const shellKeys = new Set(shell.map(keyOf));
    const keep = cfg.keep || [];
    const keeps = n => (typeof keep === 'function' ? !!keep(n) : keep.includes(n));
    const never = NEVER.concat(cfg.never || []);
    const rules = (cfg.runtime || []).concat(DEFAULT_RULES);
    const isShellName = n => n.startsWith(prefix) && !n.startsWith(rtPrefix) && !keeps(n);
    const origin = new URL(scope).origin;

    // ---- install: all or nothing; only changed files are fetched when the old version's manifest matches ----
    const hashesUsable = shell.every(u => typeof manifest[u] === 'string');

    async function previous() {
      let best = null;
      for (const n of (await caches.keys()).filter(n => n !== version && isShellName(n))) {
        try {
          const rec = await (await caches.open(n)).match(manifestKey);
          const j = rec && await rec.json();
          if (j && j.manifest && (!best || j.at > best.at)) best = { name: n, at: j.at || 0, manifest: j.manifest };
        } catch (e) { /* unreadable: ignore */ }
      }
      return best;
    }

    async function download(url) {
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok || res.redirected || (res.type && !['basic', 'default', 'cors'].includes(res.type)))
        throw new Error(`${url}: ${res.status || res.type}${res.redirected ? ' (redirected)' : ''}`);
      return res;
    }

    async function precache() {
      await caches.delete(version);
      const cache = await caches.open(version);
      try {
        const old = hashesUsable ? await previous() : null;
        const oldCache = old && await caches.open(old.name);
        await Promise.all(shell.map(async u => {
          const url = abs(u);
          if (oldCache && old.manifest[u] === manifest[u]) {
            const hit = await oldCache.match(url);
            if (hit) return cache.put(url, hit);
          }
          return cache.put(url, await download(url));
        }));
        await cache.put(manifestKey, new Response(JSON.stringify({ version, at: Date.now(), manifest }), { headers: { 'content-type': 'application/json' } }));
      } catch (e) {
        await caches.delete(version);   // no half-filled cache, and the old version keeps running
        throw e;
      }
    }

    self.addEventListener('install', event => {
      if (!cfg.waitForGo) self.skipWaiting();   // waitForGo: stay waiting until a page sends update:go (register's canReload)
      event.waitUntil(precache());
    });

    self.addEventListener('activate', event => event.waitUntil((async () => {
      await self.clients.claim();
      for (const n of await caches.keys()) if (n !== version && isShellName(n)) await caches.delete(n);   // this app's only
    })()));

    // ---- fetch ----
    const isRe = m => Object.prototype.toString.call(m) === '[object RegExp]';
    const matches = (m, url, req) => (typeof m === 'function' ? m(url, req) : isRe(m) ? m.test(url.href) : url.href.startsWith(m));
    const isNever = url => url.origin === origin && never.some(m => (isRe(m) ? m.test(url.pathname) : typeof m === 'function' ? m(url) : url.pathname.startsWith(m)));

    const shellMatch = async url => ((await caches.has(version)) ? (await caches.open(version)).match(url, { ignoreSearch: true }) : undefined);

    async function offlinePage() {
      const hit = cfg.offline && await shellMatch(abs(cfg.offline));
      return hit || new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><p style="font:16px system-ui;margin:2em">You are offline, and this page is not saved on this device yet.</p>',
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    async function navigate(req) {
      const k = keyOf(req.url);
      const hit = (shellKeys.has(k) && await shellMatch(k)) || (shellKeys.has(root) && await shellMatch(root));   // folder, never index.html
      if (hit) return hit;
      try { return await fetch(req); } catch (e) { return offlinePage(); }
    }

    const cacheable = res => res.ok && res.status === 200 && !res.redirected && ['basic', 'cors', 'default'].includes(res.type);
    const stamped = async res => { const h = new Headers(res.headers); h.set('x-app-update-at', String(Date.now())); return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: h }); };
    const fresh = (rule, res) => !rule.maxAge || Date.now() - Number(res.headers.get('x-app-update-at') || 0) < rule.maxAge;

    async function store(rule, req, res) {
      const cache = await caches.open(rtPrefix + (rule.name || 'default'));
      await cache.delete(req.url);
      await cache.put(req.url, await stamped(res));
      let keys = await cache.keys();
      if (rule.maxAge) for (const k of keys) { const r = await cache.match(k); if (r && !fresh(rule, r)) await cache.delete(k); }
      keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - (rule.max || Infinity)))) await cache.delete(k);
    }

    async function runtime(event, rule) {
      const req = event.request, name = rtPrefix + (rule.name || 'default');
      const cached = (await caches.has(name)) ? await (await caches.open(name)).match(req.url) : undefined;
      const load = async () => {
        const res = await fetch(req);
        if (cacheable(res)) event.waitUntil(store(rule, req, res.clone()).catch(() => {}));
        return res;
      };
      const strategy = rule.strategy || 'cache-first';
      if (strategy === 'cache-first') {
        if (cached && fresh(rule, cached)) return cached;
        try { return await load(); } catch (e) { if (cached) return cached; throw e; }   // offline beats expired
      }
      if (strategy === 'stale-while-revalidate') {
        if (cached) { event.waitUntil(load().catch(() => {})); return cached; }
        return load();
      }
      try { return await load(); } catch (e) { if (cached) return cached; throw e; }   // network-first
    }

    self.addEventListener('fetch', event => {
      const req = event.request;
      if (cfg.handle) {   // app hook first: it may answer any request (e.g. a share-target POST)
        let r; try { r = cfg.handle(event); } catch (e) { r = null; }
        if (r) { event.respondWith(r); return; }
      }
      if (req.method !== 'GET' || (req.headers && req.headers.has('range'))) return;
      const url = new URL(req.url);
      if (isNever(url)) return;
      if (url.origin === origin && req.mode === 'navigate') { event.respondWith(navigate(req)); return; }
      const k = keyOf(url.href);   // a shell entry may be an exact-pin address on another site (the page module)
      if (shellKeys.has(k)) { event.respondWith((async () => (await shellMatch(k)) || fetch(req))()); return; }
      const rule = rules.find(r => matches(r.match, url, req));
      if (rule) event.respondWith(runtime(event, rule));
    });

    self.addEventListener('message', event => {
      const d = event.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'update:version') (event.ports && event.ports[0] ? event.ports[0] : event.source).postMessage({ type: 'update:version', version, core: CORE_VERSION });
      else if (d.type === 'update:go' || d.type === 'skipWaiting' || d.type === 'take-over') self.skipWaiting();   // the page's go; the other two: old page code during a migration
    });
  }

  self.AppUpdate = { init, version: CORE_VERSION };
})(typeof self !== 'undefined' ? self : this);
