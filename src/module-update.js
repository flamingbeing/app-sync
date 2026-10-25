// The update module (0.9.1): update(options) -> a module for createApp({ config, modules }) (runner.js). Loaded from
// update.js. Wraps the page side of the update core (update/<x.y.z>/register.js, released on its own): the app
// imports that file and passes it in, so this module loads nothing itself.
//
// update({ register, app, sw, scope, every, canReload, beforeReload, retryOn, nav })
//   register: the register.js module (import * as register from '.../update/0.2.0/register.js'). app, sw, scope,
//   every, beforeReload: as register()'s (update/README.md). canReload: the app's own "nothing open" answer; the take-
//   over reload also waits while the app's status has unsent saves (ctx.status: unsent), so a reload never drops one.
//   retryOn: event names (the other modules', e.g. 'signout') after which the owed reload or go is tried again.
//   nav: the page's navigator (default the global one).
// The service worker is registered after start, not during it (app.ready never waits on the network).
// -> api { version, versionLabel, retryUpdate, forceLatest, checkNow, registration }
//   version(), versionLabel(v), retryUpdate(): as register.js's. forceLatest(): as register.js's, refused while the
//   reload would be (canReload above). registration() -> the ServiceWorkerRegistration, or null (none, or no worker).
//   checkNow({ wait }) -> true when a new version took over (controllerchange) within wait ms (default 10000), false
//   when none is waiting (none found, offline) or it did not take over in time (the reload still waits, see canReload).
//   stop() ends retryOn; the worker and register.js's own listeners stay (the page keeps its worker).

/** @param {Record<string, any>} [options] @returns {import('./runner.js').Module} */
export function update(options = {}) {
  const { register: core, retryOn = [], canReload = null, nav: navOpt, ...rest } = options;
  if (!core || typeof core.register !== 'function') throw new Error('update needs register (the register.js module)');
  if (!rest.app) throw new Error('update needs app');
  const nav = navOpt || globalThis.navigator;
  /** @type {(() => void)[]} */
  const offs = [];

  return {
    name: 'update', needs: [],
    start(ctx) {
      // the reload waits for the app's own answer and for every module's unsent saves
      const none = () => ctx.status.get().unsent === 0;
      const allows = async () => none() && (!canReload || !!(await canReload())) && none();   // (again: a save made meanwhile)
      /** @type {Promise<any>} */
      const reg = Promise.resolve()
        .then(() => core.register({ ...rest, canReload: allows }))
        .catch(/** @returns {null} */ (/** @type {any} */ e) => { console.warn('update: register', e?.message || e); return null; });
      for (const event of retryOn) offs.push(ctx.on(event, () => { void core.retryUpdate(); }));

      /** @param {{ wait?: number }} [o] */
      async function checkNow({ wait = 10000 } = {}) {
        const r = await reg, sw = nav?.serviceWorker;
        if (!r || !sw) return false;
        let took = false, done = (/** @type {boolean} */ _v) => {};
        const took$ = new Promise(res => { done = res; });
        const onChange = () => { took = true; done(true); };
        sw.addEventListener('controllerchange', onChange);
        try {
          try { await r.update(); } catch { return took; }   // (offline: nothing found)
          const w = r.installing;
          if (w) await new Promise(res => {   // a new one found: until it is installed (or gone)
            const on = () => { if (w.state !== 'installing') res(undefined); };
            w.addEventListener?.('statechange', on); on();
          });
          if (took) return true;
          if (!r.waiting) return false;
          await core.retryUpdate();   // (the go for a worker that waits for it, once the reload is allowed)
          const t = new Promise(res => setTimeout(() => res(false), wait));
          return await Promise.race([took$, t]);
        } finally { sw.removeEventListener?.('controllerchange', onChange); }
      }

      return {
        version: () => core.version(), versionLabel: (/** @type {any} */ v) => core.versionLabel(v),
        retryUpdate: () => core.retryUpdate(), forceLatest: () => core.forceLatest({ canReload: allows }),
        checkNow, registration: () => reg,
      };
    },
    stop() { for (const off of offs.splice(0)) off(); },
  };
}
