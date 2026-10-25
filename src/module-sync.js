// The sync module (0.9.1): sync(options) -> a module for createApp({ config, modules }) (runner.js), needs auth. Loaded
// from sync.js. Built on core.js: the device copy, the outbox and queue, the watches, the watchdog, the status and
// the held conflicts, as the one-object createApp (0.6-0.9, removed in 1.0.0-rc.1) had them. Same stored formats (FORMATS.md:
// device copy `<name>-sync:`, outbox `<name>-outbox`, the origin's outbox list), so an app moving to the modules keeps
// what its phones hold, and two apps on one origin still wait for each other's saves.
//
// sync({ colls, path, kinds, scope, backend, adapter, commit, outbox, hub, stores, queue, onRefused, forget, report,
//        device, outside, wake, watchEvery, nav, now, win, reload })
//   Documented in core.js (the sign-in ones are the auth module's; name, sdk, storage are config's).
//   scope(user) -> the scope opened at each sign-in; without it the app calls open(scope).
//   reload: () -> void, called once the SDK's offline cache was cleared by a wipe (the SDK instance can't be used
//   again; default: location.reload()): after a switch, at the new account's sign-in; after forget(), straight away.
// The account's data on this device follows the auth module's events:
//   signin: the scope opens (scope(user)), unsent saves send, the watches listen again.
//   signout: nothing is sent or listened to; the device copy, the outbox and the watches stay (same account: they
//     carry on at its next sign-in). The status still counts the unsent saves of the scope last opened.
//   switch, forget: the last account's device copy, outbox (in every registered outbox on the origin) and the SDK's
//     cache are wiped, then forget.extra(); the watches end. A wipe that fails throws (the auth module then refuses
//     the switch: the old account's data stays and so does its owner), and so does one while that account has unsent
//     saves anywhere on the device (this tab, another tab, another app on the origin; forget({ force }) wipes anyway).
// The scope last opened is kept in ctx.storage(): `<name>:sync/scope` (FORMATS.md), so a reload, signed out, still
// counts its unsent saves (the auth module refuses a switch while there are any) and a switch wipes the right outbox.
// saveMany(kind, scope, records) (1.1.0) -> one result per record ({ status, value | reason }, Promise.allSettled's):
//   each record saved as save() saves it, on the copy this device shows (copyOf) as its base, so a record changed
//   elsewhere since is a conflict (or a held one) of its own, never an overwrite; the rest still land.
// -> api: open, watch, watchDoc, save, saveMany, flush, track, conflicts, describe, resolve, reconnect, nudge, status$, facts,
//    heard, idle, copyOf, lastSeen, unsentOutside, outsideSettled, relistens, queue, hub, parts: as core.js documents them.
import { createSyncCore } from './core.js';
import { forgetDevice } from './forget.js';

const FINISHED = ['synced', 'archived'];
/** @param {{ state: string, refused?: boolean }} x */
const unsentJob = x => !FINISHED.includes(x.state) || !!x.refused;

/** @param {Record<string, any>} [options] @returns {import('./runner.js').Module} */
export function sync(options = {}) {
  if (!Array.isArray(options.colls) || !options.colls.length) throw new Error('sync needs colls');
  if (typeof options.path !== 'function') throw new Error('sync needs path');
  const win = 'win' in options ? options.win : typeof window !== 'undefined' ? window : null;
  const reload = options.reload || (() => { try { win?.location?.reload(); } catch { /* not a page */ } });
  const { scope: scopeOf = null, forget = {} } = options;
  /** @type {ReturnType<typeof createSyncCore> | null} */
  let core = null;
  /** @type {(() => void)[]} */
  const offs = [];
  let owed = false, stopped = false;

  return {
    name: 'sync', needs: ['auth'],
    async start(ctx, { auth }) {
      const store = ctx.storage();
      const config = ctx.config;
      const c = core = createSyncCore(/** @type {any} */ ({
        ...options, name: ctx.name, sdk: ctx.sdk, win,
        storage: 'storage' in config ? config.storage : (() => { try { return globalThis.localStorage || null; } catch { return null; } })(),
      }), { load: ctx.sdk, user: () => auth.user() });
      const api = c.api;

      // the status, with the unsent saves: the open scope's (and writes outside the queue, and saves being stored),
      // else, signed out, the stored ones of the scope last opened
      let storedUnsent = 0;
      const tell = () => {
        if (stopped) return;
        const st = c.statusNow();
        const unsent = c.scope() ? c.queue.entries().filter(unsentJob).length + api.unsentOutside() + c.saving.size : storedUnsent;
        ctx.status.set({ state: st.state, count: st.count, unsent });
      };
      /** @param {string} s */
      const countStored = async s => {
        try { storedUnsent = s ? (await c.outbox.list(s)).filter(unsentJob).length : 0; }
        catch { storedUnsent = 1; }   // (can't tell: counts as unsent, so a switch waits)
        tell();
      };
      offs.push(api.status$(() => tell()), c.queue.onChange(tell));
      await countStored(store.get('scope') || '');

      /** @param {string} s */
      const open = async s => { store.set('scope', s); await api.open(s); tell(); };
      // the last account's data: its outbox (the scope last opened; no sending: the queue's owner is not the open one),
      // the device copy and the SDK's cache, then the app's own lists
      // unless forced: refused (throws) while anything of that account is unsent, here, in another tab (the shared
      // outbox) or in another app on the origin: the old one-object createApp's sign-out check (queue.flush())
      /** @param {boolean} force */
      const wipe = async force => {
        const last = store.get('scope') || '';
        c.close();
        if (last) {
          await c.queue.activate(last);
          if (!force && (c.saving.size || !(await c.queue.flush(0)))) { tell(); throw new Error('sync: unsent saves, nothing wiped'); }
        }
        let s = null;
        try { s = await ctx.sdk(); } catch (e) { console.warn('sync: no SDK for the wipe', /** @type {any} */ (e)?.message); }
        const clear = s && !s.emulator && c.adapter.clearCache ? () => c.adapter.clearCache() : null;
        const r = await forgetDevice({ hub: c.hub, stores: c.stores, queue: c.queue, keep: forget.keep || [], clearBackendCache: clear, extra: forget.extra || null });
        if (r.failed.length) ctx.report({ event: 'wipe', failed: r.failed });
        if (r.failed.includes('wipeStores') || r.failed.includes('forget')) throw new Error('sync: the wipe failed: ' + r.failed.join(', '));
        c.reset(); store.remove('scope'); storedUnsent = 0; tell();
        return !!clear && !r.failed.includes('clearBackendCache');
      };
      offs.push(
        ctx.on('signin', async ({ user }) => {
          if (owed) { owed = false; reload(); return; }   // (the SDK was terminated by the switch's wipe)
          if (scopeOf) { const s = scopeOf(user); store.set('scope', s); }
          await c.signedIn(user, scopeOf);
          c.queue.kick();   // (same account after a sign-out: its queue was kept, so open() didn't start it again)
          c.startWatches(); tell();
        }),
        ctx.on('signout', async () => { const last = c.scope() || store.get('scope') || ''; c.close(); await countStored(last); }),
        ctx.on('switch', async () => { owed = await wipe(false); }),
        ctx.on('forget', async ({ force }) => { if (await wipe(!!force)) setTimeout(reload, 0); }),
      );
      // (a save counts as unsent from the moment it is made, before it is stored)
      /** @type {typeof api.save} */
      const save = (...a) => { const p = api.save(...a); tell(); p.then(tell, tell); return p; };
      /** @type {import('./types.js').SaveMany} */
      const saveMany = (kind, s, records) => Promise.allSettled(records.map(r => save(kind, s, r, api.copyOf(kind, r.id))));
      return { ...api, open, save, saveMany };
    },
    async stop() {
      stopped = true;
      for (const off of offs.splice(0)) off();
      if (core) { core.reset(); await core.hub.stopAll(); }
    },
  };
}
