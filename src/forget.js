// Sign-out on a shared device, in one order: stop every listener, check again that signing out should go ahead
// (another tab may have signed in meanwhile), delete this device's copies except the account kept, the outbox, the
// SDK's own offline cache, then the app's own lists. Call it after the sign-out check (queue.flush()) said yes.
//
// forgetDevice({ hub, stores, queue, proceed, keep, clearBackendCache, extra, timeout })
//   hub: createSyncHub (stopAll). stores: createStores (wipeStores). queue: createWriteQueue (forget). proceed:
//   async () -> false to stop here (nothing deleted). keep: scopes whose stores stay (an array, or a function called
//   after proceed; e.g. the account signed in now in another tab). clearBackendCache: e.g. the adapter's clearCache
//   (the app reloads afterwards); it counts as failed after timeout ms (default 3000: clearing waits while another
//   tab uses the cache), so extra still runs. extra: async (), the app's own (lists in localStorage, caches, reload).
//   A queue with an outbox registry forgets this user in every registered outbox (registry.js).
// -> { wiped, failed }: wiped false when proceed said no (nothing deleted, but the hub stays stopped: the app watches
// again); failed names the steps that threw (the others still ran).
export const FORGET_TIMEOUT = 3000;
/** @param {number} ms @param {() => any} fn */
const within = (ms, fn) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => { const e = /** @type {import('./types.js').CodedError} */ (new Error('Did not finish in time')); e.code = 'deadline-exceeded'; reject(e); }, ms); });
  return Promise.race([Promise.resolve().then(fn), late]).finally(() => clearTimeout(timer));
};
/**
 * @typedef {object} ForgetOptions
 * @property {{ stopAll: () => Promise<void> }} [hub]
 * @property {{ wipeStores: (keep?: string[]) => Promise<void> }} [stores]
 * @property {{ forget: () => Promise<void> }} [queue]
 * @property {() => Promise<boolean | void>} [proceed]
 * @property {string[] | (() => string[] | Promise<string[]>)} [keep]
 * @property {(() => Promise<any>) | null} [clearBackendCache]
 * @property {(() => Promise<any>) | null} [extra]
 * @property {number} [timeout]
 */
/**
 * @param {ForgetOptions} [options]
 * @returns {Promise<{ wiped: boolean, failed: string[] }>}
 */
export async function forgetDevice({ hub, stores, queue, proceed = async () => true, keep = [], clearBackendCache = null, extra = null, timeout = FORGET_TIMEOUT } = {}) {
  /** @type {string[]} */
  const failed = [];
  /** @param {string} name @param {() => any} fn */
  const step = async (name, fn) => { try { await fn(); } catch (e) { failed.push(name); console.warn('forgetDevice: ' + name, e); } };
  if (hub) await step('stopAll', () => hub.stopAll());
  if ((await proceed()) === false) return { wiped: false, failed };
  if (stores) await step('wipeStores', async () => stores.wipeStores(typeof keep === 'function' ? await keep() : keep));
  if (queue) await step('forget', () => queue.forget());
  if (clearBackendCache) await step('clearBackendCache', () => within(timeout, clearBackendCache));
  if (extra) await step('extra', () => extra());
  return { wiped: true, failed };
}
