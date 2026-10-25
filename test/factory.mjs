// The createApp the createApp tests (app, held conflicts, model) run on: the old one-object api, built from the
// modules: createApp({ config, modules: [auth(), sync()] }). The one-object createApp itself is gone (1.0.0-rc.1);
// these tests were written for it and now prove the modules behave the same. signOut maps to the flush gate, then auth.forget() (the only
// wipe in the modules; signOut there keeps the data). Made-up data only.
import { createApp as runner } from '../app.js';
import { auth } from '../auth.js';
import { sync } from '../sync.js';

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));

/** @param {any} options */
export function createApp(options = {}) {
  const { name, colls, path, sdk } = options;
  for (const [k, ok] of [['name', typeof name === 'string' && name], ['colls', Array.isArray(colls) && colls.length], ['path', typeof path === 'function'], ['sdk', typeof sdk === 'function']]) {
    if (!ok) throw new Error('createApp needs ' + k);
  }
  const { claims, popupOnly, redirectFirst, fetch, nav, win, storage, ...rest } = options;
  let reloaded = false;
  const app = runner({
    config: { name, sdk, ...('storage' in options ? { storage } : {}) },
    modules: [auth({ claims, popupOnly, redirectFirst, fetch, nav, win }), sync({ ...rest, nav, win: win ?? null, reload: () => { reloaded = true; } })],
  });
  return app.ready.then(a => {
    const s = a.sync, au = a.auth;
    const shut = () => s.queue.entries().some(x => x.state === 'failed' || x.refused) ? 'refused' : 'unsent';
    return {
      ...s, user: au.user, refreshClaims: au.refreshClaims, modules: a,
      signIn: async opts => { await au.signIn(opts); },
      onUser: async cb => au.onUser(cb),
      async signOut({ wait = 4000, force = false, before = null } = {}) {
        if (!(await s.flush(wait)) && !force) return { ok: false, reason: shut(), reload: false, failed: [] };
        reloaded = false;
        const r = await au.forget({ force, before });
        if (!r.ok) return { ok: false, reason: shut(), reload: false, failed: r.failed };
        await tick();
        return { ok: true, reason: '', reload: reloaded, failed: r.failed };
      },
    };
  });
}
