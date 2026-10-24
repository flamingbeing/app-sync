// A small fake service worker world for tests: Cache, CacheStorage, fetch, events. Uses Node's Request/Response.
import fs from 'node:fs';
import vm from 'node:vm';

class FakeCache {
  constructor() { this.map = new Map(); }
  static key(r, ignoreSearch) { const u = new URL(typeof r === 'string' ? r : r.url); if (ignoreSearch) u.search = ''; return u.href; }
  async put(r, res) { this.map.set(FakeCache.key(r), new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers })); }
  async match(r, o = {}) {
    const k = FakeCache.key(r, o.ignoreSearch);
    for (const [key, res] of this.map) if (FakeCache.key(key, o.ignoreSearch) === k) return res.clone();
    return undefined;
  }
  async delete(r) { return this.map.delete(FakeCache.key(r)); }
  async keys() { return [...this.map.keys()].map(u => new Request(u)); }
}
class FakeCaches {
  constructor() { this.m = new Map(); }
  async open(n) { if (!this.m.has(n)) this.m.set(n, new FakeCache()); return this.m.get(n); }
  async has(n) { return this.m.has(n); }
  async delete(n) { return this.m.delete(n); }
  async keys() { return [...this.m.keys()]; }
}

// `server`: { 'path': body | Response | (() => Response) }, with .hits counting requests per path
export function makeServer(files) {
  const server = { files, hits: {}, fail: new Set() };
  server.fetch = async (input) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    server.hits[u.pathname] = (server.hits[u.pathname] || 0) + 1;
    if (server.fail.has(u.pathname)) throw new TypeError('network error');
    const f = server.files[u.pathname];
    if (f === undefined) return new Response('nf', { status: 404 });
    if (typeof f === 'function') return f();
    if (f instanceof Response) return f.clone();
    return new Response(f);
  };
  return server;
}

// run sw-core.js in a fresh world; returns { self, caches, fire(type, ev), AppUpdate }
export function makeWorld({ caches = new FakeCaches(), server, scope = 'https://app.test/app/' } = {}) {
  const listeners = {};
  const self = {
    caches, fetch: server.fetch, Request, Response, Headers, URL,
    registration: { scope },
    location: new URL(scope + 'sw.js'),
    clients: { claim: async () => { self.claimed = true; } },
    skipWaiting: () => { self.skipped = true; },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  };
  self.self = self;
  const ctx = vm.createContext(self);
  vm.runInContext(fs.readFileSync(new URL('../sw-core.js', import.meta.url), 'utf8'), ctx);
  const waits = [];
  const fire = async (type, ev = {}) => {
    const w = [];
    let response;
    const e = { ...ev, waitUntil: p => w.push(p), respondWith: p => { response = p; } };
    for (const f of listeners[type] || []) f(e);
    const out = { response: response && await response, handled: response !== undefined };
    await Promise.all(w);   // waitUntil work (cache writes) can be added after the response is ready
    return out;
  };
  // a plain request object, so tests can set mode: 'navigate'
  const doFetch = (url, { method = 'GET', mode = 'cors', headers = {} } = {}) =>
    fire('fetch', { request: { url: new URL(url, scope).href, method, mode, headers: new Headers(headers) } });
  return { self, caches, fire, doFetch, AppUpdate: self.AppUpdate, waits };
}
export { FakeCaches };
