// Sign-out on a shared device, in one order: stop every listener, check again that signing out should go ahead
// (another tab may have signed in meanwhile), delete this device's copies except the account kept, the outbox, the
// SDK's own offline cache, then the app's own lists. Call it after the sign-out check (queue.flush()) said yes.
//
// forgetDevice({ hub, stores, queue, proceed, keep, clearBackendCache, extra })
//   hub: createSyncHub (stopAll). stores: createStores (wipeStores). queue: createWriteQueue (forget). proceed:
//   async () -> false to stop here (nothing deleted). keep: scopes whose stores stay (an array, or a function called
//   after proceed; e.g. the account signed in now in another tab). clearBackendCache: e.g. the adapter's clearCache
//   (the app reloads afterwards). extra: async (), the app's own (lists in localStorage, caches).
// -> { wiped, failed }: wiped false when proceed said no (nothing deleted, but the hub stays stopped: the app watches
// again); failed names the steps that threw (the others still ran).
export async function forgetDevice({ hub, stores, queue, proceed = async () => true, keep = [], clearBackendCache = null, extra = null } = {}) {
  const failed = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name); console.warn('forgetDevice: ' + name, e); } };
  if (hub) await step('stopAll', () => hub.stopAll());
  if ((await proceed()) === false) return { wiped: false, failed };
  if (stores) await step('wipeStores', async () => stores.wipeStores(typeof keep === 'function' ? await keep() : keep));
  if (queue) await step('forget', () => queue.forget());
  if (clearBackendCache) await step('clearBackendCache', () => clearBackendCache());
  if (extra) await step('extra', () => extra());
  return { wiped: true, failed };
}
