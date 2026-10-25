// The module runner (0.9.0): createApp({ config, modules }) -> app, one key per module (its api, from start), plus
// ready, stop() and status$. Loaded from app.js (1.0.0-rc.1: the only createApp).
//
// module = { name, needs: ['auth'], start(ctx, deps) -> api | Promise<api>, stop() }
//   Modules start one at a time in `needs` order (otherwise the order given) and stop in reverse; createApp throws at
//   once on a cycle, a missing or duplicate name, or a name the app itself uses. deps holds only the apis named in
//   needs: a module never imports another module's entry. A start that throws stops the ones already started.
// ctx (frozen, one per module): name (config.name), module (its own name), config (frozen), sdk() (the app's Firebase
//   SDK, config.sdk, loaded once for every module; a failed load is tried again next time), user(), on(event, fn) ->
//   off, emit(event, data) -> the names of the modules whose handler threw (or did not run: the app stopped),
//   storage(ns), status, report(fact), ready
//   (resolves once every module has started, rejects if one failed or the app stopped first; never awaited in start).
// events: signin { user } | signout { user } (the device keeps its data) | switch { from, to } (another account:
//   the old one's data is wiped) | forget { user, force } (wiped on purpose). Only the module named auth emits these four;
//   handlers run one at a time in start order and are awaited (a wipe is done when emit resolves). user() is set
//   before the handlers run. Other event names are free for modules to share.
// storage(ns): { name, get(key), set(key, value), remove(key) }, JSON values in config.storage (default
//   localStorage; null: memory) under `<name>:<module>[:<ns>]/<key>` (FORMATS.md). One namespace per module; a
//   module keeps each account's data apart inside it.
// status: set(st) reports this module's { state, count, unsent? } (null: none); get() -> the app's one status:
//   { state (the most urgent), count (that state's), unsent (all modules'), parts }. app.status$(fn) -> off. A module
//   holding unsent saves reports them before its start resolves (the auth module reads them before a switch).
// report(fact): config.report(fact) with the module's name, if the app gave one; never throws.

/** @typedef {{ uid: string, email?: string } & Record<string, any>} EventUser */
/**
 * @typedef {object} Ctx
 * @property {string} name
 * @property {string} module
 * @property {Readonly<Record<string, any>>} config
 * @property {() => Promise<any>} sdk
 * @property {() => EventUser | null} user
 * @property {(event: string, fn: (data: any) => any) => () => void} on
 * @property {(event: string, data?: any) => Promise<string[]>} emit
 * @property {(ns?: string) => { name: string, get: (key: string) => any, set: (key: string, value: any) => void, remove: (key: string) => void }} storage
 * @property {{ set: (st: ModuleStatus | null) => void, get: () => AppStatus }} status
 * @property {(fact: Record<string, any>) => void} report
 * @property {Promise<void>} ready
 * @typedef {{ state: string, count?: number, unsent?: number }} ModuleStatus
 * @typedef {{ state: string, count: number, unsent: number, parts: Record<string, ModuleStatus> }} AppStatus
 * @typedef {{ name: string, needs?: string[], start: (ctx: Ctx, deps: Record<string, any>) => any, stop?: () => any }} Module
 */

const CORE = ['signin', 'signout', 'switch', 'forget'];
const RESERVED = ['ready', 'stop', 'status$'];
// most urgent first (status.js); a state not named here comes after these
const URGENCY = ['attention', 'at-risk', 'offline', 'saving', 'stale', 'unknown', 'synced'];

/** @param {any[]} modules @returns {Module[]} the start order */
function plan(modules) {
  if (!Array.isArray(modules)) throw new Error('createApp needs modules (an array)');
  /** @type {Map<string, Module>} */
  const byName = new Map();
  for (const m of modules) {
    if (!m || typeof m.name !== 'string' || !m.name) throw new Error('createApp: a module needs a name');
    if (typeof m.start !== 'function') throw new Error(`createApp: module ${m.name} needs start(ctx, deps)`);
    if (m.stop != null && typeof m.stop !== 'function') throw new Error(`createApp: module ${m.name}: stop is not a function`);
    if (m.needs != null && !(Array.isArray(m.needs) && m.needs.every((/** @type {any} */ n) => typeof n === 'string'))) throw new Error(`createApp: module ${m.name}: needs is a list of names`);
    if (RESERVED.includes(m.name)) throw new Error(`createApp: ${m.name} is reserved (a module can't be named ${RESERVED.join(', ')})`);
    if (byName.has(m.name)) throw new Error(`createApp: two modules named ${m.name}`);
    byName.set(m.name, m);
  }
  /** @type {Module[]} */
  const order = [];
  /** @type {Map<string, 'busy' | 'done'>} */
  const seen = new Map();
  /** @param {Module} m @param {string[]} path */
  const visit = (m, path) => {
    if (seen.get(m.name) === 'done') return;
    if (seen.get(m.name) === 'busy') throw new Error(`createApp: modules need each other in a cycle: ${[...path, m.name].join(' > ')}`);
    seen.set(m.name, 'busy');
    for (const n of m.needs || []) {
      const dep = byName.get(n);
      if (!dep) throw new Error(`createApp: module ${m.name} needs ${n}, which is not in modules`);
      visit(dep, [...path, m.name]);
    }
    seen.set(m.name, 'done');
    order.push(m);
  };
  for (const m of byName.values()) visit(m, []);
  return order;
}

/** @param {{ config: Record<string, any>, modules: Module[] }} options */
export function createApp({ config, modules } = /** @type {any} */ ({})) {
  if (!config || typeof config.name !== 'string' || !config.name) throw new Error('createApp needs config.name');
  const order = plan(modules);
  const frozen = Object.freeze({ ...config });

  /** @type {Promise<any> | null} */
  let loaded = null;
  const sdk = () => {
    if (loaded) return loaded;
    loaded = Promise.resolve().then(() => { if (typeof config.sdk !== 'function') throw new Error('createApp needs config.sdk'); return config.sdk(); });
    loaded.catch(() => { loaded = null; });
    return loaded;
  };

  // events: handlers in start order (each module's own set), removed when that module stops
  /** @type {Map<string, Map<string, Set<(data: any) => any>>>} module -> event -> handlers */
  const handlers = new Map(order.map(m => [m.name, new Map()]));
  /** @type {EventUser | null} */
  let current = null;
  let stopped = false;
  /** @param {string} from @param {string} event @param {any} data @returns {Promise<string[]>} */
  async function emit(from, event, data = {}) {
    if (CORE.includes(event) && from !== 'auth') throw new Error(`only the auth module emits ${event}`);
    if (stopped) return order.map(m => m.name);   // (a wipe asked after stop did not run: as if it threw)
    const d = Object.freeze({ ...data });
    if (event === 'signin') current = d.user || null;
    else if (event === 'signout' || event === 'forget') current = null;
    /** @type {string[]} */
    const failed = [];
    // (the app stopped: nothing more runs, the modules not reached are named as if their handler threw; checked
    // before each module too, as stop clears a module's handlers)
    const cut = (/** @type {number} */ i) => [...new Set([...failed, ...order.slice(i).map(n => n.name)])];
    for (const [i, m] of order.entries()) {
      if (stopped) return cut(i);
      for (const fn of [...handlers.get(m.name)?.get(event) || []]) {
        if (stopped) return cut(i);
        try { await fn(d); } catch (e) { if (!failed.includes(m.name)) failed.push(m.name); console.warn(`${m.name}: ${event}`, e?.message || e); }
      }
    }
    return failed;
  }

  // storage: JSON in config.storage (localStorage by default), else in memory for the page
  /** @type {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} */
  const kv = (() => {
    let s = null;
    try { s = 'storage' in config ? config.storage : globalThis.localStorage || null; } catch { s = null; }
    if (s) return s;
    const m = new Map();
    return { getItem: (/** @type {string} */ k) => m.has(k) ? m.get(k) : null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, String(v)); }, removeItem: (/** @type {string} */ k) => { m.delete(k); } };
  })();
  /** @param {string} module @param {string} [ns] */
  const storage = (module, ns = '') => {
    const name = config.name + ':' + module + (ns ? ':' + ns : '');
    return Object.freeze({
      name,
      get: (/** @type {string} */ key) => { try { const v = kv.getItem(name + '/' + key); return v == null ? null : JSON.parse(v); } catch { return null; } },
      set: (/** @type {string} */ key, /** @type {any} */ value) => { kv.setItem(name + '/' + key, JSON.stringify(value)); },
      remove: (/** @type {string} */ key) => { try { kv.removeItem(name + '/' + key); } catch { /* gone already */ } },
    });
  };

  // status: each module's report, read as one
  /** @type {Map<string, ModuleStatus>} */
  const parts = new Map();
  /** @type {Set<(st: AppStatus) => void>} */
  const subs = new Set();
  /** @returns {AppStatus} */
  const statusNow = () => {
    const rank = (/** @type {string} */ s) => { const i = URGENCY.indexOf(s); return i < 0 ? URGENCY.length : i; };
    let top = { state: 'synced', count: 0 }, unsent = 0;
    for (const st of parts.values()) {
      unsent += Math.max(0, Number(st.unsent) || 0);
      if (rank(st.state) < rank(top.state)) top = { state: st.state, count: Number(st.count) || 0 };
    }
    return { ...top, unsent, parts: Object.fromEntries(parts) };
  };
  let lastTold = '';
  const tell = () => {
    const st = statusNow(), key = st.state + ':' + st.count + ':' + st.unsent;
    if (key === lastTold) return;
    lastTold = key;
    for (const fn of [...subs]) { try { fn(st); } catch (e) { console.warn('status$', e); } }
  };
  /** @param {(st: AppStatus) => void} fn @returns {() => void} */
  const status$ = fn => { subs.add(fn); const st = statusNow(); lastTold = st.state + ':' + st.count + ':' + st.unsent; fn(st); return () => { subs.delete(fn); }; };

  /** @param {Module} m @returns {Ctx} */
  const ctxOf = m => Object.freeze({
    name: config.name, module: m.name, config: frozen, sdk, user: () => current,
    on: (/** @type {string} */ event, /** @type {(data: any) => any} */ fn) => {
      const mine = /** @type {Map<string, Set<(data: any) => any>>} */ (handlers.get(m.name));
      if (!mine.has(event)) mine.set(event, new Set());
      const set = /** @type {Set<(data: any) => any>} */ (mine.get(event));
      const h = (/** @type {any} */ d) => fn(d);   // (one registration each, even of the same function)
      set.add(h);
      return () => { set.delete(h); };
    },
    emit: (/** @type {string} */ event, /** @type {any} */ data) => emit(m.name, event, data),
    storage: (/** @type {string | undefined} */ ns) => storage(m.name, ns),
    status: Object.freeze({
      set: (/** @type {ModuleStatus | null} */ st) => { if (st) parts.set(m.name, { ...st }); else parts.delete(m.name); tell(); },
      get: statusNow,
    }),
    report: (/** @type {Record<string, any>} */ fact) => { try { if (typeof config.report === 'function') config.report({ module: m.name, ...fact }); } catch { /* never stops the app */ } },
    ready: startedAll,
  });

  // every module started: what ctx.ready waits for (before app.ready, which is set further down)
  /** @type {(v: void) => void} */
  let allStarted = () => {};
  /** @type {(e: any) => void} */
  let notStarted = () => {};
  /** @type {Promise<void>} */
  const startedAll = new Promise((res, rej) => { allStarted = res; notStarted = rej; });
  startedAll.catch(() => {});

  /** @type {Module[]} */
  const started = [];
  /** @type {Promise<{ failed: string[] }> | null} */
  let stopping = null;
  /** @type {Record<string, any>} */
  const app = {};
  const stopStarted = async () => {
    /** @type {string[]} */
    const failed = [];
    for (const m of started.splice(0).reverse()) {
      try { await m.stop?.(); } catch (e) { failed.push(m.name); console.warn(`${m.name}: stop`, e?.message || e); }
      handlers.get(m.name)?.clear();
      parts.delete(m.name);
    }
    return { failed };
  };
  const ready = (async () => {
    for (const m of order) {
      if (stopping) throw new Error('createApp: stopped before it was ready');
      const deps = Object.freeze(Object.fromEntries((m.needs || []).map(n => [n, app[n]])));
      let api;
      try { api = await m.start(ctxOf(m), deps); } catch (e) { if (!stopping) await stopStarted(); throw e; }
      started.push(m);
      Object.defineProperty(app, m.name, { value: api, enumerable: true });
    }
    if (stopping) throw new Error('createApp: stopped before it was ready');
    return app;
  })();
  ready.then(() => allStarted(), notStarted);
  ready.catch(() => {});   // (an app that never awaits ready is told by its modules' apis, not an unhandled rejection)
  const stop = () => stopping ||= (async () => {
    await ready.catch(() => {});
    stopped = true;
    return stopStarted();
  })();
  Object.defineProperties(app, {
    ready: { value: ready }, stop: { value: stop }, status$: { value: status$ },
  });
  return app;
}
