// The outbox registry: every app on one origin names its outbox here. The apps on one origin share sign-in, so
// signing out in one signs out all of them; with the registry, the sign-out check (queue.flush) also waits for the
// other apps' unsent saves for this user, and forgetting the device (queue.forget) forgets this user in all of them.
// Opt-in: an app that doesn't register its outbox, or whose queue has no registry, is not looked at and works as before.
//
// createOutboxRegistry({ storage, open, key, timeout }) -> { register, unregister, list, unsent, forget }
//   storage: where the list is kept (localStorage: every page of the origin reads it). open(name, realm): an outbox
//   by name (createOutbox). timeout: ms an outbox may take to answer before it counts as unsent.
//   register(outbox | { name, realm }): idempotent; call it at start-up. list() -> [{ name, realm }].
//   unsent(owner, { except }) -> true while any registered outbox (except this one: the queue checks its own) has
//   saves for owner that are not sent; an outbox that can't be read or doesn't answer counts as unsent.
//   forget(owner, { except }): this owner's entries in every registered outbox; throws after trying all if any failed.
import { createOutbox } from './outbox.js';

export const REGISTRY_KEY = 'app-sync:outboxes';
export const REGISTRY_TIMEOUT = 3000;
/**
 * @typedef {import('./types.js').OutboxId} OutboxId
 * @typedef {import('./types.js').Registry} Registry
 */

const done = new Set(['synced', 'archived']);   // the write queue's finished states (writes.js); a refused save set aside (refused: true, 0.8.2) is not given up
/** @param {OutboxId} x */
const idOf = x => ({ name: x.name, realm: x.realm || 'default' });
/** @param {OutboxId} a @param {OutboxId} b */
const same = (a, b) => a.name === b.name && (a.realm || 'default') === (b.realm || 'default');

/**
 * @param {{ storage?: Pick<Storage, 'getItem' | 'setItem'>, open?: (name: string, realm?: string) => import('./types.js').Outbox, key?: string, timeout?: number }} [options]
 * @returns {Registry}
 */
export function createOutboxRegistry({ storage = globalThis.localStorage, open = (name, realm) => createOutbox({ name, realm }), key = REGISTRY_KEY, timeout = REGISTRY_TIMEOUT } = {}) {
  /** @returns {OutboxId[]} */
  const read = () => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const all = JSON.parse(raw);
    return Array.isArray(all) ? all.filter(x => x && typeof x.name === 'string').map(idOf) : [];
  };
  /** @type {Map<string, import('./types.js').Outbox>} */
  const opened = new Map();
  /** @param {OutboxId} x */
  const outbox = x => { const id = x.name + '\n' + x.realm; if (!opened.has(id)) opened.set(id, open(x.name, x.realm)); return /** @type {import('./types.js').Outbox} */ (opened.get(id)); };
  /** @param {OutboxId | null | undefined} except */
  const others = except => read().filter(x => !(except && except.name && same(x, except)));
  /** @param {Promise<any>} p */
  const within = p => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('An outbox did not answer in time')), timeout); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  return {
    list: read,
    /** @param {OutboxId} x */
    register(x) {
      if (!x || !x.name) throw new Error('register needs an outbox name');
      const all = read();
      if (!all.some(y => same(y, x))) storage.setItem(key, JSON.stringify([...all, idOf(x)]));
    },
    /** @param {OutboxId} x */
    unregister(x) { storage.setItem(key, JSON.stringify(read().filter(y => !same(y, x)))); },
    /** @param {string} owner @param {{ except?: OutboxId | null }} [options] */
    async unsent(owner, { except = null } = {}) {
      /** @type {OutboxId[]} */
      let list;
      try { list = others(except); } catch { return true; }   // the list can't be read: not known to be empty
      /** @param {OutboxId} x */
      /** @param {OutboxId} x */
      const one = async x => { try { return (await within(Promise.resolve().then(() => outbox(x).list(owner)))).some(/** @param {{ state: string, refused?: boolean }} e */ e => !done.has(e.state) || !!e.refused); } catch { return true; } };
      return (await Promise.all(list.map(one))).some(Boolean);
    },
    /** @param {string} owner @param {{ except?: OutboxId | null }} [options] */
    async forget(owner, { except = null } = {}) {
      /** @type {string[]} */
      const failed = [];
      for (const x of others(except)) { try { await within(Promise.resolve().then(() => outbox(x).forget(owner))); } catch (e) { failed.push(x.name + ': ' + (e && e.message)); } }
      if (failed.length) throw new Error('Some local copies could not be removed (' + failed.join('; ') + '). Close other tabs of these apps and clear the site storage before sharing the device.');
    },
  };
}
