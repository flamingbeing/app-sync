// The sync module (0.9.1): sync(options) -> a module for createApp({ config, modules }) (runner.js), needs auth. Loaded
// from sync.js. Built on core.js: the device copy, the outbox and queue, the watches, the watchdog, the status and
// the held conflicts, as the one-object createApp (0.6-0.9, removed in 1.0.0-rc.1) had them. Same stored formats (FORMATS.md:
// device copy `<name>-sync:`, outbox `<name>-outbox`, the origin's outbox list), so an app moving to the modules keeps
// what its phones hold, and two apps on one origin still wait for each other's saves.
//
// sync({ colls, path, kinds, scope, public, backend, adapter, commit, outbox, hub, stores, queue, onRefused, forget, report,
//        device, outside, wake, watchEvery, nav, now, win, reload, reopen })
//   Documented in core.js (the sign-in ones are the auth module's; name, sdk, storage are config's).
//   scope(user) -> the scope opened at each sign-in; without it the app calls open(scope).
//   reload: () -> void, called once the SDK's offline cache was cleared by a wipe (the SDK instance can't be used
//   again; default: location.reload()): after a switch, at the new account's sign-in; after forget(), straight away.
//   reopen (1.2.0): async ({ memory, sdk }) -> a new Firestore instance in place of the one a wipe ended, so the page
//   need not reload: memory false asks for a persistent cache (the old one is cleared), true for a memory-only one
//   (asked when the old cache could not be cleared, another tab still holding it, or a persistent one would not
//   open), so the last account's cache is never read again. It becomes the db of the SDK every module shares
//   (ctx.sdk(); the auth module's claims watch too; its other parts stay); one that throws both ways: reload as
//   without reopen.
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
import { kindMap } from './kinds.js';

const FINISHED = ['synced', 'archived'];
/** @param {{ state: string, refused?: boolean }} x */
const unsentJob = x => !FINISHED.includes(x.state) || !!x.refused;

/** @param {Record<string, any>} [options] @returns {import('./runner.js').Module} */
export function sync(options = {}) {
  if (!Array.isArray(options.colls) || !options.colls.length) throw new Error('sync needs colls');
  if (typeof options.path !== 'function') throw new Error('sync needs path');
  kindMap(options.kinds, options.colls);   // (a bad kind fails here, not at the first save)
  for (const c of options.public || []) if (!options.colls.includes(c)) throw new Error('sync: public: ' + c + ' is not in colls');
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
      // (1.5.0) no adapter: the Firestore one, loaded here (the 1.x default), so a page with its own never loads it
      const adapter = options.adapter || (await import('./firestore.js')).firestore();
      const c = core = createSyncCore(/** @type {any} */ ({
        ...options, adapter, name: ctx.name, sdk: ctx.sdk, win,
        storage: 'storage' in config ? config.storage : (() => { try { return globalThis.localStorage || null; } catch { return null; } })(),
      }), { load: ctx.sdk, user: () => auth.user() });
      const api = c.api;

      // the status, with the unsent saves: the open scope's (and writes outside the queue, and saves being stored),
      // else, signed out, the stored ones of the scope last opened
      let storedUnsent = 0;
      const tell = () => {
        if (stopped) return;
        const st = c.statusNow();
        const unsent = c.scope() ? c.unsentNow().unsent : storedUnsent;
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
      // -> { ended, cleared }: whether the wipe ended the SDK instance (cleared its cache, or tried to), and cleared it
      /** @param {boolean} force @returns {Promise<{ ended: boolean, cleared: boolean }>} */
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
        return { ended: !!clear, cleared: !!clear && !r.failed.includes('clearBackendCache') };
      };
      // (1.2.0) a new instance from reopen, put on the SDK every module shares (ctx.sdk()'s db): persistent once the
      // old cache is cleared, else (or if that won't open) memory only -> true; false: none
      /** @param {boolean} cleared */
      const reopen = async cleared => {
        for (const memory of cleared ? [false, true] : [true]) {
          try { const sdk = await ctx.sdk(); sdk.db = await options.reopen({ memory, sdk }); return true; }
          catch (e) { console.warn('sync: reopen', /** @type {any} */ (e)?.message); }
        }
        return false;
      };
      // after a wipe -> true: the page must reload. Without reopen only once the cache was cleared (as 1.0: one not
      // cleared stays until the other tabs close); with it, only when it made no instance
      /** @param {{ ended: boolean, cleared: boolean }} w */
      const reloadOwed = async ({ ended, cleared }) => {
        if (!ended) return false;
        if (!options.reopen) return cleared;
        return !(await reopen(cleared));
      };
      offs.push(
        ctx.on('signin', async ({ user }) => {
          if (owed) { owed = false; reload(); return; }   // (the SDK was terminated by the switch's wipe)
          if (scopeOf) { const s = scopeOf(user); store.set('scope', s); }
          await c.signedIn(user, scopeOf);
          c.queue.kick();   // (same account after a sign-out: its queue was kept, so open() didn't start it again)
          await c.stopPublic();   // (1.3.0: listened again under the account)
          c.startWatches(); tell();
        }),
        ctx.on('signout', async () => { const last = c.scope() || store.get('scope') || ''; c.close(); await countStored(last); }),
        ctx.on('switch', async () => { owed = await reloadOwed(await wipe(false)); }),
        // (the public watches start again at once after forget(), at the sign-in after a switch)
        ctx.on('forget', async ({ force }) => { if (await reloadOwed(await wipe(!!force))) setTimeout(reload, 0); else c.startWatches(); }),
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
